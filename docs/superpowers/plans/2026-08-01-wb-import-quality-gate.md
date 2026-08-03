# WB Import Quality Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Проверять каждый импорт WB до записи, сохранять прежние данные при подозрительном ответе и показывать администратору устойчивый журнал статусов без дополнительных WB-запросов при открытии UI.

**Architecture:** Получение данных, построение кандидата, валидация и применение разделяются. Финансовые, каталожные и рекламные изменения сначала формируются в памяти; чистый валидатор проверяет инварианты и сравнивает закрытые дни с последними принятыми данными; только успешно проверенный кандидат сохраняется одной транзакцией под advisory lock. Каждая попытка фиксируется в `wb_import_runs`, а актуальное состояние даты — в `wb_import_days`.

**Tech Stack:** Node.js CommonJS, `node:test`, Express 5, PostgreSQL 16 через `pg`, React 19/Vite, существующий Docker Compose.

**Execution policy:** Не создавать git-коммиты без отдельного явного запроса пользователя. После каждой задачи проверять только относящийся к ней diff и запускать указанные проверки.

---

## File Map

**Create:**

- `backend/wbImportValidation.js` — чистая классификация строк, проверка кандидата и определение пользовательского статуса.
- `backend/wbImportJournal.js` — создание/завершение попыток, чтение предыдущих метрик и обновление дневных статусов.
- `backend/test/wbImportValidation.test.js` — модульные тесты обязательных полей, диапазонов, дублей, агрегатов, формул, аксессуаров и порогов.
- `backend/test/wbImportJournal.test.js` — тесты параметризованных SQL-вызовов и сохранения последнего принятого статуса при блокировке.
- `backend/test/wbImportFlow.test.js` — тесты повторов, отсутствия записи при блокировке и атомарного применения кандидата на fake pool/client.

**Modify:**

- `backend/wb.js` — side-effect-free подготовка каталога и рекламы, построение финансового кандидата, повторы и единая транзакция.
- `backend/catalogTemplates.js` — без изменения правил распознавания; добавляется чистый план безопасной очистки автоматических accessory-карточек.
- `backend/migrate.js` — таблицы журнала, индексы и очистка старых автоматических accessory-сопоставлений.
- `backend/index.js` — startup compatibility schema и endpoints журнала.
- `backend/scheduler.js` — сохранение `runId/status/issues` и корректное продолжение после блокировки кабинета.
- `backend/scripts/backfill-current-sales.js` — использование того же проверяемого пути и вывод статуса попытки.
- `my-react-app/src/api.js` — чтение журнала и статусов.
- `my-react-app/src/App.jsx` — статусы по кабинетам, причины блокировки и безопасный результат ручного импорта.

**Verification only:**

- `backend/scripts/check-report-consistency.js` — финальная сверка пяти отчётов; менять только если формат нового ответа требует чтения дополнительного поля.

---

### Task 1: Classify and Validate Raw Financial Rows

**Files:**

- Create: `backend/wbImportValidation.js`
- Create: `backend/test/wbImportValidation.test.js`

- [ ] **Step 1: Write failing tests for row classification**

Create the test file with these initial cases:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareFinancialRows } = require('../wbImportValidation');

const sale = (overrides = {}) => ({
  rrd_id: 1,
  doc_type_name: 'Продажа',
  sale_dt: '2026-07-25T12:00:00',
  sa_name: 'nz_tr_talgat11',
  quantity: 1,
  retail_amount: 10000,
  currency_name: 'KZT',
  ...overrides,
});

test('принимает корректную финансовую строку внутри периода', () => {
  const result = prepareFinancialRows({
    rows: [sale()],
    dateFrom: '2026-07-25',
    dateTo: '2026-07-25',
  });
  assert.equal(result.ok, true);
  assert.equal(result.acceptedRows.length, 1);
  assert.equal(result.rejectedRows, 0);
});

test('отбрасывает служебные и соседние даты с предупреждением', () => {
  const result = prepareFinancialRows({
    rows: [
      sale({ rrd_id: 2, doc_type_name: 'Логистика' }),
      sale({ rrd_id: 3, sale_dt: '2026-07-24T23:59:00' }),
      sale({ rrd_id: 4 }),
    ],
    dateFrom: '2026-07-25',
    dateTo: '2026-07-25',
  });
  assert.deepEqual(result.acceptedRows.map(row => row.rrd_id), [4]);
  assert.equal(result.issues.some(issue => issue.code === 'service_rows_skipped'), true);
  assert.equal(result.issues.some(issue => issue.code === 'out_of_range_rows'), true);
});

test('блокирует повреждённую финансовую строку', () => {
  const result = prepareFinancialRows({
    rows: [sale({ sa_name: '' })],
    dateFrom: '2026-07-25',
    dateTo: '2026-07-25',
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues.some(issue => issue.code === 'missing_article' && issue.severity === 'critical'), true);
});

test('блокирует повторяющийся rrd_id', () => {
  const result = prepareFinancialRows({
    rows: [sale(), sale()],
    dateFrom: '2026-07-25',
    dateTo: '2026-07-25',
  });
  assert.equal(result.ok, false);
  assert.equal(result.issues.some(issue => issue.code === 'duplicate_rrd_id'), true);
});

test('блокирует не-массив вместо ответа WB', () => {
  const result = prepareFinancialRows({ rows: {}, dateFrom: '2026-07-25', dateTo: '2026-07-25' });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, 'invalid_response_shape');
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --test test/wbImportValidation.test.js`

Expected: FAIL with `Cannot find module '../wbImportValidation'`.

- [ ] **Step 3: Implement the row preparation API**

Create `backend/wbImportValidation.js` with the exact public contract below. Keep issue objects JSON-safe and never include complete source rows.

```js
const { isAccessoryArticle } = require('./catalogTemplates');

const FINANCIAL_DOCUMENTS = new Set(['продажа', 'возврат']);

function issue(code, severity, message, details = {}) {
  return { code, severity, message, details };
}

function rowDate(row) {
  const raw = row?.sale_dt || row?.order_dt || row?.date_from;
  return typeof raw === 'string' ? raw.split('T')[0] : '';
}

function rowArticle(row) {
  return String(row?.sa_name || row?.supplier_article || row?.supplierArticle || '').trim().toLowerCase();
}

function isFiniteField(value) {
  return value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value));
}

