// ── Интеграция с официальным API Wildberries ─────────────────────────────────
// Здесь не используется сторонний HTTP-клиент: Node.js 20+ предоставляет global fetch.

const COMMON_API = 'https://common-api.wildberries.ru';
const STAT_API   = 'https://statistics-api.wildberries.ru';
const ADVERT_API = 'https://advert-api.wildberries.ru';
const {
  CATALOG_TEMPLATE_NAMES,
  inferCatalogTemplate,
  normalizeProductText,
  isAccessoryArticle,
} = require('./catalogTemplates');
const { rebuildAdShareManagerSales, loadAdvertCampaignAssignments } = require('./managerAssignments');
const { toDateKey } = require('./dateUtils');
const { prepareFinancialRows, rowDate, validateImportCandidate } = require('./wbImportValidation');
const { startImportRun, finishImportRun, loadPreviousDays, recordImportDays } = require('./wbImportJournal');

function getCabToken(cab) {
  // 1) Токен из карточки кабинета (хранится в БД)
  if (cab?.wb_token) return cab.wb_token;

  // 2) Fallback: токен из переменной окружения WB_TOKENS
  try {
    const raw = process.env.WB_TOKENS || '[]';
    const list = JSON.parse(raw);
    const id = cab?.wb_store_id || String(cab?.id);
    const entry = Array.isArray(list)
      ? list.find(x => String(x.id) === id || String(x.store_id) === id)
      : list[id];
    return entry?.token || entry || null;
  } catch (e) {
    console.error('WB_TOKENS parse error:', e.message);
    return null;
  }
}

const delay = ms => new Promise(r => setTimeout(r, ms));

// Кулдаун между запросами к Advert API для одного токена.
// WB Advert API имеет «глобальный лимитер на продавца»: квоту может есть
// любой сервис с этим токеном, поэтому ждём минимум 90 секунд между
// полноценными запросами fullstats.
const advertLastRequest = new Map(); // token fingerprint -> timestamp
const ADVERT_MIN_INTERVAL_MS = 90_000;

function tokenFingerprint(token) {
  return token ? token.slice(-32) : 'none';
}

async function advertCooldown(token) {
  const key = tokenFingerprint(token);
  const last = advertLastRequest.get(key) || 0;
  const now = Date.now();
  const wait = Math.max(0, last + ADVERT_MIN_INTERVAL_MS - now);
  if (wait > 0) {
    console.log(`WB advert cooldown for seller ${key.slice(0, 8)}: wait ${wait}ms`);
    await delay(wait);
  }
  advertLastRequest.set(key, Date.now());
}

// Уважаем Retry-After и делаем более длинные паузы для 429.
async function fetchWithRetry(url, options, { retries = 3, initialDelayMs = 1500 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, options);
    if (res.ok) return res;

    // 429 / 5xx — повторяем с backoff, остальные ошибки сразу бросаем
    const text = await res.text().catch(() => '');
    lastError = new Error(`WB ${url} ${res.status}: ${text.slice(0, 200)}`);
    if (res.status !== 429 && res.status < 500) throw lastError;
    if (attempt < retries) {
      let wait = initialDelayMs * (2 ** attempt);
      const retryAfter = res.headers.get('retry-after');
      if (retryAfter) {
        const ra = parseInt(retryAfter, 10);
        if (!isNaN(ra) && ra > 0) wait = Math.max(wait, ra * 1000);
      }
      // Для 429 делаем минимум 10 секунд, чтобы не давить на глобальный лимитер.
      if (res.status === 429) wait = Math.max(wait, 10000);
      console.log(`WB retry ${attempt + 1}/${retries} for ${url} after ${wait}ms (status ${res.status})`);
      await delay(wait);
    }
  }
  throw lastError;
}

async function wbGet(base, path, token) {
  const res = await fetchWithRetry(`${base}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
    },
  });
  return res.json();
}

async function fetchRate() {
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/RUB');
    const data = await r.json();
    return data.rates?.KZT || 6.0;
  } catch (e) {
    console.error('fetchRate error:', e.message);
    return 6.0;
  }
}

// Стоимость логистики в рублях на основе объёма коробки (литры)
function logRub(w, d, h) {
  if (!w || !d || !h) return null;
  const v = (w * d * h) / 1000;
  if (v <= 0.2) return v * 23;
  if (v <= 0.4) return v * 26;
  if (v <= 0.6) return v * 29;
  if (v <= 0.8) return v * 30;
  if (v <= 1.0) return v * 32;
  return 46 + (v - 1) * 14;
}

async function loadCatalogTemplates(pool) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (name) name, cost, comm, w, d, h
     FROM catalog
     WHERE name = ANY($1)
     ORDER BY name, id`,
    [CATALOG_TEMPLATE_NAMES]
  );
  return new Map(rows.map(row => [row.name, row]));
}

function coalescePositive(current, fallback) {
  const value = Number(current) || 0;
  return value > 0 ? value : (Number(fallback) || 0);
}

function shouldReplaceImportedName(currentName, article) {
  return !currentName || normalizeProductText(currentName) === normalizeProductText(article);
}

// Найти товар в каталоге по артикулу, отрезая суффиксы менеджеров.
// Логика повторяет SQL-функцию catalog_match: точное совпадение,
// отрезание по _ и пробелу, затем самое длинное prefix-совпадение.
function findCatalogProduct(article, catalogByArticle) {
  if (!article) return null;
  const a = String(article).trim().toLowerCase();
  if (!a) return null;

  const exact = catalogByArticle[a];
  if (exact && (!isAccessoryArticle(a) || !exact.source || exact.source === 'manual')) return exact;
  if (isAccessoryArticle(a)) return null;

  const tryStrip = (delim) => {
    const parts = a.split(delim);
    while (parts.length > 1) {
      parts.pop();
      const base = parts.join(delim);
      if (base && catalogByArticle[base]) return catalogByArticle[base];
    }
    return null;
  };

  const byUnderscore = tryStrip('_');
  if (byUnderscore) return byUnderscore;

  const bySpace = tryStrip(' ');
  if (bySpace) return bySpace;

  return null;
}

const isFinancialDocumentRow = row => ['продажа', 'возврат']
  .includes(String(row?.doc_type_name || '').trim().toLowerCase());

async function buildCatalogCandidate(pool, sourceRows = []) {
  const [{ rows }, templates] = await Promise.all([
    pool.query(
      `SELECT id, name, cost, comm, w, d, h, article, subject, source
       FROM catalog
       WHERE article IS NOT NULL`
    ),
    loadCatalogTemplates(pool),
  ]);
  const catalogByArticle = {};
  for (const product of rows) {
    catalogByArticle[String(product.article).trim().toLowerCase()] = product;
  }

  const seen = new Set();
  const upserts = [];
  for (const row of sourceRows) {
    const article = String(row.sa_name || row.supplier_article || row.supplierArticle || '').trim();
    const key = article.toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const current = catalogByArticle[key];
    const canEnrichCurrent = current?.source === 'inferred'
      || (current?.source === 'wb' && shouldReplaceImportedName(current.name, article));
    if (current && !canEnrichCurrent) continue;
    if (isAccessoryArticle(article)) continue;
    const subject = String(row.subject_name || row.subject || '').trim();
    const match = inferCatalogTemplate(article, subject);
    const template = match ? templates.get(match.templateName) : null;
    if (!template) continue;

    const product = {
      ...current,
      name: current && !shouldReplaceImportedName(current.name, article) ? current.name : match.displayName,
      article,
      subject: current?.subject || subject,
      cost: coalescePositive(current?.cost, template.cost),
      comm: coalescePositive(current?.comm, template.comm),
      w: coalescePositive(current?.w, template.w),
      d: coalescePositive(current?.d, template.d),
      h: coalescePositive(current?.h, template.h),
      source: 'inferred',
    };

    const upsert = {
      name: product.name,
      article: product.article,
      subject: product.subject,
      cost: product.cost,
      comm: product.comm,
      w: product.w,
      d: product.d,
      h: product.h,
      source: product.source,
    };
    upserts.push(upsert);
    catalogByArticle[key] = product;
  }
  return { catalogByArticle, upserts };
}

async function persistCatalogCandidate(client, upserts) {
  for (const product of upserts) {
    await client.query(
      `INSERT INTO catalog (name, article, subject, cost, comm, w, d, h, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (article) WHERE article IS NOT NULL DO UPDATE SET
         name = EXCLUDED.name,
         subject = EXCLUDED.subject,
         cost = EXCLUDED.cost,
         comm = EXCLUDED.comm,
         w = EXCLUDED.w,
         d = EXCLUDED.d,
         h = EXCLUDED.h,
         source = EXCLUDED.source,
         updated_at = NOW()
       WHERE catalog.source IS DISTINCT FROM 'manual'`,
      [
        product.name,
        product.article,
        product.subject,
        product.cost,
        product.comm,
        product.w,
        product.d,
        product.h,
        product.source,
      ]
    );
  }
}

// Средняя комиссия WB по родительским категориям (kgvpMarketplace)
async function fetchCommission(token) {
  const data = await wbGet(COMMON_API, '/api/v1/tariffs/commission?locale=ru', token);
  const report = Array.isArray(data?.report) ? data.report : [];
  if (!report.length) return null;
  const values = report
    .map(r => parseFloat(r.kgvpMarketplace))
    .filter(v => !isNaN(v) && v >= 0);
  if (!values.length) return null;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return +avg.toFixed(2);
}

// Приближённый % выкупа: (заказы без отмены) / (все заказы) за последние N дней.
async function fetchBuyout(token, days) {
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const dateFrom = from.toISOString();

  const orders = await fetchAllPages(`${STAT_API}/api/v1/supplier/orders`, token, dateFrom);
  const total = orders.length;
  const canceled = orders.filter(o => o.isCancel === true || o.isCancel === 'true').length;
  if (!total) return null;
  return +(((total - canceled) / total) * 100).toFixed(2);
}

// Пагинация по lastChangeDate (flag=0)
async function fetchAllPages(urlBase, token, dateFrom) {
  const all = [];
  let cursor = dateFrom;
  const maxPages = 20;
  for (let i = 0; i < maxPages; i++) {
    const data = await wbGet('', `${urlBase}?dateFrom=${encodeURIComponent(cursor)}&flag=0`, token);
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < 70000) break;
    const last = rows[rows.length - 1];
    cursor = last.lastChangeDate || cursor;
  }
  return all;
}

async function fetchSupplierSales(token, dateFrom) {
  const from = new Date(`${dateFrom}T00:00:00Z`).toISOString();
  return fetchAllPages(`${STAT_API}/api/v1/supplier/sales`, token, from);
}

async function fetchSupplierOrders(token, dateFrom) {
  const from = new Date(`${dateFrom}T00:00:00Z`).toISOString();
  return fetchAllPages(`${STAT_API}/api/v1/supplier/orders`, token, from);
}

