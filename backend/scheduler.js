// Фоновый импорт данных из Wildberries.
// Кабинеты обрабатываются параллельно, потому что у каждого свой токен и
// свой rate limit на стороне WB. Внутри одного кабинета запросы идут
// последовательно с большими паузами.

const { importCabSales, syncCab } = require('./wb');

let isRunning = false;
let lastResult = null;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtDate(d) {
  return d.toISOString().split('T')[0];
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return fmtDate(d);
}

function today() {
  return fmtDate(new Date());
}

async function getSetting(pool, key, defaultValue) {
  const { rows } = await pool.query('SELECT value FROM app_settings WHERE key=$1', [key]);
  return rows[0]?.value ?? defaultValue;
}

async function setSetting(pool, key, value) {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );
}

// Выполнить задачи параллельно, но не более concurrency одновременно.
async function asyncPool(concurrency, items, fn) {
  const results = new Array(items.length);
  const iterator = items.entries();
  const workers = Array(Math.min(concurrency, items.length))
    .fill(iterator)
    .map(async (it, workerIndex) => {
      for (const [index, item] of it) {
        results[index] = await fn(item, index, workerIndex);
      }
    });
  await Promise.all(workers);
  return results;
}

// Импорт одного кабинета за набор периодов.
async function importOneCab(pool, cab, ranges, adsOpts) {
  const cabResult = { cabId: cab.id, name: cab.name, ranges: [], error: null };
  try {
    // Обновляем commission / buyout / last_synced_at
    await syncCab(pool, cab);
    await delay(3000);

    for (const range of ranges) {
      console.log(`WB scheduler: кабинет ${cab.id} (${cab.name}) → ${range.label} (${range.from}..${range.to})`);
      try {
        const r = await importCabSales(pool, cab, range.from, range.to, { ads: adsOpts });
        cabResult.ranges.push({
          ...range,
          imported: r.imported ?? 0,
          runId: r.runId,
          status: r.status,
          issues: r.issues,
          previousDataPreserved: r.previousDataPreserved,
        });
      } catch (e) {
        console.error(`WB scheduler: ошибка периода ${range.label} в кабинете ${cab.id}:`, e.message);
        cabResult.ranges.push({ ...range, error: e.message });
      }
      // Пауза между периодами, чтобы не давить на API
      await delay(60000);
    }
  } catch (e) {
    console.error(`WB scheduler: ошибка в кабинете ${cab.id}:`, e.message);
    cabResult.error = e.message;
  }
  return cabResult;
}

// Один проход фонового импорта.
// Сначала подтягиваем вчера (быстро, основной режим работы),
// затем последние 7 дней (догоняем, если что-то пропустилось),
// затем последние 30 дней (раз в сутки, глубокая догонка).
async function runImport(pool, opts = {}) {
  if (isRunning) {
    console.log('WB scheduler: предыдущий проход ещё выполняется, пропускаем');
    return { skipped: true, reason: 'already_running' };
  }
  isRunning = true;
  const startedAt = new Date().toISOString();
  console.log('WB scheduler: старт фонового импорта в', startedAt);

  let error = null;

  try {
    const { rows: cabs } = await pool.query(
      `SELECT * FROM cabs WHERE wb_token IS NOT NULL AND wb_token <> '' ORDER BY id`
    );

    const deepBackfillEnabled = opts.deepBackfill !== false;
    const lastDeepRun = await getSetting(pool, 'scheduler_last_deep_run', '');
    const doDeepBackfill = deepBackfillEnabled && (
      !lastDeepRun || (new Date() - new Date(lastDeepRun)) > 24 * 60 * 60 * 1000
    );

    const ranges = [
      { label: 'вчера', from: daysAgo(1), to: today() },
      { label: '7 дней', from: daysAgo(7), to: today() },
    ];
    if (doDeepBackfill) {
      ranges.push({ label: '30 дней', from: daysAgo(30), to: today() });
    }

    // WB Advert API позволяет до 50 id на запрос, но имеет глобальный лимитер.
    // concurrency=1 + pause 30s между чанками + cooldown 90s дают ~1 запрос/90с.
    // Пустые ответы больше не ретраим, поэтому 50 кампаний за раз безопасно.
    const adsOpts = { chunkSize: 50, chunkPauseMs: 30000 };
    const concurrency = cabs.length; // все кабинеты параллельно (у каждого свой токен WB)

    console.log(`WB scheduler: ${cabs.length} кабинет(ов), параллельность ${concurrency}`);

    const results = await asyncPool(concurrency, cabs, (cab) => importOneCab(pool, cab, ranges, adsOpts));

    await setSetting(pool, 'scheduler_last_run', startedAt);
    if (doDeepBackfill) {
      await setSetting(pool, 'scheduler_last_deep_run', startedAt);
    }

    lastResult = { startedAt, finishedAt: new Date().toISOString(), cabs: cabs.length, results };
    console.log('WB scheduler: фоновый импорт завершён');
    return lastResult;
  } catch (e) {
    error = e.message;
    console.error('WB scheduler: критическая ошибка:', e.message);
    lastResult = { startedAt, error: e.message };
    return lastResult;
  } finally {
    isRunning = false;
  }
}

function getStatus() {
  return {
    running: isRunning,
    lastResult,
  };
}

function start(pool, intervalMinutes = 360) {
  console.log(`WB scheduler: запуск, интервал ${intervalMinutes} мин`);
  // Первый запуск через небольшую задержку, чтобы сервер успел подняться.
  setTimeout(() => runImport(pool).catch(e => console.error('WB scheduler init error:', e.message)), 10_000);
  setInterval(() => runImport(pool).catch(e => console.error('WB scheduler interval error:', e.message)), intervalMinutes * 60 * 1000);
}

module.exports = { start, runImport, getStatus };