function prepareFinancialRows({ rows, dateFrom, dateTo }) {
  if (!Array.isArray(rows)) {
    return {
      ok: false,
      acceptedRows: [],
      fetchedRows: 0,
      rejectedRows: 0,
      issues: [issue('invalid_response_shape', 'critical', 'WB вернул ответ неожиданного формата')],
    };
  }

  const acceptedRows = [];
  const issues = [];
  const seenRrdIds = new Set();
  let serviceRows = 0;
  let outOfRangeRows = 0;

  for (const row of rows) {
    const docType = String(row?.doc_type_name || '').trim().toLowerCase();
    if (!FINANCIAL_DOCUMENTS.has(docType)) {
      serviceRows++;
      continue;
    }

    const date = rowDate(row);
    const article = rowArticle(row);
    if (!date) issues.push(issue('missing_date', 'critical', 'Финансовая строка не содержит дату'));
    if (!article) issues.push(issue('missing_article', 'critical', 'Финансовая строка не содержит артикул'));
    if (!isFiniteField(row.quantity) || Number(row.quantity) === 0) {
      issues.push(issue('invalid_quantity', 'critical', 'Финансовая строка содержит некорректное количество'));
    }
    if (!isFiniteField(row.retail_amount)) {
      issues.push(issue('invalid_retail_amount', 'critical', 'Финансовая строка содержит некорректную сумму'));
    }

    const rrdId = row.rrd_id ?? row.rrdId;
    if (rrdId !== null && rrdId !== undefined) {
      const key = String(rrdId);
      if (seenRrdIds.has(key)) issues.push(issue('duplicate_rrd_id', 'critical', 'WB вернул повторяющийся rrd_id'));
      seenRrdIds.add(key);
    }

    if (!date || !article || !isFiniteField(row.quantity) || Number(row.quantity) === 0 || !isFiniteField(row.retail_amount)) continue;
    if (date < dateFrom || date > dateTo) {
      outOfRangeRows++;
      continue;
    }
    acceptedRows.push(row);
  }

  if (serviceRows) issues.push(issue('service_rows_skipped', 'warning', 'Служебные строки исключены', { count: serviceRows }));
  if (outOfRangeRows) issues.push(issue('out_of_range_rows', 'warning', 'Строки вне периода исключены', { count: outOfRangeRows }));
  if (rows.length && !acceptedRows.length && outOfRangeRows) {
    issues.push(issue('no_rows_in_requested_range', 'critical', 'Все финансовые строки находятся вне запрошенного периода'));
  }

  return {
    ok: !issues.some(item => item.severity === 'critical'),
    acceptedRows,
    fetchedRows: rows.length,
    rejectedRows: rows.length - acceptedRows.length,
    issues,
  };
}

module.exports = {
  isAccessoryArticle,
  prepareFinancialRows,
  rowArticle,
  rowDate,
};
```

- [ ] **Step 4: Add edge-case tests for zero, negative returns and non-finite values**

Add assertions that `retail_amount: 0` remains valid, a `Возврат` row remains valid, and strings such as `'Infinity'` are blocked. Do not reject a negative signed result after applying return direction; only reject malformed source fields.

- [ ] **Step 5: Run the focused tests and confirm GREEN**

Run: `node --test test/wbImportValidation.test.js`

Expected: all row-classification tests PASS.

---

### Task 2: Validate Aggregates, Formulas, Accessories and Historical Deltas

**Files:**

- Modify: `backend/wbImportValidation.js`
- Modify: `backend/test/wbImportValidation.test.js`

- [ ] **Step 1: Write failing candidate-validation tests**

Extend the test file with a reusable valid candidate and tests for the core invariants:

```js
const { validateImportCandidate } = require('../wbImportValidation');

const validCandidate = () => ({
  buyout: 0.88,
  days: [{
    date: '2026-07-25', qty: 10, rev: 100000, ads: 5000, cost: 40000,
    comm: 20000, cabComm: 0, logF: 2000, logR: 100,
    ret: 12000, profit: 20900,
  }],
  details: [{
    date: '2026-07-25', userId: 1, article: 'nz_tr_talgat11',
    qty: 10, rev: 100000, ads: 5000, cost: 40000, comm: 20000,
  }],
  catalogMatches: [{
    article: 'nz_tr_talgat11', source: 'inferred', cost: 4000, w: 10, d: 10, h: 10,
  }],
});

test('принимает согласованный кандидат', () => {
  const result = validateImportCandidate({ candidate: validCandidate(), previousDays: [] });
  assert.equal(result.ok, true);
});

test('блокирует расхождение детализации и агрегата', () => {
  const candidate = validCandidate();
  candidate.details[0].cost = 39000;
  const result = validateImportCandidate({ candidate, previousDays: [] });
  assert.equal(result.ok, false);
  assert.equal(result.issues.some(item => item.code === 'detail_total_mismatch'), true);
});

test('блокирует неправильную прибыль', () => {
  const candidate = validCandidate();
  candidate.days[0].profit = 999;
  const result = validateImportCandidate({ candidate, previousDays: [] });
  assert.equal(result.issues.some(item => item.code === 'profit_formula_mismatch'), true);
});

test('блокирует автоматическое сопоставление аксессуара с полным товаром', () => {
  const candidate = validCandidate();
  candidate.catalogMatches = [{
    article: 'almg_bg_batareika_1', source: 'inferred', cost: 16000, w: 30, d: 20, h: 10,
  }];
  const result = validateImportCandidate({ candidate, previousDays: [] });
  assert.equal(result.issues.some(item => item.code === 'automatic_accessory_match'), true);
});

test('разрешает ручную карточку аксессуара', () => {
  const candidate = validCandidate();
  candidate.catalogMatches = [{
    article: 'almg_bg_batareika_1', source: 'manual', cost: 2500, w: 10, d: 8, h: 6,
  }];
  const result = validateImportCandidate({ candidate, previousDays: [] });
  assert.equal(result.issues.some(item => item.code === 'automatic_accessory_match'), false);
});