function buildOrderStats(orders, exRate, isKZT) {
  const byDate = {};
  for (const order of orders) {
    const date = String(order.date || '').split('T')[0];
    if (!date) continue;
    if (!byDate[date]) byDate[date] = { ordered_qty: 0, ordered_amount: 0, cancelled_qty: 0, cancelled_amount: 0 };
    const priceKzt = isKZT ? (parseFloat(order.priceWithDisc) || parseFloat(order.finishedPrice) || parseFloat(order.totalPrice) || 0)
      : (parseFloat(order.priceWithDisc) || parseFloat(order.finishedPrice) || parseFloat(order.totalPrice) || 0) * exRate;
    if (order.isCancel === true || order.isCancel === 'true') {
      byDate[date].cancelled_qty += 1;
      byDate[date].cancelled_amount += +priceKzt.toFixed(2);
    } else {
      byDate[date].ordered_qty += 1;
      byDate[date].ordered_amount += +priceKzt.toFixed(2);
    }
  }
  return byDate;
}

async function persistOrderStats(client, cabId, orderStats) {
  for (const [date, stats] of Object.entries(orderStats)) {
    await client.query(
      `INSERT INTO wb_order_stats (cab_id, date, ordered_qty, ordered_amount, cancelled_qty, cancelled_amount)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (cab_id, date) DO UPDATE SET
         ordered_qty=EXCLUDED.ordered_qty, ordered_amount=EXCLUDED.ordered_amount,
         cancelled_qty=EXCLUDED.cancelled_qty, cancelled_amount=EXCLUDED.cancelled_amount`,
      [cabId, date, stats.ordered_qty, +stats.ordered_amount.toFixed(2),
       stats.cancelled_qty, +stats.cancelled_amount.toFixed(2)]
    );
  }
}

async function fetchFinanceReports(token, dateFrom, dateTo) {
  const allReports = [];
  let rrdid = 0;
  while (true) {
    const res = await fetchWithRetry('https://finance-api.wildberries.ru/api/finance/v1/sales-reports/list', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ dateFrom, dateTo, limit: 1000, rrdid }),
    }, { retries: 2, initialDelayMs: 5000 });
    const data = await res.json();
    const reports = Array.isArray(data) ? data : [];
    if (!reports.length) break;
    allReports.push(...reports);
    if (reports.length < 1000) break;
    rrdid = reports[reports.length - 1]?.reportId || 0;
    if (rrdid <= 0) break;
    await delay(2000);
  }
  return allReports;
}

async function persistFinanceReports(client, cabId, reports) {
  for (const report of reports) {
    await client.query(
      `INSERT INTO wb_finance_reports (cab_id, report_id, date_from, date_to, create_date, report_type,
         retail_amount, for_pay, delivery_service, paid_storage, paid_acceptance,
         deduction, penalty, additional_payment, commission_amount, acquiring_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (cab_id, report_id) DO UPDATE SET
         retail_amount=EXCLUDED.retail_amount, for_pay=EXCLUDED.for_pay,
         delivery_service=EXCLUDED.delivery_service, paid_storage=EXCLUDED.paid_storage,
         paid_acceptance=EXCLUDED.paid_acceptance, deduction=EXCLUDED.deduction,
         penalty=EXCLUDED.penalty, additional_payment=EXCLUDED.additional_payment,
         commission_amount=EXCLUDED.commission_amount, acquiring_amount=EXCLUDED.acquiring_amount,
         updated_at=NOW()`,
      [
        cabId,
        report.reportId,
        report.dateFrom, report.dateTo, report.createDate, report.reportType || 1,
        +parseFloat(report.retailAmountSum || 0).toFixed(2),
        +parseFloat(report.forPaySum || 0).toFixed(2),
        +parseFloat(report.deliveryServiceSum || 0).toFixed(2),
        +parseFloat(report.paidStorageSum || 0).toFixed(2),
        +parseFloat(report.paidAcceptanceSum || 0).toFixed(2),
        +parseFloat(report.deductionSum || 0).toFixed(2),
        +parseFloat(report.penaltySum || 0).toFixed(2),
        +parseFloat(report.additionalPaymentSum || 0).toFixed(2),
        +parseFloat(report.commissionAmountSum || 0).toFixed(2),
        +parseFloat(report.acquiringAmountSum || 0).toFixed(2),
      ]
    );
  }
}

async function applyFinanceExpenses(client, cabId) {
  // Корректирует дневную выручку на основе retail_amount из Finance API.
  // Добавляет логистику в log_f, хранение/приёмку/штрафы вычитает из profit.
  // Deduction уже учтён через deduction_pct в buildCabSalesCandidate.
  const { rows: raw } = await client.query(
    `SELECT date_from, date_to,
            retail_amount, delivery_service, paid_storage, paid_acceptance, penalty
     FROM wb_finance_reports WHERE cab_id=$1
     ORDER BY date_from`, [cabId]);

  // Aggregate multiple reports for same period (type=1 + type=2 for По выкупам)
  const grouped = new Map();
  for (const r of raw) {
    const k = r.date_from.toISOString().slice(0,10) + '|' + r.date_to.toISOString().slice(0,10);
    if (!grouped.has(k)) grouped.set(k, { date_from: r.date_from, date_to: r.date_to, retail:0, dlv:0, sto:0, acc:0, pen:0 });
    const g = grouped.get(k);
    g.retail += parseFloat(r.retail_amount) || 0;
    g.dlv += parseFloat(r.delivery_service) || 0;
    g.sto += parseFloat(r.paid_storage) || 0;
    g.acc += parseFloat(r.paid_acceptance) || 0;
    g.pen += parseFloat(r.penalty) || 0;
  }
  const reports = [...grouped.values()];

  for (const report of reports) {
    const { rows: days } = await client.query(
      `SELECT date, rev FROM wb_sales
       WHERE cab_id=$1 AND date BETWEEN $2 AND $3 AND rev > 0
       ORDER BY date`,
      [cabId, report.date_from, report.date_to]
    );

    if (!days.length) continue;
    const totalRev = days.reduce((s, d) => s + parseFloat(d.rev), 0);
    if (totalRev <= 0) continue;

    for (const day of days) {
      const share = parseFloat(day.rev) / totalRev;
      const newRev = +(report.retail * share).toFixed(2);
      const dlvShare = +((report.dlv * share).toFixed(2));
      const stoShare = +((report.sto * share).toFixed(2));
      const accShare = +((report.acc * share).toFixed(2));
      const penShare = +((report.pen * share).toFixed(2));

      await client.query(
        `UPDATE wb_sales SET
           rev = $3,
           comm = ROUND(comm * $3 / NULLIF(rev, 0), 2),
           cab_comm = ROUND(cab_comm * $3 / NULLIF(rev, 0), 2),
           ret = ROUND(ret * $3 / NULLIF(rev, 0), 2),
           log_f = $4,
           profit = ROUND(
             $3 * (1 - COALESCE(ret, 0) / NULLIF(rev, 0))
             - cost - ads
             - comm * $3 / NULLIF(rev, 0)
             - cab_comm * $3 / NULLIF(rev, 0)
             - $4 - COALESCE(log_r, 0) - $5
           , 2)
         WHERE cab_id=$1 AND date=$2`,
        [cabId, day.date, newRev, dlvShare, stoShare + accShare + penShare]
      );
    }
  }
}

// Отчёт о продажах по реализации за период (WB Statistics API v5)
// Пагинация через rrdid: каждый ответ содержит до limit строк; следующий запрос
// должен передать rrdid последней строки предыдущего ответа.
async function fetchReportDetailByPeriod(token, dateFrom, dateTo) {
  const allRows = [];
  const limit = 100000;
  let rrdid = 0;
  let page = 0;
  while (true) {
    const url = `${STAT_API}/api/v5/supplier/reportDetailByPeriod?dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}&rrdid=${rrdid}&limit=${limit}`;
    const res = await fetchWithRetry(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    });
    const text = await res.text();
    if (!text || !text.trim()) break;
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error('fetchReportDetailByPeriod parse error:', e.message, text.slice(0, 200));
      break;
    }
    const rows = Array.isArray(data) ? data : [];
    if (!rows.length) break;
    allRows.push(...rows);
    page++;
    if (rows.length < limit) break;
    const lastRrdId = rows[rows.length - 1]?.rrd_id;
    if (lastRrdId === undefined || lastRrdId === null || Number(lastRrdId) <= rrdid) break;
    rrdid = Number(lastRrdId);
    // Пауза между страницами для уважения rate limit WB
    await delay(500);
  }
  if (page > 1) console.log(`WB reportDetailByPeriod: fetched ${allRows.length} rows across ${page} pages`);
  return allRows;
}

// Фейковые строки отчёта WB для демонстрации (без реального API)
function generateDemoRows(cab, days = 7) {
  const rows = [];
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i - 1);
    const dateStr = d.toISOString().split('T')[0];
    // Два условных артикула
    rows.push({
      sa_name: 'Шурик красный',
      supplier_article: 'Шурик красный',
      sale_dt: `${dateStr}T12:00:00`,
      order_dt: `${dateStr}T10:00:00`,
      retail_amount: Math.round(45000 + Math.random() * 15000),
      quantity: Math.round(2 + Math.random() * 4),
    });
    rows.push({
      sa_name: 'Лазер красный',
      supplier_article: 'Лазер красный',
      sale_dt: `${dateStr}T14:00:00`,
      order_dt: `${dateStr}T11:00:00`,
      retail_amount: Math.round(80000 + Math.random() * 25000),
      quantity: Math.round(1 + Math.random() * 3),
    });
  }
  return rows;
}

async function seedDemoSales(pool, cab, days = 7) {
  const rows = generateDemoRows(cab, days);
  return importCabSalesFromRows(pool, cab, rows);
}

// Синхронизация одного кабинета (commission / buyout)
async function syncCab(pool, cab) {
  const token = getCabToken(cab);
  if (!token) {
    console.log(`WB sync: токен не задан для кабинета ${cab.id} (${cab.name})`);
    return null;
  }

  const { rows: settingRows } = await pool.query(`SELECT value FROM app_settings WHERE key='buyout_days'`);
  const buyoutDays = parseInt(settingRows[0]?.value || '30', 10) || 30;

  const [commission, buyout] = await Promise.allSettled([
    fetchCommission(token),
    fetchBuyout(token, buyoutDays),
  ]);

  const next = {
    commission: commission.status === 'fulfilled' ? commission.value : cab.commission,
    buyout: buyout.status === 'fulfilled' ? Math.round(buyout.value) : cab.buyout,
    last_synced_at: new Date().toISOString(),
  };

  await pool.query(
    `UPDATE cabs SET commission=COALESCE($1, commission), buyout=COALESCE($2, buyout), last_synced_at=$3 WHERE id=$4`,
    [next.commission, next.buyout, next.last_synced_at, cab.id]
  );

  if (commission.status === 'rejected') console.error(`WB commission error cab ${cab.id}:`, commission.reason.message);
  if (buyout.status === 'rejected') console.error(`WB buyout error cab ${cab.id}:`, buyout.reason.message);

  return next;
}

function findUserForArticle(article, users) {
  const text = String(article);
  for (const u of users) {
    try {
      for (const re of u.regexes) {
        if (re.test(text)) return u;
      }
    } catch (e) {
      // игнорируем испорченный regex
    }
  }
  return null;
}

function roundMoney(value) {
  const number = Number(value);
  return Number.isFinite(number) ? +(number.toFixed(2)) : 0;
}

function utcYesterdayKey(now = Date) {
  const current = typeof now === 'function' ? new now() : new Date(now);
  if (!Number.isFinite(current.getTime())) throw new TypeError('now must be a valid date');
  current.setUTCHours(0, 0, 0, 0);
  current.setUTCDate(current.getUTCDate() - 1);
  return current.toISOString().slice(0, 10);
}

function acceptedImportStatus(dates, now = Date) {
  const cutoff = utcYesterdayKey(now);
  return (Array.isArray(dates) ? dates : []).some(date => String(date) >= cutoff)
    ? 'provisional'
    : 'verified';
}

function allocateCents(total, entries) {
  const result = new Map(entries.map(entry => [entry.key, 0]));
  if (total <= 0 || !entries.length) return result;
  const weighted = entries.map(entry => ({ ...entry, weight: Math.max(Number(entry.weight) || 0, 0) }));
  const weightTotal = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  if (weightTotal <= 0) {
    const per = Math.floor(total / entries.length);
    let remainder = total - per * entries.length;
    for (let i = 0; i < entries.length; i++) {
      result.set(entries[i].key, per + (i < remainder ? 1 : 0));
    }
    return result;
  }
  const fractions = [];
  let allocated = 0;
  for (const entry of weighted) {
    const raw = total * entry.weight / weightTotal;
    const cents = Math.floor(raw);
    result.set(entry.key, cents);
    allocated += cents;
    fractions.push({ key: entry.key, fraction: raw - cents });
  }
  fractions.sort((left, right) => right.fraction - left.fraction || String(left.key).localeCompare(String(right.key)));
  for (let index = 0; index < Math.max(0, total - allocated); index++) {
    const key = fractions[index % fractions.length].key;
    result.set(key, result.get(key) + 1);
  }
  return result;
}

function resolveBuildOption(value, ...args) {
  return Promise.resolve(typeof value === 'function' ? value(...args) : value);
}

function safeCatalogMatch(article, product) {
  return {
    article,
    source: product.source || 'manual',
    cost: Number(product.cost) || 0,
    comm: Number(product.comm) || 0,
    w: Number(product.w) || 0,
    d: Number(product.d) || 0,
    h: Number(product.h) || 0,
  };
}

function candidateCounts(candidate) {
  return {
    days: candidate.days.length,
    managerDays: candidate.managerDays.length,
    details: candidate.details.length,
    catalogMatches: candidate.catalogMatches.length,
    catalogUpserts: candidate.catalogUpserts.length,
    unknownArticles: candidate.unknownArticles.length,
    catalogChanges: candidate.catalogChanges.length,
    advertRows: Array.isArray(candidate.advertCandidate?.rows) ? candidate.advertCandidate.rows.length : 0,
  };
}

async function buildCabSalesCandidate(pool, cab, rows, adsByDate, directAdsByManagerDate, options = {}) {
  const financialRows = (Array.isArray(rows) ? rows : []).filter(isFinancialDocumentRow);
  const catalogCandidate = await resolveBuildOption(
    Object.hasOwn(options, 'catalogCandidate') ? options.catalogCandidate : buildCatalogCandidate(pool, financialRows),
    pool,
    financialRows
  );
  let userRows;
  if (Object.hasOwn(options, 'users')) {
    userRows = await resolveBuildOption(options.users, pool);
  } else {
    const result = await pool.query(`SELECT id, pattern FROM users WHERE pattern IS NOT NULL AND pattern <> '' ORDER BY id`);
    userRows = result.rows;
  }
  const users = advertUsers(userRows);

  const exRateValue = Object.hasOwn(options, 'exRate')
    ? await resolveBuildOption(options.exRate)
    : await fetchRate();
  const exRate = Number.isFinite(Number(exRateValue)) ? Number(exRateValue) : 6;
  const buyout = Math.max(parseFloat(cab.buyout) || 88, 0.01) / 100;
  const isIU = cab.cab_type === 'iu';
  const currency = String(financialRows[0]?.currency_name || 'RUB').toUpperCase();
  const isKZT = currency === 'KZT';
  const catalogByArticle = catalogCandidate?.catalogByArticle || {};
  const byDate = new Map();
  const catalogMatches = new Map();
  const unknownArticles = new Set();

  for (const row of financialRows) {
    const docType = String(row.doc_type_name || '').trim().toLowerCase();
    const direction = docType === 'продажа' ? 1 : docType === 'возврат' ? -1 : 0;
    const date = String(rowDate(row) || '').split('T')[0];
    if (!direction || !validDateKey(date)) continue;
    if (!byDate.has(date)) {
      byDate.set(date, { qty: 0, rev: 0, cost: 0, comm: 0, logF: 0, logR: 0, groups: new Map() });
    }
    const day = byDate.get(date);
    const qty = (parseInt(row.quantity, 10) || 0) * direction;
    const rawRev = parseFloat(row.retail_amount) || 0;
    const rev = (isKZT ? rawRev : rawRev * exRate) * direction;
    const article = String(row.sa_name || row.supplier_article || row.supplierArticle || '').trim().toLowerCase();
    const product = findCatalogProduct(article, catalogByArticle);
    const commissionPct = Number(product ? product.comm : row.commission_percent) || 0;
    const cost = product && qty !== 0 ? qty * (Number(product.cost) || 0) : 0;
    const comm = commissionPct > 0 ? rev * commissionPct / 100 : 0;
    let logF = 0;
    let logR = 0;
    if (product && !isIU && qty > 0 && currency === 'RUB') {
      const logisticsRub = logRub(product.w, product.d, product.h);
      if (logisticsRub !== null) {
        const logisticsKzt = isKZT ? logisticsRub * exRate : logisticsRub;
        logF = qty * logisticsKzt / buyout;
        logR = qty * ((1 - buyout) / buyout) * 50;
      }
    }
    if (product) {
      if (!catalogMatches.has(article)) catalogMatches.set(article, safeCatalogMatch(article, product));
    } else {
      unknownArticles.add(article);
    }

    day.qty += qty;
    day.rev += rev;
    day.cost += cost;
    day.comm += comm;
    day.logF += logF;
    day.logR += logR;

    const user = findUserForArticle(article, users);
    const groupKey = user ? `user:${String(user.id)}` : 'unassigned';
    if (!day.groups.has(groupKey)) {
      day.groups.set(groupKey, {
        key: groupKey,
        userId: user?.id ?? null,
        qty: 0,
        rev: 0,
        cost: 0,
        comm: 0,
        logF: 0,
        logR: 0,
        items: new Map(),
      });
    }
    const group = day.groups.get(groupKey);
    group.qty += qty;
    group.rev += rev;
    group.cost += cost;
    group.comm += comm;
    group.logF += logF;
    group.logR += logR;
    if (!group.items.has(article)) {
      group.items.set(article, { article, subject: row.subject_name || null, qty: 0, rev: 0, cost: 0, comm: 0 });
    }
    const item = group.items.get(article);
    item.qty += qty;
    item.rev += rev;
    item.cost += cost;
    item.comm += comm;
  }

  // Логистика, хранение и штрафы из ВСЕХ строк (включая служебные без doc_type)
  // WB отдаёт dlv_prc/rebill_logistic_cost/storage_fee/penalty в спаренных строках
  for (const row of rows) {
    const date = String(rowDate(row) || '').split('T')[0];
    if (!validDateKey(date)) continue;
    if (!byDate.has(date)) continue;
    const day = byDate.get(date);
    const wbLog = parseFloat(row.dlv_prc) || 0;
    const wbStorage = parseFloat(row.storage_fee) || 0;
    const wbPenalty = parseFloat(row.penalty) || 0;
    if (Math.abs(wbLog) > 0.001) day.logF += wbLog;
    if (Math.abs(wbStorage) > 0.001) day.storage = (day.storage || 0) + wbStorage;
    if (Math.abs(wbPenalty) > 0.001) day.penalty = (day.penalty || 0) + wbPenalty;
  }

  for (const [rawDate, rawAds] of Object.entries(adsByDate || {})) {
    const date = validDateKey(rawDate);
    const ads = roundMoney(rawAds);
    if (!date || ads === 0 || byDate.has(date)) continue;
    byDate.set(date, { qty: 0, rev: 0, cost: 0, comm: 0, logF: 0, logR: 0, groups: new Map() });
  }

  const days = [];
  const managerDays = [];
  const details = [];
  const adsOnlyDates = [];
  for (const [date, day] of [...byDate].sort(([left], [right]) => left.localeCompare(right))) {
    const groups = [...day.groups.values()].sort((left, right) => left.key.localeCompare(right.key));
    const dayDetails = [];
    for (const group of groups) {
      group.detailRows = [...group.items.values()]
        .sort((left, right) => left.article.localeCompare(right.article))
        .map(item => ({
          date,
          userId: group.userId,
          article: item.article,
          subject: item.subject,
          qty: roundMoney(item.qty),
          rev: roundMoney(item.rev),
          cost: roundMoney(item.cost),
          comm: roundMoney(item.comm),
          ads: 0,
          profit: 0,
        }));
      dayDetails.push(...group.detailRows);
    }

    const adsCents = Math.max(Math.round(roundMoney(adsByDate?.[date]) * 100), 0);
    if (dayDetails.length) {
      const directMap = directAdsByManagerDate?.[date] || {};
      const directEntries = groups
        .filter(group => group.userId !== null)
        .map(group => ({ key: group.key, weight: Math.max(roundMoney(directMap[group.userId]), 0) * 100 }))
        .filter(entry => entry.weight > 0);
      const directTotal = directEntries.reduce((sum, entry) => sum + Math.round(entry.weight), 0);
      const groupAds = directTotal > adsCents
        ? allocateCents(adsCents, directEntries)
        : new Map(directEntries.map(entry => [entry.key, Math.round(entry.weight)]));
      const allocatedDirect = [...groupAds.values()].reduce((sum, value) => sum + value, 0);
      const remaining = allocateCents(adsCents - allocatedDirect, groups.map(group => ({ key: group.key, weight: group.rev })));
      for (const group of groups) {
        const groupCents = (groupAds.get(group.key) || 0) + (remaining.get(group.key) || 0);
        const itemAds = allocateCents(groupCents, group.detailRows.map(detail => ({ key: detail.article, weight: detail.rev })));
        for (const detail of group.detailRows) detail.ads = (itemAds.get(detail.article) || 0) / 100;
      }

      for (const metric of ['qty', 'rev', 'cost', 'comm']) {
        const target = roundMoney(day[metric]);
        const total = roundMoney(dayDetails.reduce((sum, detail) => sum + detail[metric], 0));
        dayDetails.at(-1)[metric] = roundMoney(dayDetails.at(-1)[metric] + target - total);
      }
      for (const detail of dayDetails) {
        detail.profit = roundMoney(detail.rev * buyout - detail.cost - detail.ads - detail.comm);
      }
      details.push(...dayDetails);
    } else if (adsCents > 0) {
      adsOnlyDates.push(date);
    }

    const qty = roundMoney(day.qty);
    const rev = roundMoney(day.rev);
    const ads = adsCents / 100;
    const cost = roundMoney(day.cost);
    const comm = roundMoney(day.comm);
    const cabComm = isIU ? roundMoney(rev * 0.05) : 0;
    const logF = roundMoney(day.logF);
    const logR = roundMoney(day.logR);
    const ret = roundMoney(rev * (1 - buyout));
    const netRev = rev * buyout;
    const deductionPct = Number(options.deductionPct) || 0;
    const deduction = roundMoney(netRev * deductionPct / 100);
    const profit = roundMoney(netRev - cost - ads - comm - cabComm - logF - logR - deduction - (day.storage || 0) - (day.penalty || 0));
    days.push({
      date, qty, rev, ads, cost, comm, cabComm, logF, logR, ret, profit,
      margin: netRev > 0 ? roundMoney(profit / netRev * 100) : 0,
      drr: netRev > 0 ? roundMoney(ads / netRev * 100) : 0,
    });

    for (const group of groups.filter(item => item.userId !== null)) {
      const groupDetails = group.detailRows;
      const sum = metric => roundMoney(groupDetails.reduce((total, detail) => total + detail[metric], 0));
      const managerRev = sum('rev');
      const managerAds = sum('ads');
      const managerCost = sum('cost');
      const managerComm = sum('comm');
      const managerCabComm = isIU ? roundMoney(managerRev * 0.05) : 0;
      const managerLogF = roundMoney(group.logF);
      const managerLogR = roundMoney(group.logR);
      const managerNetRev = managerRev * buyout;
      const managerProfit = roundMoney(
        managerNetRev - managerCost - managerAds - managerComm - managerCabComm - managerLogF - managerLogR
      );
      managerDays.push({
        date,
        userId: group.userId,
        qty: sum('qty'),
        rev: managerRev,
        ads: managerAds,
        cost: managerCost,
        comm: managerComm,
        cabComm: managerCabComm,
        logF: managerLogF,
        logR: managerLogR,
        ret: roundMoney(managerRev * (1 - buyout)),
        profit: managerProfit,
        margin: managerNetRev > 0 ? roundMoney(managerProfit / managerNetRev * 100) : 0,
        drr: managerNetRev > 0 ? roundMoney(managerAds / managerNetRev * 100) : 0,
      });
    }
  }

  const dates = days.map(day => day.date);
  const totals = Object.fromEntries(
    ['qty', 'rev', 'ads', 'cost', 'comm', 'cabComm', 'logF', 'logR', 'ret', 'profit']
      .map(metric => [metric, roundMoney(days.reduce((sum, day) => sum + day[metric], 0))])
  );
  const catalogUpserts = Array.isArray(catalogCandidate?.upserts) ? catalogCandidate.upserts : [];
  const advertCandidate = options.advertCandidate || {
    rows: [], replaceCampaignIds: [], requestedCampaigns: 0, returnedCampaigns: 0, issues: [],
  };
  const sourceMetrics = options.sourceMetrics || {
    rows: financialRows.length,
    acceptedRows: financialRows.length,
    dates,
  };
  const candidate = {
    status: acceptedImportStatus(dates, options.now || Date),
    buyout,
    days,
    managerDays,
    details,
    catalogMatches: [...catalogMatches.values()],
    catalogUpserts,
    advertCandidate,
    issues: [
      ...(Array.isArray(options.sourceIssues) ? options.sourceIssues : []),
      ...(Array.isArray(advertCandidate.issues) ? advertCandidate.issues : []),
    ],
    sourceMetrics,
    candidateMetrics: {
      rows: details.length,
      acceptedRows: financialRows.length,
      dates,
      byDate: Object.fromEntries(days.map(day => [day.date, { ...day }])),
      totals,
      requestedCampaigns: Number(advertCandidate.requestedCampaigns) || 0,
      returnedCampaigns: Number(advertCandidate.returnedCampaigns) || 0,
    },
    unknownArticles: [...unknownArticles].filter(Boolean).sort(),
    catalogChanges: catalogUpserts.map(product => ({
      article: product.article,
      source: product.source,
      cost: Number(product.cost) || 0,
      comm: Number(product.comm) || 0,
      w: Number(product.w) || 0,
      d: Number(product.d) || 0,
      h: Number(product.h) || 0,
    })),
    previousDays: Array.isArray(options.previousDays) ? options.previousDays : [],
    deductionPct: Number(options.deductionPct) || 0,
  };
  if (adsOnlyDates.length) candidate.adsOnlyDates = adsOnlyDates;
  Object.defineProperty(candidate, 'salesSource', {
    value: options.source === 'wb_operational' ? 'wb_operational' : 'wb',
    enumerable: false,
  });
  return candidate;
}