test('блокирует изменение закрытого значимого дня более чем на 80 процентов', () => {
  const candidate = validCandidate();
  candidate.days[0].qty = 100;
  candidate.details[0].qty = 100;
  const result = validateImportCandidate({
    candidate,
    previousDays: [{ date: '2026-07-25', qty: 10, rev: 100000, cost: 40000 }],
  });
  assert.equal(result.issues.some(item => item.code === 'historical_delta_exceeded'), true);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --test test/wbImportValidation.test.js`

Expected: FAIL because `validateImportCandidate` is not exported.

- [ ] **Step 3: Implement candidate validation**

Add these helpers and export `validateImportCandidate`. Use a 0.01 monetary tolerance and compare only metrics represented in article detail.

```js
const MONEY_TOLERANCE = 0.01;

function approxEqual(left, right, tolerance = MONEY_TOLERANCE) {
  return Math.abs(Number(left || 0) - Number(right || 0)) <= tolerance;
}

function sumByDate(rows) {
  const totals = new Map();
  for (const row of rows) {
    const current = totals.get(row.date) || { qty: 0, rev: 0, ads: 0, cost: 0, comm: 0 };
    for (const key of ['qty', 'rev', 'ads', 'cost', 'comm']) current[key] += Number(row[key] || 0);
    totals.set(row.date, current);
  }
  return totals;
}

function changeExceeded(previous, next, floor) {
  const oldValue = Math.abs(Number(previous || 0));
  if (oldValue < floor) return false;
  return Math.abs(Number(next || 0) - Number(previous || 0)) / oldValue > 0.8;
}

function validateImportCandidate({ candidate, previousDays }) {
  const issues = [];
  const detailByDate = sumByDate(candidate.details || []);
  const previousByDate = new Map((previousDays || []).map(day => [String(day.date), day]));

  for (const day of candidate.days || []) {
    for (const key of ['qty', 'rev', 'ads', 'cost', 'comm', 'cabComm', 'logF', 'logR', 'ret', 'profit']) {
      if (!Number.isFinite(Number(day[key]))) {
        issues.push(issue('non_finite_candidate_value', 'critical', 'Расчёт содержит некорректное число', { date: day.date, metric: key }));
      }
    }

    const detail = detailByDate.get(day.date) || { qty: 0, rev: 0, ads: 0, cost: 0, comm: 0 };
    for (const key of ['qty', 'rev', 'ads', 'cost', 'comm']) {
      if (!approxEqual(day[key], detail[key])) {
        issues.push(issue('detail_total_mismatch', 'critical', 'Детализация не совпадает с итогом кабинета', { date: day.date, metric: key }));
      }
    }

    const expectedProfit = day.rev * candidate.buyout - day.cost - day.ads - day.comm
      - day.cabComm - day.logF - day.logR;
    if (!approxEqual(day.profit, expectedProfit)) {
      issues.push(issue('profit_formula_mismatch', 'critical', 'Прибыль не совпадает с формулой', { date: day.date }));
    }

    const previous = previousByDate.get(day.date);
    if (previous && (
      changeExceeded(previous.qty, day.qty, 5)
      || changeExceeded(previous.rev, day.rev, 50000)
      || changeExceeded(previous.cost, day.cost, 50000)
    )) {
      issues.push(issue('historical_delta_exceeded', 'critical', 'Закрытый день изменился более чем на 80%', { date: day.date }));
    }
  }

  for (const product of candidate.catalogMatches || []) {
    if (isAccessoryArticle(product.article) && product.source !== 'manual'
      && (Number(product.cost) > 0 || Number(product.w) > 0 || Number(product.d) > 0 || Number(product.h) > 0)) {
      issues.push(issue('automatic_accessory_match', 'critical', 'Аксессуару назначены параметры полного товара', { article: product.article }));
    }
  }

  return { ok: !issues.some(item => item.severity === 'critical'), issues };
}
```

- [ ] **Step 4: Add tests for small historical values and manager coverage**

Add one test proving that changing `qty` from `1` to `10` does not trip the significance floor, and one test where manager plus unassigned detail omits an article and therefore fails `detail_total_mismatch`.

- [ ] **Step 5: Run all validation tests**

Run: `node --test test/wbImportValidation.test.js`

Expected: all tests PASS.

---

### Task 3: Add Persistent Import Journal and Day Status

**Files:**

- Modify: `backend/migrate.js:61-241`
- Modify: `backend/index.js:79-149`
- Create: `backend/wbImportJournal.js`
- Create: `backend/test/wbImportJournal.test.js`

- [ ] **Step 1: Add failing journal tests using a recording fake pool**

Create a fake pool that records `{ text, values }`, then test that no issue payload contains source rows or tokens and that a blocked day update does not overwrite accepted fields:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { startImportRun, finishImportRun, recordImportDays } = require('../wbImportJournal');

function fakeDb(resultRows = [{ id: 41 }]) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      return { rows: resultRows };
    },
  };
}

test('создаёт попытку параметризованным запросом', async () => {
  const db = fakeDb();
  const run = await startImportRun(db, { cabId: 6, dateFrom: '2026-07-25', dateTo: '2026-07-25' });
  assert.equal(run.id, 41);
  assert.deepEqual(db.calls[0].values, [6, '2026-07-25', '2026-07-25']);
});

test('при блокировке обновляет только поля последней попытки дня', async () => {
  const db = fakeDb([]);
  await recordImportDays(db, {
    cabId: 6,
    runId: 41,
    dates: ['2026-07-25'],
    status: 'blocked',
    issues: [{ code: 'historical_delta_exceeded', severity: 'critical' }],
  });
  assert.match(db.calls[0].text, /last_attempt_run_id/);
  assert.doesNotMatch(db.calls[0].text, /accepted_run_id\s*=\s*EXCLUDED/);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node --test test/wbImportJournal.test.js`

Expected: FAIL because `wbImportJournal.js` does not exist.

- [ ] **Step 3: Add both tables to the baseline migration**

Append the following DDL after `app_settings` in `backend/migrate.js`:

```sql
CREATE TABLE IF NOT EXISTS wb_import_runs (
  id BIGSERIAL PRIMARY KEY,
  cab_id INTEGER NOT NULL REFERENCES cabs(id) ON DELETE CASCADE,
  requested_from DATE NOT NULL,
  requested_to DATE NOT NULL,
  actual_from DATE,
  actual_to DATE,
  status TEXT NOT NULL CHECK (status IN ('running','provisional','verified','blocked','failed')),
  attempts INTEGER NOT NULL DEFAULT 1,
  fetched_rows INTEGER NOT NULL DEFAULT 0,
  accepted_rows INTEGER NOT NULL DEFAULT 0,
  rejected_rows INTEGER NOT NULL DEFAULT 0,
  source_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  candidate_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS wb_import_runs_cab_started_idx
  ON wb_import_runs (cab_id, started_at DESC);

CREATE TABLE IF NOT EXISTS wb_import_days (
  cab_id INTEGER NOT NULL REFERENCES cabs(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  accepted_run_id BIGINT REFERENCES wb_import_runs(id) ON DELETE SET NULL,
  accepted_status TEXT CHECK (accepted_status IN ('provisional','verified')),
  accepted_at TIMESTAMPTZ,
  last_attempt_run_id BIGINT REFERENCES wb_import_runs(id) ON DELETE SET NULL,
  last_attempt_status TEXT NOT NULL CHECK (last_attempt_status IN ('provisional','verified','blocked','failed')),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (cab_id, date)
);
```

- [ ] **Step 4: Add idempotent startup compatibility DDL**

Add one ordered `pool.query()` block in `backend/index.js` after `app_settings` creation. Include the same two table definitions and index. Keep `wb_import_runs` before `wb_import_days` because of the foreign key.

- [ ] **Step 5: Implement journal functions**

Create `backend/wbImportJournal.js` exporting:

```js
async function startImportRun(db, { cabId, dateFrom, dateTo }) {
  const { rows } = await db.query(
    `INSERT INTO wb_import_runs (cab_id, requested_from, requested_to, status)
     VALUES ($1, $2, $3, 'running') RETURNING id`,
    [cabId, dateFrom, dateTo]
  );
  return rows[0];
}

async function finishImportRun(db, runId, result) {
  const dates = result.dates || [];
  const actualFrom = dates.length ? dates.slice().sort()[0] : null;
  const actualTo = dates.length ? dates.slice().sort().at(-1) : null;
  await db.query(
    `UPDATE wb_import_runs SET actual_from=$2, actual_to=$3, status=$4, attempts=$5,
       fetched_rows=$6, accepted_rows=$7, rejected_rows=$8, source_metrics=$9,
       candidate_metrics=$10, issues=$11, finished_at=NOW() WHERE id=$1`,
    [runId, actualFrom, actualTo, result.status, result.attempts, result.fetchedRows,
      result.acceptedRows, result.rejectedRows, result.sourceMetrics || {},
      result.candidateMetrics || {}, result.issues || []]
  );
}

async function recordImportDays(db, { cabId, runId, dates, status, issues }) {
  for (const date of dates) {
    if (status === 'provisional' || status === 'verified') {
      await db.query(
        `INSERT INTO wb_import_days
         (cab_id,date,accepted_run_id,accepted_status,accepted_at,last_attempt_run_id,last_attempt_status,checked_at,issues)
         VALUES ($1,$2,$3,$4,NOW(),$3,$4,NOW(),$5)
         ON CONFLICT (cab_id,date) DO UPDATE SET
           accepted_run_id=EXCLUDED.accepted_run_id, accepted_status=EXCLUDED.accepted_status,
           accepted_at=NOW(), last_attempt_run_id=EXCLUDED.last_attempt_run_id,
           last_attempt_status=EXCLUDED.last_attempt_status, checked_at=NOW(), issues=EXCLUDED.issues`,
        [cabId, date, runId, status, issues || []]
      );
    } else {
      await db.query(
        `INSERT INTO wb_import_days
         (cab_id,date,last_attempt_run_id,last_attempt_status,checked_at,issues)
         VALUES ($1,$2,$3,$4,NOW(),$5)
         ON CONFLICT (cab_id,date) DO UPDATE SET
           last_attempt_run_id=EXCLUDED.last_attempt_run_id,
           last_attempt_status=EXCLUDED.last_attempt_status, checked_at=NOW(), issues=EXCLUDED.issues`,
        [cabId, date, runId, status, issues || []]
      );
    }
  }
}

async function loadPreviousDays(db, cabId, dateFrom, dateTo) {
  const { rows } = await db.query(
    `SELECT s.date::text, COALESCE(d.qty,0)::numeric AS qty, s.rev, s.cost
     FROM wb_sales s
     LEFT JOIN (
       SELECT cab_id,date,SUM(qty) AS qty FROM wb_manager_sales_detail
       WHERE cab_id=$1 AND date BETWEEN $2 AND $3 GROUP BY cab_id,date
     ) d ON d.cab_id=s.cab_id AND d.date=s.date
     WHERE s.cab_id=$1 AND s.date BETWEEN $2 AND $3`,
    [cabId, dateFrom, dateTo]
  );
  return rows.map(row => ({ ...row, qty: Number(row.qty), rev: Number(row.rev), cost: Number(row.cost) }));
}

module.exports = { startImportRun, finishImportRun, recordImportDays, loadPreviousDays };
```

- [ ] **Step 6: Run journal tests and migration syntax checks**

Run:

```bash
node --test test/wbImportJournal.test.js
node --check wbImportJournal.js
node --check migrate.js
node --check index.js
```

Expected: all tests PASS and all checks exit `0`.

---

### Task 4: Build Side-Effect-Free Catalog and Advertising Candidates

**Files:**

- Modify: `backend/wb.js:120-236`
- Modify: `backend/wb.js:840-1010`
- Modify: `backend/test/wb.test.js`
- Create: `backend/test/wbImportFlow.test.js`

- [ ] **Step 1: Add failing tests for no-write preparation**

Add tests for these exported functions:

```js
const {
  buildCatalogCandidate,
  buildAdvertCandidate,
  projectAdvertTotals,
} = require('../wb');

test('подготовка каталога не выполняет UPDATE или INSERT', async () => {
  const calls = [];
  const pool = { query: async (text, values) => {
    calls.push({ text, values });
    if (text.includes('DISTINCT ON')) return { rows: [] };
    return { rows: [] };
  } };
  await buildCatalogCandidate(pool, [{
    doc_type_name: 'Продажа', sale_dt: '2026-07-25', sa_name: 'new_article',
    subject_name: 'Шуруповерты', quantity: 1, retail_amount: 1000,
  }]);
  assert.equal(calls.some(call => /^\s*(UPDATE|INSERT)/i.test(call.text)), false);
});

test('пустой ответ рекламы не удаляет прежнюю статистику', () => {
  const candidate = buildAdvertCandidate({
    campaigns: [{ id: 1 }], stats: [], users: [], isKZT: true, exRate: 1,
    dateFrom: '2026-07-25', dateTo: '2026-07-25',
  });
  assert.equal(candidate.rows.length, 0);
  assert.equal(candidate.replaceCampaignIds.length, 0);
  assert.equal(candidate.issues.some(issue => issue.code === 'advert_stats_missing'), true);
});

test('проекция рекламы заменяет только подтверждённые кампании', () => {
  const projected = projectAdvertTotals({
    existingRows: [
      { date: '2026-07-25', campaign_id: 1, user_id: 5, sum: 100 },
      { date: '2026-07-25', campaign_id: 2, user_id: 6, sum: 200 },
    ],
    candidate: {
      replaceCampaignIds: [1],
      rows: [{ date: '2026-07-25', campaignId: 1, userId: 5, sum: 150 }],
    },
  });
  assert.equal(projected.byDate['2026-07-25'], 350);
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node --test test/wb.test.js test/wbImportFlow.test.js`

Expected: FAIL because the candidate functions are not exported.

- [ ] **Step 3: Split catalog preparation from persistence**

Replace `loadCatalogByArticle()` with:

```js
async function buildCatalogCandidate(pool, sourceRows = []) {
  const [{ rows }, templates] = await Promise.all([
    pool.query(`SELECT id,name,cost,comm,w,d,h,article,subject,source FROM catalog WHERE article IS NOT NULL`),
    loadCatalogTemplates(pool),
  ]);
  const catalogByArticle = Object.fromEntries(rows.map(product => [String(product.article).trim().toLowerCase(), product]));
  const upserts = [];

  for (const row of sourceRows) {
    const article = String(row.sa_name || row.supplier_article || '').trim();
    const key = article.toLowerCase();
    if (!key || isAccessoryArticle(key)) continue;
    const current = catalogByArticle[key];
    const canEnrich = !current || current.source === 'inferred'
      || (current.source === 'wb' && shouldReplaceImportedName(current.name, article));
    if (!canEnrich) continue;
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
    catalogByArticle[key] = product;
    upserts.push(product);
  }
  return { catalogByArticle, upserts };
}
```

Add `persistCatalogCandidate(client, upserts)` and call it only from the final accepted transaction. Use `INSERT ... ON CONFLICT (article) DO UPDATE` but never overwrite rows where `catalog.source='manual'`.

- [ ] **Step 4: Split advertisement fetch/build from persistence**

Implement `buildAdvertCandidate({ campaigns, stats, users, isKZT, exRate, dateFrom, dateTo })` as a pure transform. It must return:

```js
{
  rows: [{ campaignId, campaignName, userId, date, views, clicks, ctr, cpc, sum, atbs, orders, cr, shks, sumPrice }],
  replaceCampaignIds: [],
  requestedCampaigns: campaigns.length,
  returnedCampaigns: 0,
  issues: [],
}
```

Only add a campaign ID to `replaceCampaignIds` when WB returned a stats object for that campaign. Dates outside `dateFrom..dateTo` are not added to rows. If a requested campaign has no stats object, preserve its existing DB rows and add `advert_stats_missing` warning.

- [ ] **Step 5: Implement projected advertising totals**

`projectAdvertTotals()` must remove existing contributions only for `replaceCampaignIds`, add candidate rows, then return both total and direct-manager maps:

```js
{
  byDate: { '2026-07-25': 350 },
  byManagerDate: { '2026-07-25': { 5: 150, 6: 200 } },
}
```

This projected state is what financial profit validation uses before any advertising row is written.

- [ ] **Step 6: Add transactional advertising persistence**

Implement `persistAdvertCandidate(client, cabId, dateFrom, dateTo, candidate)`:

```js
if (candidate.replaceCampaignIds.length) {
  await client.query(
    `DELETE FROM wb_advert_stats
     WHERE cab_id=$1 AND date BETWEEN $2 AND $3 AND campaign_id = ANY($4::bigint[])`,
    [cabId, dateFrom, dateTo, candidate.replaceCampaignIds]
  );
}
for (const row of candidate.rows) {
  await client.query(
    `INSERT INTO wb_advert_stats
     (cab_id,user_id,campaign_id,campaign_name,campaign_type,status,date,views,clicks,ctr,cpc,sum,atbs,orders,cr,shks,sum_price,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
     ON CONFLICT (cab_id,campaign_id,date) DO UPDATE SET
       user_id=EXCLUDED.user_id,campaign_name=EXCLUDED.campaign_name,
       campaign_type=EXCLUDED.campaign_type,status=EXCLUDED.status,
       views=EXCLUDED.views,clicks=EXCLUDED.clicks,ctr=EXCLUDED.ctr,cpc=EXCLUDED.cpc,
       sum=EXCLUDED.sum,atbs=EXCLUDED.atbs,orders=EXCLUDED.orders,cr=EXCLUDED.cr,
       shks=EXCLUDED.shks,sum_price=EXCLUDED.sum_price,updated_at=NOW()`,
    [cabId,row.userId,row.campaignId,row.campaignName,row.campaignType,row.status,row.date,
      row.views,row.clicks,row.ctr,row.cpc,row.sum,row.atbs,row.orders,row.cr,row.shks,row.sumPrice]
  );
}
```

- [ ] **Step 7: Preserve standalone `importCabAds` compatibility**

Keep the exported function, but make it fetch a candidate and apply it in its own transaction with `pg_advisory_xact_lock(cab.id)`. Empty or partial successful responses must never execute the old whole-period delete.

- [ ] **Step 8: Run focused and full backend tests**

Run:

```bash
node --test test/wb.test.js test/wbImportFlow.test.js
npm test
```

Expected: all tests PASS.

---

### Task 5: Build, Validate and Atomically Apply the Financial Candidate

**Files:**

- Modify: `backend/wb.js:389-834`
- Modify: `backend/test/wbImportFlow.test.js`
- Modify: `backend/test/wbImportValidation.test.js`

- [ ] **Step 1: Add failing tests for blocked and accepted flows**

Introduce the explicit seams `prepareCabSalesCandidate()` and `applyCabSalesCandidate()`. Test preparation separately from persistence so the test never needs the network:

```js
const { prepareCabSalesCandidate, applyCabSalesCandidate } = require('../wb');

function recordingClient() {
  const calls = [];
  return {
    calls,
    async query(text) {
      calls.push(String(text).trim());
      return { rows: [] };
    },
    release() {},
  };
}

test('заблокированный подготовленный кандидат не обращается к функции записи', async () => {
  let applied = false;
  const candidate = validCandidate();
  candidate.details[0].cost = 1;
  const result = await prepareCabSalesCandidate({ candidate, previousDays: [] });
  assert.equal(result.status, 'blocked');
  if (result.status !== 'blocked') applied = true;
  assert.equal(applied, false);
});

test('применение принятого кандидата использует одну транзакцию', async () => {
  const client = recordingClient();
  const pool = { connect: async () => client };
  await applyCabSalesCandidate(pool, { id: 6 }, {
    ...validCandidate(),
    status: 'verified',
    catalogUpserts: [],
    advertCandidate: { rows: [], replaceCampaignIds: [] },
    managerDays: [],
    issues: [],
    sourceMetrics: {},
    candidateMetrics: {},
  }, {
    dateFrom: '2026-07-25', dateTo: '2026-07-25', runId: 41,
  });
  assert.equal(client.calls[0], 'BEGIN');
  assert.equal(client.calls.at(-1), 'COMMIT');
});
```

Define `validCandidate()` in `wbImportFlow.test.js` with the complete candidate shape from Task 2. The recording client returns empty `rows` for control re-reads and records `BEGIN/COMMIT/ROLLBACK`; no test in this task calls the network.

- [ ] **Step 2: Run the flow test and confirm RED**

Run: `node --test test/wbImportFlow.test.js`

Expected: FAIL because current import writes without returning validation status.

- [ ] **Step 3: Build an explicit candidate object before `pool.connect()`**

Extract the calculation portion of `importCabSalesFromRows()` into `buildCabSalesCandidate()`. All current `byDate`, `byManagerDate` and `byUnassignedDate` calculations must finish before a transaction. Convert them into arrays:

```js
const candidate = {
  status: acceptedImportStatus(days.map(day => day.date)),
  buyout,
  days,
  managerDays,
  details,
  catalogMatches,
  catalogUpserts,
  advertCandidate: options.advertCandidate || null,
  issues: options.sourceIssues || [],
  sourceMetrics,
  candidateMetrics,
};
```

Each `days` entry contains `qty`, `rev`, `ads`, `cost`, `comm`, `cabComm`, `logF`, `logR`, `ret`, `profit`, `margin` and `drr`. `details` contains both manager rows and `userId: null` rows so its `qty/rev/cost/comm/ads` sums match `days`.

- [ ] **Step 4: Validate before opening the transaction**

Load prior values with `loadPreviousDays()`, but compare only dates classified as closed. A date is closed when it is earlier than yesterday in `YYYY-MM-DD` form. Pass fresh dates with no `previousDays` entry to the historical-delta rule.

```js
async function prepareCabSalesCandidate({ candidate, previousDays }) {
  const validation = validateImportCandidate({ candidate, previousDays });
  const issues = [...(candidate.issues || []), ...validation.issues];
  if (!validation.ok) {
    return {
      imported: 0,
      dates: candidate.days.map(day => day.date),
      status: 'blocked',
      previousDataPreserved: true,
      issues,
      candidate,
    };
  }
  return { ...candidate, candidate, issues };
}
```

No catalog, advertising or sales write may occur before this branch. Keep `importCabSalesFromRows()` as a compatibility wrapper that calls `buildCabSalesCandidate()`, validates with `prepareCabSalesCandidate()`, and calls `applyCabSalesCandidate()` only for `provisional/verified` results. Export all three functions for focused tests.

- [ ] **Step 5: Apply all candidates under the existing advisory lock**

Implement `applyCabSalesCandidate(pool, cab, candidate, options)`. Inside one transaction, preserve this order:

1. `BEGIN`;
2. `pg_advisory_xact_lock(cab.id)`;
3. re-read prior control totals for candidate dates and abort if they changed since validation;
4. `persistCatalogCandidate()`;
5. `persistAdvertCandidate()`;
6. delete/replace manager details for accepted dates;
7. upsert `wb_sales`;
8. upsert `wb_manager_sales` and insert details;
9. `finishImportRun()` using the same client and the final accepted result;
10. `recordImportDays()` using the same client;
11. `COMMIT`.

Use `ROLLBACK` for every error. Remove any whole-period destructive advertising delete.

- [ ] **Step 6: Determine visible status deterministically**

Add and test:

```js
function acceptedImportStatus(dates, now = new Date()) {
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const cutoff = yesterday.toISOString().split('T')[0];
  return dates.some(date => date >= cutoff) ? 'provisional' : 'verified';
}
```

Use UTC consistently with existing scheduler date keys.

- [ ] **Step 7: Run focused tests**

Run:

```bash
node --test test/wbImportValidation.test.js test/wbImportFlow.test.js
node --check wb.js
```

Expected: all tests PASS and syntax check exits `0`.

---

### Task 6: Add Bounded Retries and Complete Run Lifecycle

**Files:**

- Modify: `backend/wb.js:35-105`
- Modify: `backend/wb.js:732-834`
- Modify: `backend/scheduler.js:55-137`
- Modify: `backend/scripts/backfill-current-sales.js`
- Modify: `backend/test/wbImportFlow.test.js`

- [ ] **Step 1: Write failing retry tests**

Export a small `runValidatedAttempts()` helper and test it independently:

```js
test('принимает третью попытку после двух подозрительных ответов', async () => {
  let calls = 0;
  const result = await runValidatedAttempts({
    maxAttempts: 3,
    delayFn: async () => {},
    attemptFn: async () => {
      calls++;
      return calls < 3 ? { status: 'blocked', issues: [{ severity: 'critical' }] } : { status: 'verified', issues: [] };
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.status, 'verified');
  assert.equal(result.attempts, 3);
});

test('останавливается после трёх подозрительных ответов', async () => {
  let calls = 0;
  const result = await runValidatedAttempts({
    maxAttempts: 3,
    delayFn: async () => {},
    attemptFn: async () => { calls++; return { status: 'blocked', issues: [{ severity: 'critical' }] }; },
  });
  assert.equal(calls, 3);
  assert.equal(result.status, 'blocked');
});
```

- [ ] **Step 2: Implement bounded validation retries**

Implement the helper with initial attempt plus two retries. Do not retry successful `provisional/verified` results. For HTTP `429`, reuse the existing retry delay and `Retry-After` support in `fetchWithRetry`; do not multiply the Advert API's internal five-attempt 429 loop by another five-attempt loop.

- [ ] **Step 3: Wrap `importCabSales()` in a journal lifecycle**

The orchestration must follow this structure:

```js
const run = await startImportRun(pool, { cabId: cab.id, dateFrom, dateTo });
try {
  const prepared = await runValidatedAttempts({
    maxAttempts: 3,
    delayFn: delay,
    attemptFn: async attempt => prepareImportAttempt(pool, cab, dateFrom, dateTo, opts, attempt),
  });
  let result;
  if (prepared.status === 'blocked' || prepared.noChanges) {
    result = prepared;
    await finishImportRun(pool, run.id, result);
    await recordImportDays(pool, {
      cabId: cab.id,
      runId: run.id,
      dates: result.dates.length ? result.dates : requestedDateKeys(dateFrom, dateTo),
      status: result.status,
      issues: result.issues,
    });
  } else {
    result = await applyCabSalesCandidate(pool, cab, prepared.candidate, {
      dateFrom, dateTo, runId: run.id,
    });
  }
  return { ...result, runId: run.id };
} catch (error) {
  const failed = failedImportResult(error);
  await finishImportRun(pool, run.id, failed);
  await recordImportDays(pool, {
    cabId: cab.id, runId: run.id, dates: requestedDateKeys(dateFrom, dateTo),
    status: 'failed', issues: failed.issues,
  });
  throw error;
}
```

`failedImportResult()` stores only error class and message, never stack traces, tokens, headers or payloads.

`prepareImportAttempt()` must also handle a valid empty response explicitly:

```js
if (!source.acceptedRows.length) {
  const previousDays = await loadPreviousDays(pool, cab.id, dateFrom, dateTo);
  if (previousDays.some(day => day.qty !== 0 || day.rev !== 0 || day.cost !== 0)) {
    return blockedResult('empty_response_would_replace_existing_data', source);
  }
  return acceptedEmptyResult({
    status: acceptedImportStatus(requestedDateKeys(dateFrom, dateTo)),
    dates: requestedDateKeys(dateFrom, dateTo),
    noChanges: !advertCandidate.rows.length,
    candidate: buildAdsOnlyCandidate(advertCandidate, projectedAds),
    source,
  });
}
```

An accepted empty result records status and metrics. If there is confirmed advertising spend, `buildAdsOnlyCandidate()` applies the advertising candidate and creates only the necessary `source='wb_ads'` daily rows. If there is no financial or advertising data, `noChanges` is true and no zero `wb_sales` rows are inserted.

- [ ] **Step 4: Merge operational sales into the same candidate path**

Change `importCabOperationalSales()` into `fetchCabOperationalRows()`: it fetches and normalizes `supplier/sales` but performs no writes. Add operational rows only for dates where accepted financial report rows are absent. Build and validate one combined candidate, with source `wb` taking precedence over `wb_operational`. This removes the current second write after the financial transaction.

- [ ] **Step 5: Ensure scheduler records blocked results without treating them as success**

Change each range result from `{ imported }` to:

```js
cabResult.ranges.push({
  ...range,
  runId: r.runId,
  status: r.status,
  imported: r.imported ?? 0,
  previousDataPreserved: Boolean(r.previousDataPreserved),
  issues: r.issues || [],
});
```

Continue to the next cabinet even when a range is blocked. Preserve the existing outer error handling for network/system errors.

- [ ] **Step 6: Update backfill output and exit behavior**

Print `runId`, `status`, `attempts`, counts and issue codes for each cabinet. Set a non-zero process exit code only for system failures; a completed backfill with blocked cabinets must print a clear summary and preserve old data.

- [ ] **Step 7: Run retry, scheduler and full tests**

Run:

```bash
node --test test/wbImportFlow.test.js
npm test
node --check scheduler.js
node --check scripts/backfill-current-sales.js
```

Expected: all tests PASS and checks exit `0`.

---

### Task 7: Repair Existing Automatic Accessory Catalog Rows

**Files:**

- Modify: `backend/migrate.js:10-59`
- Modify: `backend/catalogTemplates.js`
- Modify: `backend/test/catalogTemplates.test.js`

- [ ] **Step 1: Add a failing pure repair-plan test**

Extract a pure helper `accessoryCatalogRepair(row)` from `migrate.js` or, preferably, `catalogTemplates.js` so it can be tested without a database:

```js
test('обнуляет параметры автоматической карточки аксессуара', () => {
  assert.deepEqual(accessoryCatalogRepair({
    article: 'almg_bg_batareika_1', source: 'wb', cost: 16000, w: 30, d: 20, h: 10,
  }), { cost: 0, w: 0, d: 0, h: 0 });
});

test('не меняет ручную карточку аксессуара', () => {
  assert.equal(accessoryCatalogRepair({
    article: 'almg_bg_batareika_1', source: 'manual', cost: 2500, w: 10, d: 8, h: 6,
  }), null);
});
```

- [ ] **Step 2: Implement conservative repair logic**

Return zero parameters only when `isAccessoryArticle(article)` is true and `source !== 'manual'`. Do not change `name`, `article`, `subject` or a manual cost.

- [ ] **Step 3: Apply repair in migration**

After catalog schema creation, select non-manual rows with an article, compute repairs in JavaScript and execute:

```sql
UPDATE catalog SET cost=0, w=0, d=0, h=0, updated_at=NOW() WHERE id=$1
```

This makes current data compatible with the new hard accessory invariant before the first validated import.

- [ ] **Step 4: Run tests and migration against Docker PostgreSQL**

Run:

```bash
npm test
DATABASE_URL=postgresql://sait_user:sait_pass@localhost:5433/sait_db PGSSLMODE=disable node migrate.js
```

Expected: tests PASS; migration completes without errors and reports repaired automatic accessory rows without printing catalog contents.

---

### Task 8: Add Import Status APIs

**Files:**

- Modify: `backend/index.js:1199-1240`
- Modify: `my-react-app/src/api.js:56-65`
- Create or modify: `backend/test/wbImportFlow.test.js`

- [ ] **Step 1: Define query parsing tests for safe limits and filters**

Extract and export `parseImportRunFilters(query)` from a small testable section of `index.js` or a helper module. Test that invalid `limit` becomes `50`, the maximum is `200`, and absent `cabId/dateFrom/dateTo` become `null`.

- [ ] **Step 2: Implement `GET /api/wb/import-runs`**

Use parameterized SQL and return at most 200 rows:

```sql
SELECT r.id, r.cab_id, c.name AS cab_name,
       r.requested_from::text, r.requested_to::text,
       r.actual_from::text, r.actual_to::text,
       r.status, r.attempts, r.fetched_rows, r.accepted_rows, r.rejected_rows,
       r.source_metrics, r.candidate_metrics, r.issues,
       r.started_at, r.finished_at
FROM wb_import_runs r
JOIN cabs c ON c.id=r.cab_id
WHERE ($1::int IS NULL OR r.cab_id=$1)
  AND ($2::date IS NULL OR r.requested_to >= $2)
  AND ($3::date IS NULL OR r.requested_from <= $3)
ORDER BY r.started_at DESC
LIMIT $4
```

- [ ] **Step 3: Implement `GET /api/wb/import-status`**

Return one latest attempt per cabinet plus accepted and attempted day status. Do not select `wb_token` or any source payload.

- [ ] **Step 4: Mark stale `running` rows failed on startup**

After schema creation, execute:

```sql
UPDATE wb_import_runs
SET status='failed', finished_at=NOW(),
    issues='[{"code":"backend_restarted","severity":"critical","message":"Backend перезапущен до завершения импорта"}]'::jsonb
WHERE status='running' AND started_at < NOW() - INTERVAL '30 minutes'
```

- [ ] **Step 5: Add frontend API methods**

Add:

```js
getImportRuns: ({ cabId, dateFrom, dateTo, limit = 50 } = {}) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cabId) params.set('cabId', cabId);
  if (dateFrom) params.set('dateFrom', dateFrom);
  if (dateTo) params.set('dateTo', dateTo);
  return req('GET', `/wb/import-runs?${params}`);
},
getImportStatus: () => req('GET', '/wb/import-status'),
```

- [ ] **Step 6: Verify API syntax and smoke endpoints**

Run:

```bash
node --check index.js
npm test
```

After rebuilding backend, smoke:

```bash
curl --fail --silent http://localhost:3000/api/wb/import-status
curl --fail --silent 'http://localhost:3000/api/wb/import-runs?limit=5'
```

Expected: JSON responses with no token fields.

---

### Task 9: Show Reliable Import Health in the Admin UI

**Files:**

- Modify: `my-react-app/src/App.jsx:740-769`
- Modify: `my-react-app/src/App.jsx:807-815`
- Modify: `my-react-app/src/App.jsx:1013-1032`
- Modify: `my-react-app/src/styles.css` only if existing utility classes cannot express the status layout

- [ ] **Step 1: Load scheduler and persistent import status together**

Replace the polling body with `Promise.all`:

```js
const [scheduler, imports] = await Promise.all([
  api.getSchedulerStatus(),
  api.getImportStatus(),
]);
if (mounted) {
  setSchedulerStatus(scheduler);
  setImportStatus(imports);
}
```

Keep the 60-second UI polling interval. This polls only the local backend/PostgreSQL.

- [ ] **Step 2: Render consistent Russian status labels**

Use one map:

```js
const IMPORT_STATUS = {
  provisional: { label: 'Предварительно', className: 'badge-blue' },
  verified: { label: 'Проверено', className: 'badge-green' },
  blocked: { label: 'Заблокировано', className: 'badge-red' },
  failed: { label: 'Заблокировано', className: 'badge-red' },
  running: { label: 'Выполняется', className: 'badge-blue' },
};
```

For each cabinet show status, requested/actual period, counts, attempts and the first issue message. A blocked card must include `Прежние данные сохранены`.

- [ ] **Step 3: Make manual import result truthful**

Replace the unconditional success alert with:

```js
if (result.status === 'blocked' || result.status === 'failed') {
  alert(`Импорт заблокирован. Прежние данные сохранены.\n${result.issues?.[0]?.message || 'Проверка не пройдена'}`);
} else {
  alert(`Импорт завершён: ${result.imported || 0} дней. Статус: ${IMPORT_STATUS[result.status]?.label || result.status}`);
}
```

Refresh import status after the manual request completes.

- [ ] **Step 4: Verify frontend quality gates**

Run:

```bash
npm run lint
npm run build
```

Expected: lint and build PASS. If lint reports pre-existing unrelated errors, record them separately and run `npx eslint src/App.jsx src/api.js` to prove changed files are clean.

---

### Task 10: End-to-End Migration, Backfill Smoke and Report Reconciliation

**Files:**

- Verification: all changed files
- Modify only if verification exposes a defect in the implementation

- [ ] **Step 1: Run all static and automated checks**

Run:

```bash
node --check wb.js
node --check wbImportValidation.js
node --check wbImportJournal.js
node --check scheduler.js
node --check index.js
npm test
```

Expected: every command exits `0`.

- [ ] **Step 2: Apply migration against Docker PostgreSQL**

Run:

```bash
DATABASE_URL=postgresql://sait_user:sait_pass@localhost:5433/sait_db PGSSLMODE=disable node migrate.js
```

Expected: migration succeeds idempotently; no secrets are printed.

- [ ] **Step 3: Rebuild and start backend**

Run from repository root:

```bash
docker compose --env-file .env.docker up -d --build backend
docker compose --env-file .env.docker ps
```

Expected: database healthy, backend and frontend running.

- [ ] **Step 4: Run a small closed-period import**

Choose one cabinet with a configured token and a previously known closed date. Run the existing backfill script for one day. Do not print tokens or database rows containing them.

Expected output contains `runId`, `verified` or an explicit `blocked`, attempt counts and issue codes.

- [ ] **Step 5: Prove a blocked candidate preserves prior values**

Use a test fixture or dedicated test-only invocation, not production WB data, to trigger `historical_delta_exceeded`. Compare control totals before and after.

Expected: totals are byte-for-byte unchanged and the run status is `blocked`.

- [ ] **Step 6: Reconcile every report and dashboard**

Run:

```bash
node scripts/check-report-consistency.js http://localhost:3000/api 2026-07-25 2026-08-01 all
```

Then compare dashboard totals to daily totals for `rev/cost/comm/ads/cab_comm/log_f/log_r/ret/profit`.

Expected: consistency script returns `"ok": true`; dashboard and daily totals match within 0.01.

- [ ] **Step 7: Confirm UI reads do not call WB**

Open the dashboard and admin pages repeatedly while watching backend logs.

Expected: only local `/api/...` reads appear; no new `reportDetailByPeriod`, `supplier/sales` or Advert API log entries occur until scheduler/manual import runs.

- [ ] **Step 8: Run frontend verification and inspect final diff**

Run:

```bash
npm run lint
npm run build
git diff --check
git status --short
```

Expected: build succeeds, changed frontend files lint cleanly, diff check is empty, and only intended files are reported. Do not alter unrelated dirty-worktree files.