function prepareCabSalesCandidate({ candidate, previousDays, ignoreHistoricalDelta } = {}) {
  const validation = validateImportCandidate({ candidate, previousDays, ignoreHistoricalDelta });
  const issues = [...(Array.isArray(candidate?.issues) ? candidate.issues : []), ...validation.issues];
  const dates = (Array.isArray(candidate?.days) ? candidate.days : []).map(day => day.date).sort();
  if (!validation.ok || issues.some(item => item?.severity === 'critical')) {
    return {
      imported: 0,
      dates,
      status: 'blocked',
      previousDataPreserved: true,
      issues,
      candidate,
    };
  }
  return {
    imported: dates.length,
    dates,
    status: candidate.status,
    previousDataPreserved: false,
    issues,
    candidate,
  };
}

async function loadCandidateControlTotals(db, cabId, dates) {
  const sortedDates = [...new Set(dates)].sort();
  if (!sortedDates.length) return [];
  const loaded = await loadPreviousDays(db, cabId, sortedDates[0], sortedDates.at(-1));
  const byDate = new Map(loaded.map(day => [day.date, day]));
  return sortedDates.map(date => {
    const day = byDate.get(date);
    return {
      date,
      qty: Number(day?.qty) || 0,
      rev: Number(day?.rev) || 0,
      cost: Number(day?.cost) || 0,
    };
  });
}

function sameControlTotals(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function applyCabSalesCandidate(pool, cab, candidate, { dateFrom, dateTo, runId } = {}) {
  const dates = candidate.days.map(day => day.date).sort();
  const expectedSnapshot = dates.map(date => {
    const previous = (Array.isArray(candidate.previousDays) ? candidate.previousDays : [])
      .find(day => day.date === date);
    return {
      date,
      qty: Number(previous?.qty) || 0,
      rev: Number(previous?.rev) || 0,
      cost: Number(previous?.cost) || 0,
    };
  });
  const effectiveFrom = dateFrom || dates[0] || candidate.advertCandidate?.rows?.[0]?.date;
  const effectiveTo = dateTo || dates.at(-1) || candidate.advertCandidate?.rows?.at(-1)?.date;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [cab.id]);
    const lockedSnapshot = await loadCandidateControlTotals(client, cab.id, dates);
    if (!sameControlTotals(expectedSnapshot, lockedSnapshot)) {
      const error = new Error('IMPORT_CONCURRENT_CHANGE');
      error.code = 'IMPORT_CONCURRENT_CHANGE';
      throw error;
    }

    await persistCatalogCandidate(client, candidate.catalogUpserts);
    if (effectiveFrom && effectiveTo) {
      await persistAdvertCandidate(client, cab.id, effectiveFrom, effectiveTo, candidate.advertCandidate);
    }
    if (dates.length) {
      await client.query(
        `DELETE FROM wb_manager_sales_detail WHERE cab_id=$1 AND date = ANY($2::date[])`,
        [cab.id, dates]
      );
      await client.query(
        `DELETE FROM wb_manager_sales WHERE cab_id=$1 AND date = ANY($2::date[])`,
        [cab.id, dates]
      );
    }
    for (const day of candidate.days) {
      await client.query(
        `INSERT INTO wb_sales
         (cab_id, date, rev, ads, cost, comm, cab_comm, log_f, log_r, ret, profit, margin, drr, source, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
         ON CONFLICT (cab_id, date) DO UPDATE SET
           rev=EXCLUDED.rev, ads=EXCLUDED.ads, cost=EXCLUDED.cost, comm=EXCLUDED.comm,
           cab_comm=EXCLUDED.cab_comm, log_f=EXCLUDED.log_f, log_r=EXCLUDED.log_r,
           ret=EXCLUDED.ret, profit=EXCLUDED.profit, margin=EXCLUDED.margin,
           drr=EXCLUDED.drr, source=EXCLUDED.source, updated_at=NOW()`,
        [
          cab.id, day.date, day.rev, day.ads, day.cost, day.comm, day.cabComm,
          day.logF, day.logR, day.ret, day.profit, day.margin, day.drr,
          candidate.salesSource || 'wb',
        ]
      );
    }
    for (const day of candidate.managerDays) {
      await client.query(
        `INSERT INTO wb_manager_sales
         (cab_id, user_id, date, rev, ads, cost, comm, cab_comm, log_f, log_r, ret, profit, margin, drr, source, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'article',NOW())
         ON CONFLICT (cab_id, user_id, date) DO UPDATE SET
           rev=EXCLUDED.rev, ads=EXCLUDED.ads, cost=EXCLUDED.cost, comm=EXCLUDED.comm,
           cab_comm=EXCLUDED.cab_comm, log_f=EXCLUDED.log_f, log_r=EXCLUDED.log_r,
           ret=EXCLUDED.ret, profit=EXCLUDED.profit, margin=EXCLUDED.margin,
           drr=EXCLUDED.drr, source='article', updated_at=NOW()`,
        [
          cab.id, day.userId, day.date, day.rev, day.ads, day.cost, day.comm,
          day.cabComm, day.logF, day.logR, day.ret, day.profit, day.margin, day.drr,
        ]
      );
    }
    for (const detail of candidate.details) {
      await client.query(
        `INSERT INTO wb_manager_sales_detail
         (cab_id, user_id, date, article, subject, qty, rev, cost, comm, ads, profit, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())`,
        [
          cab.id, detail.userId, detail.date, detail.article, detail.subject,
          detail.qty, detail.rev, detail.cost, detail.comm, detail.ads, detail.profit,
        ]
      );
    }

    const result = {
      status: candidate.status,
      imported: dates.length,
      dates,
      users: new Set(candidate.managerDays.map(day => String(day.userId))).size,
      issues: candidate.issues,
      previousDataPreserved: false,
      fetchedRows: Number(candidate.sourceMetrics?.rows) || 0,
      acceptedRows: Number(candidate.sourceMetrics?.acceptedRows) || 0,
      rejectedRows: Number(candidate.sourceMetrics?.rejectedRows) || 0,
      sourceMetrics: candidate.sourceMetrics,
      candidateMetrics: candidate.candidateMetrics,
      counts: candidateCounts(candidate),
    };
    if (candidate.orderStats && Object.keys(candidate.orderStats).length > 0) {
      await persistOrderStats(client, cab.id, candidate.orderStats);
    }
    if (Array.isArray(candidate.financeReports) && candidate.financeReports.length > 0) {
      await persistFinanceReports(client, cab.id, candidate.financeReports);
    }
    if (runId !== undefined && runId !== null) {
      await finishImportRun(client, runId, result);
      await recordImportDays(client, {
        cabId: cab.id,
        runId,
        dates,
        status: result.status,
        issues: result.issues,
      });
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Совместимый вход для строк отчёта: все записи готовятся и проверяются до connect().
async function importCabSalesFromRows(pool, cab, rows, adsByDate = {}, directAdsByManagerDate = {}, options = {}) {
  const sourceDates = (Array.isArray(rows) ? rows : [])
    .map(row => validDateKey(String(rowDate(row) || '').split('T')[0]))
    .filter(Boolean);
  const advertDates = Object.entries(adsByDate || {})
    .filter(([, value]) => Number.isFinite(Number(value)) && roundMoney(value) !== 0)
    .map(([date]) => validDateKey(date))
    .filter(Boolean);
  const inferredDates = [...new Set([...sourceDates, ...advertDates])].sort();
  const dateFrom = options.dateFrom || inferredDates[0];
  const dateTo = options.dateTo || inferredDates.at(-1);
  const preparedRows = prepareFinancialRows({ rows, dateFrom, dateTo });
  const sourceIssues = [
    ...preparedRows.issues,
    ...(Array.isArray(options.sourceIssues) ? options.sourceIssues : []),
  ];
  const candidate = await buildCabSalesCandidate(
    pool,
    cab,
    preparedRows.acceptedRows,
    adsByDate,
    directAdsByManagerDate,
    {
      ...options,
      sourceIssues,
      sourceMetrics: {
        rows: preparedRows.fetchedRows,
        acceptedRows: preparedRows.acceptedRows.length,
        rejectedRows: preparedRows.rejectedRows,
        dates: inferredDates,
      },
    }
  );
  const dates = candidate.days.map(day => day.date);
  candidate.previousDays = Object.hasOwn(options, 'controlSnapshot')
    ? options.controlSnapshot
    : await loadCandidateControlTotals(pool, cab.id, dates);
  const cutoff = utcYesterdayKey(options.now || Date);
  const closedDates = new Set(dates.filter(date => date < cutoff));
  const previousDays = candidate.previousDays.filter(day => closedDates.has(day.date));
  const prepared = prepareCabSalesCandidate({ candidate, previousDays, ignoreHistoricalDelta: options.ignoreHistoricalDelta });
  if (prepared.status === 'blocked') {
    const { candidate: _candidate, ...blocked } = prepared;
    return {
      ...blocked,
      users: 0,
      sourceMetrics: candidate.sourceMetrics,
      candidateMetrics: candidate.candidateMetrics,
      counts: candidateCounts(candidate),
    };
  }
  candidate.issues = prepared.issues;
  if (!dates.length) {
    return {
      status: prepared.status,
      imported: 0,
      dates: [],
      users: 0,
      issues: prepared.issues,
      previousDataPreserved: false,
      sourceMetrics: candidate.sourceMetrics,
      candidateMetrics: candidate.candidateMetrics,
      counts: candidateCounts(candidate),
      message: 'Нет продаж и рекламных расходов за период',
    };
  }
  return applyCabSalesCandidate(pool, cab, candidate, { dateFrom, dateTo, runId: options.runId });
}

// Оставлен как alias для обратной совместимости с тестами
async function importCabOperationalSales(pool, cab, dateFrom, dateTo, adsByDate, directAdsByManagerDate) {
  const { rows } = await fetchCabOperationalRows(pool, cab, dateFrom, dateTo, adsByDate, directAdsByManagerDate);
  if (!rows.length) return { imported: 0, dates: [], users: 0 };
  return importCabSalesFromRows(
    pool,
    cab,
    rows,
    adsByDate,
    directAdsByManagerDate,
    { source: 'wb_operational' }
  );
}

async function runValidatedAttempts({ maxAttempts, delayFn, attemptFn } = {}) {
  let lastResult = null;
  const allIssues = [];
  let attempts = 0;

  for (let i = 0; i < maxAttempts; i++) {
    if (attempts > 0 && delayFn) await delayFn(attempts);
    attempts++;
    try {
      lastResult = await attemptFn(attempts);
    } catch (e) {
      lastResult = {
        status: 'blocked',
        issues: [{ code: 'fetch_error', severity: 'critical', message: e.message }],
        networkError: true,
      };
    }

    if (Array.isArray(lastResult?.issues)) allIssues.push(...lastResult.issues);
    if (lastResult.status !== 'blocked') break;
    if (lastResult.networkError) continue;
  }

  return {
    ...(lastResult ?? {}),
    status: lastResult?.status ?? 'blocked',
    issues: allIssues,
    attempts,
  };
}

function failedImportResult(error) {
  return {
    status: 'failed',
    issues: [{ code: 'system_error', severity: 'critical', message: error.message }],
  };
}

// Импорт продаж из WB reportDetailByPeriod в wb_sales
async function importCabSales(pool, cab, dateFrom, dateTo, opts = {}) {
  const token = getCabToken(cab);
  if (!token) {
    throw new Error(`Токен не задан для кабинета ${cab.id} (${cab.name})`);
  }

  const { id: runId } = await startImportRun(pool, { cabId: cab.id, dateFrom, dateTo });
  let adsResult = null;

  const deductionPct = opts.deductionPct !== undefined
    ? Number(opts.deductionPct)
    : Number(((await pool.query("SELECT value FROM app_settings WHERE key='deduction_pct'")).rows[0]?.value) || 0);

  const attemptResult = await runValidatedAttempts({
    maxAttempts: opts.maxAttempts !== undefined ? opts.maxAttempts : 3,
    delayFn: opts.delayFn || delay,
    attemptFn: async (attempt) => {
      let rows;
      try {
        const financeSales = await fetchSupplierSales(token, dateFrom);
        const rateResult = await fetchRate();

        rows = financeSales
          .filter(s => {
            const d = String(s.date || '').split('T')[0];
            return d >= dateFrom && d <= dateTo;
          })
          .map(s => {
            const isReturn = String(s.saleID || '').toUpperCase().startsWith('R');
            const priceRub = parseFloat(s.priceWithDisc) || parseFloat(s.finishedPrice) || parseFloat(s.totalPrice) || 0;
            return {
              sale_dt: s.date,
              doc_type_name: isReturn ? 'Возврат' : 'Продажа',
              quantity: 1,
              retail_amount: +(priceRub * rateResult).toFixed(2),
              currency_name: 'KZT',
              sa_name: s.supplierArticle,
              subject_name: s.subject,
              commission_percent: cab.commission,
            };
          });
      } catch (e) {
        console.error(`WB finance fetch cab ${cab.id} attempt ${attempt} error:`, e.message);
        throw e;
      }

      const isKZT = true;

      let advertCandidate = {
        rows: [], replaceCampaignIds: [], requestedCampaigns: 0, returnedCampaigns: 0, issues: [],
      };
      let projectedAds = { byDate: {}, byManagerDate: {} };

      if (!opts.skipAds) {
        try {
          const preparedAds = await importCabAds(pool, cab, dateFrom, dateTo, isKZT, {
            ...(opts.ads || {}),
            candidateOnly: true,
          });
          advertCandidate = preparedAds.candidate;
          const { candidate: _candidate, ...publicAdsResult } = preparedAds;
          adsResult = publicAdsResult;
        } catch (e) {
          console.error(`WB ads import cab ${cab.id} attempt ${attempt} error:`, e.message);
        }

        await delay(1000);

        const { rows: existingAdvertRows } = await pool.query(
          `SELECT campaign_id, date, user_id, sum
           FROM wb_advert_stats
           WHERE cab_id=$1 AND date BETWEEN $2 AND $3`,
          [cab.id, dateFrom, dateTo]
        );
        projectedAds = projectAdvertTotals({ existingRows: existingAdvertRows, candidate: advertCandidate });
      }

      const preparedRows = prepareFinancialRows({ rows, dateFrom, dateTo });
      const sourceIssues = [
        ...preparedRows.issues,
        ...(Array.isArray(opts.sourceIssues) ? opts.sourceIssues : []),
        ...(Array.isArray(advertCandidate.issues) ? advertCandidate.issues : []),
      ];

      const candidate = await buildCabSalesCandidate(
        pool,
        cab,
        preparedRows.acceptedRows,
        projectedAds.byDate,
        projectedAds.byManagerDate,
        {
          dateFrom,
          dateTo,
          advertCandidate,
          sourceIssues,
          deductionPct,
          sourceMetrics: {
            rows: preparedRows.fetchedRows,
            acceptedRows: preparedRows.acceptedRows.length,
            rejectedRows: preparedRows.rejectedRows,
            dates: candidateDatesFromRows(preparedRows.acceptedRows, projectedAds.byDate),
          },
          ...(Object.hasOwn(opts, 'exRate') ? { exRate: opts.exRate } : {}),
        }
      );

      const dates = candidate.days.map(day => day.date);
      candidate.previousDays = Object.hasOwn(opts, 'controlSnapshot')
        ? opts.controlSnapshot
        : await loadCandidateControlTotals(pool, cab.id, dates);

      const cutoff = utcYesterdayKey(opts.now || Date);
      const closedDates = new Set(dates.filter(date => date < cutoff));
      const previousDays = candidate.previousDays.filter(day => closedDates.has(day.date));
      const prepared = prepareCabSalesCandidate({ candidate, previousDays, ignoreHistoricalDelta: opts.ignoreHistoricalDelta });

      return {
        status: prepared.status,
        issues: prepared.issues,
        candidate: prepared.status !== 'blocked' ? prepared.candidate : null,
        prepared,
        dates,
        fetchedRows: preparedRows.fetchedRows,
        acceptedRows: preparedRows.acceptedRows.length,
        rejectedRows: preparedRows.rejectedRows,
        projectedAds,
      };
    },
  });

  const dates = attemptResult.dates || [];
  const fetchedRows = attemptResult.fetchedRows || 0;
  const acceptedRows = attemptResult.acceptedRows || 0;
  const rejectedRows = attemptResult.rejectedRows || 0;

  if (attemptResult.status === 'blocked') {
    const blockedResult = {
      status: 'blocked',
      imported: 0,
      dates,
      users: 0,
      issues: attemptResult.issues,
      previousDataPreserved: true,
      fetchedRows,
      acceptedRows,
      rejectedRows,
      attempts: attemptResult.attempts,
      runId,
    };
    await finishImportRun(pool, runId, {
      status: 'blocked',
      dates,
      issues: attemptResult.issues,
      attempts: attemptResult.attempts,
      fetchedRows,
      acceptedRows,
      rejectedRows,
    });
    await recordImportDays(pool, {
      cabId: cab.id,
      runId,
      dates,
      status: 'blocked',
      issues: attemptResult.issues,
    });
    return blockedResult;
  }

  const financialCandidate = attemptResult.candidate;
  if (!financialCandidate) {
    throw new Error('IMPORT_INTERNAL_ERROR: no candidate after non-blocked result');
  }

  let operationalRows = [];
  let operationalIssues = [];
  try {
    const operational = await fetchCabOperationalRows(
      pool,
      cab,
      dateFrom,
      dateTo,
      attemptResult.projectedAds ? attemptResult.projectedAds.byDate : {},
      attemptResult.projectedAds ? attemptResult.projectedAds.byManagerDate : {}
    );
    operationalRows = operational.rows;
    operationalIssues = operational.issues;
  } catch (e) {
    console.error(`WB operational sales import cab ${cab.id}:`, e.message);
    operationalIssues = [{ code: 'operational_fetch_error', severity: 'warning', message: e.message }];
  }

  if (operationalRows.length > 0) {
    const financialDates = new Set(financialCandidate.days.map(day => day.date));
    const newOperationalRows = operationalRows.filter(row => {
      const date = String(row.sale_dt || '').split('T')[0];
      return !financialDates.has(date);
    });

    if (newOperationalRows.length > 0) {
      const opPrep = prepareFinancialRows({ rows: newOperationalRows, dateFrom, dateTo });
      const combinedRows = [...(opPrep.acceptedRows || []), ...operationalRows.filter(r => r._alreadyFinancial)];

      if (combinedRows.length > 0) {
        const combinedCandidate = await buildCabSalesCandidate(
          pool,
          cab,
          combinedRows,
          {},
          {},
          { source: 'wb_operational' }
        );

        const financialByDate = new Map(financialCandidate.days.map(day => [day.date, day]));
        const financialDetailDates = new Set(financialCandidate.details.map(d => d.date));

        for (const day of combinedCandidate.days) {
          if (!financialByDate.has(day.date)) {
            financialCandidate.days.push(day);
          }
        }
        for (const detail of combinedCandidate.details) {
          if (!financialDetailDates.has(detail.date)) {
            financialCandidate.details.push(detail);
          }
        }
        for (const managerDay of combinedCandidate.managerDays) {
          const existing = financialCandidate.managerDays.find(
            m => m.date === managerDay.date && m.userId === managerDay.userId
          );
          if (!existing) {
            financialCandidate.managerDays.push(managerDay);
          }
        }
        for (const issue of (combinedCandidate.issues || [])) {
          if (!financialCandidate.issues.some(i => i.code === issue.code
            && i.severity === issue.severity && i.message === issue.message)) {
            financialCandidate.issues.push(issue);
          }
        }
      }
    }
  }

  financialCandidate.issues = [
    ...financialCandidate.issues,
    ...operationalIssues,
  ];

  try {
    financialCandidate.sourceMetrics = {
      rows: fetchedRows,
      acceptedRows,
      rejectedRows,
      dates: financialCandidate.days.map(day => day.date),
    };
    financialCandidate.candidateMetrics.dates = financialCandidate.days.map(day => day.date);

    // Загружаем статистику заказов из supplier/orders для полной воронки
    if (!opts.skipOrders) {
      try {
        const token = getCabToken(cab);
        const exRate = await fetchRate();
        const currency = String(financialCandidate.days[0]?.currency || cab.currency || 'RUB').toUpperCase();
        const orders = await fetchSupplierOrders(token, dateFrom);
        const julyOrders = orders.filter(o => {
          const d = String(o.date || '').split('T')[0];
          return d >= dateFrom && d <= dateTo;
        });
        financialCandidate.orderStats = buildOrderStats(julyOrders, exRate, currency === 'KZT');
      } catch (e) {
        console.error(`WB orders fetch cab ${cab.id}:`, e.message);
      }
    }

    // Загружаем финансовые отчёты из Finance API
    if (!opts.skipFinance) {
      try {
        const token = getCabToken(cab);
        const finReports = await fetchFinanceReports(token, dateFrom, dateTo);
        financialCandidate.financeReports = finReports;
      } catch (e) {
        console.error(`WB finance fetch cab ${cab.id}:`, e.message);
      }
    }

    const applied = await applyCabSalesCandidate(pool, cab, financialCandidate, {
      dateFrom,
      dateTo,
      runId,
    });

    await rebuildAdShareManagerSales(pool, { cabId: cab.id, dateFrom, dateTo });

    return {
      ...applied,
      runId,
      attempts: attemptResult.attempts,
      fetchedRows,
      acceptedRows,
      rejectedRows,
      ads: adsResult,
      operational: { imported: operationalRows.length > 0 ? operationalRows.length : 0, dates: [] },
    };
  } catch (e) {
    console.error(`WB import apply error cab ${cab.id}:`, e.message);
    const failedResult = failedImportResult(e);
    await finishImportRun(pool, runId, {
      status: 'failed',
      dates: [],
      fetchedRows,
      issues: failedResult.issues,
      attempts: attemptResult.attempts,
    });
    await recordImportDays(pool, {
      cabId: cab.id,
      runId,
      dates: [],
      status: 'failed',
      issues: failedResult.issues,
    });
    throw e;
  }
}

function candidateDatesFromRows(rows, adsByDate) {
  const sourceDates = (Array.isArray(rows) ? rows : [])
    .map(row => validDateKey(String(rowDate(row) || '').split('T')[0]))
    .filter(Boolean);
  const advertDates = Object.entries(adsByDate || {})
    .filter(([, value]) => Number.isFinite(Number(value)) && roundMoney(value) !== 0)
    .map(([date]) => validDateKey(date))
    .filter(Boolean);
  return [...new Set([...sourceDates, ...advertDates])].sort();
}

async function fetchCabOperationalRows(pool, cab, dateFrom, dateTo, adsByDate, directAdsByManagerDate) {
  const token = getCabToken(cab);
  if (!adsByDate) {
    const { rows } = await pool.query(
      `SELECT date, SUM(sum) AS ads
       FROM wb_advert_stats
       WHERE cab_id=$1 AND date BETWEEN $2 AND $3
       GROUP BY date`,
      [cab.id, dateFrom, dateTo]
    );
    adsByDate = Object.fromEntries(rows.map(row => [toDateKey(row.date), +row.ads]));
  }
  if (!directAdsByManagerDate) {
    const { rows } = await pool.query(
      `SELECT date, user_id, SUM(sum) AS ads
       FROM wb_advert_stats
       WHERE cab_id=$1 AND user_id IS NOT NULL AND date BETWEEN $2 AND $3
       GROUP BY date, user_id`,
      [cab.id, dateFrom, dateTo]
    );
    directAdsByManagerDate = {};
    for (const row of rows) {
      const date = toDateKey(row.date);
      if (!directAdsByManagerDate[date]) directAdsByManagerDate[date] = {};
      directAdsByManagerDate[date][row.user_id] = +row.ads;
    }
  }

  let sales;
  try {
    sales = await fetchSupplierSales(token, dateFrom);
  } catch (e) {
    return { rows: [], issues: [{ code: 'operational_fetch_error', severity: 'warning', message: e.message }] };
  }

  const [rateResult, financialResult] = await Promise.all([
    fetchRate(),
    pool.query(
      `SELECT date
       FROM wb_sales
       WHERE cab_id=$1 AND date BETWEEN $2 AND $3 AND source='wb'
         AND (rev <> 0 OR cost <> 0 OR comm <> 0)`,
      [cab.id, dateFrom, dateTo]
    ),
  ]);
  const financialDates = new Set(financialResult.rows.map(row => toDateKey(row.date)));

  const rows = sales
    .filter(sale => {
      const date = String(sale.date || '').split('T')[0];
      return date >= dateFrom && date <= dateTo && !financialDates.has(date);
    })
    .map(sale => {
      const isReturn = String(sale.saleID || '').toUpperCase().startsWith('R');
      const priceRub = parseFloat(sale.priceWithDisc) || parseFloat(sale.finishedPrice) || parseFloat(sale.totalPrice) || 0;
      return {
        sale_dt: sale.date,
        doc_type_name: isReturn ? 'Возврат' : 'Продажа',
        quantity: 1,
        retail_amount: priceRub * rateResult,
        currency_name: 'KZT',
        sa_name: sale.supplierArticle,
        subject_name: sale.subject,
        commission_percent: cab.commission,
      };
    });

  return { rows, issues: [] };
}

// ── Wildberries Adverts API ──────────────────────────────────────────────────

// Список рекламных кампаний продавца
// Swagger: GET /api/advert/v2/adverts (https://advert-api.wildberries.ru)
async function fetchAdverts(token) {
  const res = await fetchWithRetry(`${ADVERT_API}/api/advert/v2/adverts`, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });
  return res.json();
}

// Статистика по кампаниям за период (WB Adverts API v3)
// GET /adv/v3/fullstats?ids=1,2,3&beginDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// Повторяем запрос ТОЛЬКО если получили 429 от WB Advert API.
// Если WB вернул 200 с пустым/частичным ответом — считаем, что по этим кампаниям
// нет статистики за период, и не тратим время на бесполезные ретраи.
async function fetchAdvertStats(token, ids, dateFrom, dateTo) {
  if (!Array.isArray(ids) || !ids.length) return [];
  const requestedIds = new Set(ids);
  const requested = new Set(ids);
  const result = [];
  const maxAttempts = 5;
  const baseDelayMs = 30000;
  for (let attempt = 0; attempt < maxAttempts && requested.size > 0; attempt++) {
    if (attempt > 0) {
      const wait = baseDelayMs * (2 ** (attempt - 1));
      console.log(`WB fullstats retry ${attempt}/${maxAttempts - 1} for ${requested.size} campaigns after ${wait}ms (429)`);
      await delay(wait);
    }
    // Ждём кулдаун между запросами к Advert API для этого продавца.
    await advertCooldown(token);
    const idsParam = Array.from(requested).join(',');
    let res;
    try {
      res = await fetchWithRetry(`${ADVERT_API}/adv/v3/fullstats?ids=${idsParam}&beginDate=${dateFrom}&endDate=${dateTo}`, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      }, { retries: 2, initialDelayMs: 15000 });
    } catch (e) {
      // 429 — retry the whole chunk after backoff + cooldown
      if (e.message.includes('429') && attempt < maxAttempts - 1) {
        console.warn(`WB fullstats 429 for ${requested.size} campaigns, will retry`);
        continue;
      }
      console.error(`WB fullstats failed for ${requested.size} campaigns:`, e.message);
      break;
    }
    const data = await res.json();
    const arr = data == null ? [] : (Array.isArray(data) ? data : []);
    for (const s of arr) {
      const cid = s.advertId || s.id;
      if (requestedIds.has(cid)) {
        result.push(s);
        requested.delete(cid);
      }
    }
    // После успешного 200 не ретраим отсутствующие кампании: у них просто нет данных.
    break;
  }
  if (requested.size > 0) {
    console.warn(`WB fullstats: ${requested.size} campaigns without data: ${Array.from(requested).slice(0, 20).join(',')}`);
  }
  return result;
}

function advertCampaignId(value) {
  const rawId = value?.advertId ?? value?.id;
  if (rawId === null || rawId === undefined || rawId === '') return null;
  const id = Number(rawId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function validDateKey(value) {
  const key = toDateKey(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return '';
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? key
    : '';
}

function advertUsers(users) {
  return (Array.isArray(users) ? users : []).map(user => {
    if (Array.isArray(user.regexes)) {
      const regexes = user.regexes.flatMap(pattern => {
        try {
          return [pattern instanceof RegExp
            ? new RegExp(pattern.source, pattern.flags)
            : new RegExp(String(pattern), 'i')];
        } catch {
          return [];
        }
      });
      return { ...user, regexes };
    }
    const regexes = String(user.pattern || '')
      .split(/[,;]/)
      .map(pattern => pattern.trim())
      .filter(Boolean)
      .flatMap(pattern => {
        try {
          return [new RegExp(pattern, 'i')];
        } catch {
          return [];
        }
      });
    return { ...user, regexes };
  });
}

function advertMetric(day, key, { integer = false, required = false } = {}) {
  let present;
  let raw;
  if (key === 'sum_price') {
    if (Object.hasOwn(day, 'sum_price')) {
      present = true;
      raw = day.sum_price;
    } else if (Object.hasOwn(day, 'sumPrice')) {
      present = true;
      raw = day.sumPrice;
    } else {
      present = false;
    }
  } else {
    present = Object.hasOwn(day, key);
    raw = day[key];
  }
  if (!present) return required ? null : 0;
  if (typeof raw !== 'number' && (typeof raw !== 'string' || !raw.trim())) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return integer ? Math.trunc(value) : value;
}

function advertOptionalInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function advertWarning(code, message, count) {
  return { code, severity: 'warning', message, details: { count } };
}

function buildAdvertCandidate({ campaigns, stats, users, isKZT, exRate, dateFrom, dateTo, cabId, manualAssignments }) {
  const requestedCampaignEntries = Array.isArray(campaigns) ? campaigns : [];
  const campaignEntriesById = new Map();
  for (const campaign of requestedCampaignEntries) {
    const id = advertCampaignId(campaign);
    if (id === null) continue;
    if (!campaignEntriesById.has(id)) campaignEntriesById.set(id, []);
    campaignEntriesById.get(id).push(campaign);
  }

  const requestedIds = Array.from(campaignEntriesById.keys());
  const duplicateCampaignIds = new Set();
  const campaignById = new Map();
  for (const [id, entries] of campaignEntriesById) {
    if (entries.length > 1) duplicateCampaignIds.add(id);
    else campaignById.set(id, entries[0]);
  }

  const statsById = new Map();
  for (const stat of Array.isArray(stats) ? stats : []) {
    if (!stat || typeof stat !== 'object' || Array.isArray(stat)) continue;
    const id = advertCampaignId(stat);
    if (id === null || !campaignEntriesById.has(id)) continue;
    if (!statsById.has(id)) statsById.set(id, []);
    statsById.get(id).push(stat);
  }
  const duplicateStatsIds = new Set(
    Array.from(statsById)
      .filter(([, entries]) => entries.length > 1)
      .map(([id]) => id)
  );

  const confirmedIds = new Set();
  const rows = [];
  const normalizedUsers = advertUsers(users);
  const rate = isKZT ? 1 : Number(exRate);
  let outsideRange = 0;
  let invalidCampaigns = 0;

  for (const campaignId of requestedIds) {
    if (duplicateCampaignIds.has(campaignId) || duplicateStatsIds.has(campaignId)) continue;
    const statEntries = statsById.get(campaignId) || [];
    if (statEntries.length !== 1) continue;
    const stat = statEntries[0];
    if (!Array.isArray(stat.days)) {
      invalidCampaigns++;
      continue;
    }

    const campaign = campaignById.get(campaignId);
    const campaignName = campaign.name
      || campaign.settings?.name
      || stat.name
      || stat.settings?.name
      || `Кампания ${campaignId}`;
    const manualUserId = manualAssignments ? manualAssignments.get(`${cabId}:${campaignId}`) : null;
    const campaignUser = manualUserId
      ? normalizedUsers.find(u => u.id === manualUserId) || null
      : findUserForArticle(String(campaignName).toLowerCase(), normalizedUsers);
    const campaignType = advertOptionalInteger(campaign.type ?? stat.type);
    const status = advertOptionalInteger(campaign.status);
    const dates = new Set();
    const campaignRows = [];
    let campaignOutsideRange = 0;
    let invalid = false;

    for (const day of stat.days) {
      if (!day || typeof day !== 'object' || Array.isArray(day)) {
        invalid = true;
        break;
      }
      const date = validDateKey(day.date);
      if (!date || dates.has(date)) {
        invalid = true;
        break;
      }
      dates.add(date);
      if (date < dateFrom || date > dateTo) {
        campaignOutsideRange++;
        continue;
      }

      const views = advertMetric(day, 'views', { integer: true, required: true });
      const clicks = advertMetric(day, 'clicks', { integer: true, required: true });
      const ctr = advertMetric(day, 'ctr', { required: true });
      const cpc = advertMetric(day, 'cpc', { required: true });
      const rawSum = advertMetric(day, 'sum', { required: true });
      const atbs = advertMetric(day, 'atbs', { integer: true, required: true });
      const orders = advertMetric(day, 'orders', { integer: true, required: true });
      const cr = advertMetric(day, 'cr', { required: true });
      const shks = advertMetric(day, 'shks', { integer: true, required: true });
      const rawSumPrice = advertMetric(day, 'sum_price', { required: true });
      const metrics = [views, clicks, ctr, cpc, rawSum, atbs, orders, cr, shks, rawSumPrice, rate];
      if (metrics.some(value => value === null || !Number.isFinite(value))) {
        invalid = true;
        break;
      }
      const convertedSum = rawSum * rate;
      const convertedSumPrice = rawSumPrice * rate;
      if (!Number.isFinite(convertedSum) || !Number.isFinite(convertedSumPrice)) {
        invalid = true;
        break;
      }
      campaignRows.push({
        campaignId,
        campaignName,
        campaignType,
        status,
        userId: campaignUser ? campaignUser.id : null,
        date,
        views,
        clicks,
        ctr,
        cpc,
        sum: +convertedSum.toFixed(2),
        atbs,
        orders,
        cr,
        shks,
        sumPrice: +convertedSumPrice.toFixed(2),
      });
    }

    if (invalid) {
      invalidCampaigns++;
      continue;
    }
    confirmedIds.add(campaignId);
    outsideRange += campaignOutsideRange;
    rows.push(...campaignRows);
  }

  const issues = [];
  const returnedCampaigns = requestedCampaignEntries.reduce((count, campaign) => {
    const id = advertCampaignId(campaign);
    return count + (id !== null && confirmedIds.has(id) ? 1 : 0);
  }, 0);
  const missingCount = requestedCampaignEntries.length - returnedCampaigns;
  if (missingCount > 0) {
    issues.push(advertWarning(
      'advert_stats_missing',
      'Часть рекламных кампаний не вернула статистику за запрошенный период.',
      missingCount
    ));
  }
  if (duplicateCampaignIds.size > 0) {
    issues.push(advertWarning(
      'advert_duplicate_campaign_ids',
      'Повторяющиеся идентификаторы рекламных кампаний исключены из замены.',
      duplicateCampaignIds.size
    ));
  }
  if (duplicateStatsIds.size > 0) {
    issues.push(advertWarning(
      'advert_duplicate_stats_ids',
      'Повторяющиеся объекты рекламной статистики исключены из замены.',
      duplicateStatsIds.size
    ));
  }
  if (outsideRange > 0) {
    issues.push(advertWarning(
      'advert_days_out_of_range',
      'Строки рекламной статистики вне запрошенного периода пропущены.',
      outsideRange
    ));
  }
  if (invalidCampaigns > 0) {
    issues.push(advertWarning(
      'advert_days_invalid',
      'Кампании с некорректной рекламной статистикой исключены из замены.',
      invalidCampaigns
    ));
  }

  return {
    rows,
    replaceCampaignIds: requestedIds.filter(id => confirmedIds.has(id)),
    requestedCampaigns: requestedCampaignEntries.length,
    returnedCampaigns,
    issues,
  };
}

function projectAdvertTotals({ existingRows, candidate }) {
  const replaceIds = new Set(
    (Array.isArray(candidate?.replaceCampaignIds) ? candidate.replaceCampaignIds : [])
      .map(id => advertCampaignId({ id }))
      .filter(id => id !== null)
  );
  const byDate = {};
  const byManagerDate = {};

  const addRow = (row, normalized) => {
    const date = toDateKey(row.date);
    const sum = Number(row.sum);
    if (!date || !Number.isFinite(sum)) return;
    byDate[date] = +((byDate[date] || 0) + sum).toFixed(2);
    const userId = normalized ? row.userId : row.user_id;
    if (userId === null || userId === undefined) return;
    if (!byManagerDate[date]) byManagerDate[date] = {};
    byManagerDate[date][userId] = +((byManagerDate[date][userId] || 0) + sum).toFixed(2);
  };

  for (const row of Array.isArray(existingRows) ? existingRows : []) {
    const campaignId = advertCampaignId({ id: row.campaign_id ?? row.campaignId });
    if (campaignId !== null && replaceIds.has(campaignId)) continue;
    addRow(row, false);
  }
  for (const row of Array.isArray(candidate?.rows) ? candidate.rows : []) addRow(row, true);

  return { byDate, byManagerDate };
}

async function persistAdvertCandidate(client, cabId, dateFrom, dateTo, candidate) {
  const replaceCampaignIds = Array.isArray(candidate?.replaceCampaignIds)
    ? candidate.replaceCampaignIds
    : [];
  if (replaceCampaignIds.length) {
    await client.query(
      `DELETE FROM wb_advert_stats
       WHERE cab_id=$1 AND date BETWEEN $2 AND $3
         AND campaign_id = ANY($4::bigint[])`,
      [cabId, dateFrom, dateTo, replaceCampaignIds]
    );
  }

  const rows = Array.isArray(candidate?.rows) ? candidate.rows : [];
  for (const row of rows) {
    await client.query(
      `INSERT INTO wb_advert_stats
       (cab_id, user_id, campaign_id, campaign_name, campaign_type, status, date, views, clicks, ctr, cpc, sum, atbs, orders, cr, shks, sum_price, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
       ON CONFLICT (cab_id, campaign_id, date) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         campaign_name = EXCLUDED.campaign_name,
         campaign_type = EXCLUDED.campaign_type,
         status = EXCLUDED.status,
         views = EXCLUDED.views,
         clicks = EXCLUDED.clicks,
         ctr = EXCLUDED.ctr,
         cpc = EXCLUDED.cpc,
         sum = EXCLUDED.sum,
         atbs = EXCLUDED.atbs,
         orders = EXCLUDED.orders,
         cr = EXCLUDED.cr,
         shks = EXCLUDED.shks,
         sum_price = EXCLUDED.sum_price,
         updated_at = NOW()`,
      [
        cabId,
        row.userId,
        row.campaignId,
        row.campaignName,
        row.campaignType,
        row.status,
        row.date,
        row.views,
        row.clicks,
        row.ctr,
        row.cpc,
        row.sum,
        row.atbs,
        row.orders,
        row.cr,
        row.shks,
        row.sumPrice,
      ]
    );
  }
}

// Импорт рекламных расходов по кампаниям в wb_advert_stats
async function importCabAds(pool, cab, dateFrom, dateTo, isKZT = false, opts = {}) {
  const token = getCabToken(cab);
  if (!token) {
    throw new Error(`Токен не задан для кабинета ${cab.id} (${cab.name})`);
  }

  const { rows: users } = await pool.query(`SELECT id, pattern FROM users WHERE pattern IS NOT NULL AND pattern <> '' ORDER BY id`);

  let manualAssignments = new Map();
  try {
    manualAssignments = await loadAdvertCampaignAssignments(pool);
  } catch (e) {
    // совместимость со старыми схемами
  }

  const fetchAdvertsForImport = opts.fetchAdverts || fetchAdverts;
  const fetchAdvertStatsForImport = opts.fetchAdvertStats || fetchAdvertStats;
  const fetchRateForImport = opts.fetchRate || fetchRate;
  const adverts = await fetchAdvertsForImport(token);
  const campaigns = Array.isArray(adverts?.adverts) ? adverts.adverts : (Array.isArray(adverts) ? adverts : []);
  // WB Promotion в общих расходах учитывает и удалённые кампании (status 9),
  // поэтому импортируем все, чтобы итоговые цифры расходов совпадали с ЛК.
  console.log(`WB ads cab ${cab.id}: found ${campaigns.length} campaigns`);
  if (!campaigns.length) {
    const candidate = {
      rows: [],
      replaceCampaignIds: [],
      requestedCampaigns: 0,
      returnedCampaigns: 0,
      issues: [],
    };
    return {
      imported: 0,
      campaigns: 0,
      message: 'Нет рекламных кампаний',
      requestedCampaigns: 0,
      returnedCampaigns: 0,
      issues: [],
      ...(opts.candidateOnly ? { candidate } : {}),
    };
  }

  const ids = Array.from(new Set(campaigns.map(advertCampaignId).filter(id => id !== null)));
  const allStats = [];
  // WB Advert API ограничивает ids параметр 50 кампаниями на запрос и имеет
  // жёсткий глобальный rate limiter: при частых запросах возвращает 200 OK
  // с пустым телом. Запрашиваем маленькими группами с длинной паузой и
  // внутри fetchAdvertStats повторяем запросы для кампаний без ответа.
  // chunkSize/pause можно передать извне для ручного/фонового режима.
  const requestedChunkSize = parseInt(opts.chunkSize, 10);
  const requestedChunkPause = parseInt(opts.chunkPauseMs, 10);
  const chunkSize = Number.isFinite(requestedChunkSize) ? Math.max(1, requestedChunkSize) : 5;
  const chunkPauseMs = Number.isFinite(requestedChunkPause) ? Math.max(0, requestedChunkPause) : 60000;
  const totalChunks = Math.ceil(ids.length / chunkSize);
  const dateRanges = [];
  for (let d = new Date(dateFrom); d < new Date(dateTo); d.setDate(d.getDate() + 30)) {
    const subFrom = new Date(d).toISOString().split('T')[0];
    const subToDate = new Date(d); subToDate.setDate(subToDate.getDate() + 29);
    const subTo = subToDate >= new Date(dateTo) ? dateTo : subToDate.toISOString().split('T')[0];
    dateRanges.push([subFrom, subTo]);
  }
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const chunkNum = Math.floor(i / chunkSize) + 1;
    console.log(`WB ads cab ${cab.id}: chunk ${chunkNum}/${totalChunks} (${chunk.length} campaigns)`);
    for (const [subFrom, subTo] of dateRanges) {
      const chunkStats = await fetchAdvertStatsForImport(token, chunk, subFrom, subTo);
      if (Array.isArray(chunkStats)) allStats.push(...chunkStats);
    }
    if (i + chunkSize < ids.length) await delay(chunkPauseMs);
  }

  const exRate = await fetchRateForImport();
  const candidate = buildAdvertCandidate({
    campaigns,
    stats: allStats,
    users,
    isKZT,
    exRate,
    dateFrom,
    dateTo,
    cabId: cab.id,
    manualAssignments,
  });
  console.log(`WB ads cab ${cab.id}: fetched stats for ${candidate.returnedCampaigns}/${candidate.requestedCampaigns} campaigns`);

  const result = {
    imported: candidate.rows.length,
    campaigns: campaigns.length,
    requestedCampaigns: candidate.requestedCampaigns,
    returnedCampaigns: candidate.returnedCampaigns,
    issues: candidate.issues,
  };
  if (opts.candidateOnly) return { ...result, candidate };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [cab.id]);
    await persistAdvertCandidate(client, cab.id, dateFrom, dateTo, candidate);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return result;
}

// Демо-рекламные кампании для наглядного примера в UI
function generateDemoAds(cab, days = 7) {
  const campaigns = [
    { id: 1001, name: 'Поиск: шуруповёрты' },
    { id: 1002, name: 'Карточка: лазерный уровень' },
  ];
  const rows = [];
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i - 1);
    const dateStr = d.toISOString().split('T')[0];
    for (const c of campaigns) {
      const views = Math.round(2000 + Math.random() * 4000);
      const clicks = Math.round(views * (0.02 + Math.random() * 0.03));
      const sumRub = Math.round(300 + Math.random() * 1200);
      rows.push({
        campaign_id: c.id,
        campaign_name: c.name,
        campaign_type: 8,
        date: dateStr,
        views,
        clicks,
        ctr: +(clicks / views * 100).toFixed(2),
        cpc: +(sumRub / Math.max(clicks, 1)).toFixed(2),
        sum: sumRub,
        atbs: Math.round(clicks * 0.15),
        orders: Math.round(clicks * 0.05),
        cr: +(Math.random() * 5).toFixed(2),
        shks: Math.round(Math.random() * 10),
        sum_price: Math.round(sumRub * (5 + Math.random() * 3)),
      });
    }
  }
  return rows;
}

async function seedDemoAds(pool, cab, days = 7) {
  const rows = generateDemoAds(cab, days);
  const exRate = await fetchRate();
  let imported = 0;
  for (const r of rows) {
    const sumKzt = +(r.sum * exRate).toFixed(2);
    const sumPriceKzt = +(r.sum_price * exRate).toFixed(2);
    await pool.query(
      `INSERT INTO wb_advert_stats
       (cab_id, campaign_id, campaign_name, campaign_type, date, views, clicks, ctr, cpc, sum, atbs, orders, cr, shks, sum_price, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
       ON CONFLICT (cab_id, campaign_id, date) DO UPDATE SET
         campaign_name = EXCLUDED.campaign_name,
         campaign_type = EXCLUDED.campaign_type,
         views = EXCLUDED.views, clicks = EXCLUDED.clicks, ctr = EXCLUDED.ctr,
         cpc = EXCLUDED.cpc, sum = EXCLUDED.sum, atbs = EXCLUDED.atbs,
         orders = EXCLUDED.orders, cr = EXCLUDED.cr, shks = EXCLUDED.shks,
         sum_price = EXCLUDED.sum_price, updated_at = NOW()`,
      [
        cab.id, r.campaign_id, r.campaign_name, r.campaign_type, r.date,
        r.views, r.clicks, r.ctr, r.cpc, sumKzt, r.atbs, r.orders, r.cr, r.shks, sumPriceKzt
      ]
    );
    imported++;
  }
  return { imported, campaigns: 2 };
}



// ── Синхронизация товаров из WB в каталог ────────────────────────────────────

// Получаем уникальные товары продавца из заказов (Statistics API).
// Возвращает массив { nmId, supplierArticle, subject, category, brand, barcode }.
async function fetchCabProducts(token, days = 90) {
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const orders = await fetchAllPages(`${STAT_API}/api/v1/supplier/orders`, token, from);
  const map = new Map();
  for (const o of orders) {
    const key = String(o.nmId);
    if (!map.has(key)) {
      map.set(key, {
        nmId: o.nmId,
        supplierArticle: o.supplierArticle,
        subject: o.subject,
        category: o.category,
        brand: o.brand,
        barcode: o.barcode,
      });
    }
  }
  return Array.from(map.values());
}

// Синхронизируем товары из WB в таблицу catalog.
// commissionMap: { 'subjectName': pct } — комиссия по предмету (из Excel или WB API).
async function syncCabProducts(pool, cab, commissionMap = {}) {
  const token = getCabToken(cab);
  if (!token) {
    throw new Error(`Токен не задан для кабинета ${cab.id} (${cab.name})`);
  }

  const products = await fetchCabProducts(token);
  const templates = await loadCatalogTemplates(pool);
  let inserted = 0;
  let updated = 0;

  for (const p of products) {
    const article = String(p.supplierArticle || '').trim();
    if (!article) continue;

    const subject = String(p.subject || '').trim();
    const match = inferCatalogTemplate(article, subject);
    const template = match ? templates.get(match.templateName) : null;
    const name = template ? match.displayName : article;
    const comm = parseFloat(commissionMap[subject]) || (template ? Number(template.comm) || 0 : 0);

    // Если товар с таким артикулом уже есть — не затираем cost/comm/w/d/h,
    // но заполняем пустые значения из ручного шаблона товара.
    const { rows: existing } = await pool.query(
      `SELECT id, name, source, cost, comm, w, d, h FROM catalog WHERE article = $1`,
      [article]
    );

    if (existing.length) {
      const current = existing[0];
      if (current.source === 'wb') {
        await pool.query(
          `UPDATE catalog
           SET name=$1, subject=$2, cost=$3, comm=$4, w=$5, d=$6, h=$7, updated_at=NOW()
           WHERE id=$8`,
          [
            template && shouldReplaceImportedName(current.name, article) ? name : current.name,
            subject,
            template ? coalescePositive(current.cost, template.cost) : current.cost,
            coalescePositive(current.comm, comm),
            template ? coalescePositive(current.w, template.w) : current.w,
            template ? coalescePositive(current.d, template.d) : current.d,
            template ? coalescePositive(current.h, template.h) : current.h,
            current.id,
          ]
        );
      } else {
        await pool.query(
          `UPDATE catalog SET subject=COALESCE(NULLIF(subject,''), $1), updated_at=NOW() WHERE id=$2`,
          [subject, current.id]
        );
      }
      updated++;
    } else {
      await pool.query(
        `INSERT INTO catalog (name, article, cost, comm, w, d, h, subject, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'wb')`,
        [
          name,
          article,
          template ? Number(template.cost) || 0 : 0,
          comm,
          template ? Number(template.w) || 0 : 0,
          template ? Number(template.d) || 0 : 0,
          template ? Number(template.h) || 0 : 0,
          subject,
        ]
      );
      inserted++;
    }
  }

  return { products: products.length, inserted, updated };
}

module.exports = {
  getCabToken, fetchCommission, fetchBuyout, syncCab,
  importCabSales, importCabSalesFromRows, importCabOperationalSales, fetchCabOperationalRows,
  seedDemoSales, seedDemoAds,
  acceptedImportStatus, buildCabSalesCandidate, prepareCabSalesCandidate, applyCabSalesCandidate,
  fetchReportDetailByPeriod, fetchSupplierSales, fetchAdverts, fetchAdvertStats, importCabAds,
  buildAdvertCandidate, projectAdvertTotals, persistAdvertCandidate,
  fetchCabProducts, syncCabProducts,
  buildCatalogCandidate, persistCatalogCandidate, findCatalogProduct, isFinancialDocumentRow,
  allocateCents,
  runValidatedAttempts, failedImportResult,
  fetchFinanceReports, persistFinanceReports, applyFinanceExpenses, fetchRate,
};
