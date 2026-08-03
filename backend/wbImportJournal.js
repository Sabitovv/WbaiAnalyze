const SAFE_DETAIL_KEYS = [
  'count',
  'date',
  'metric',
  'metrics',
  'userId',
  'rowIndex',
  'rowIndexes',
  'scope',
  'index',
  'article',
];
const AGGREGATE_METRIC_KEYS = new Set([
  'qty', 'rev', 'ads', 'cost', 'comm', 'cabComm', 'logF', 'logR', 'ret', 'profit', 'margin', 'drr',
  'rows', 'count', 'fetchedRows', 'acceptedRows', 'rejectedRows', 'campaigns',
  'requestedCampaigns', 'returnedCampaigns',
]);
const TERMINAL_IMPORT_STATUSES = new Set(['provisional', 'verified', 'blocked', 'failed']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeScalar(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function safeDetailValue(value) {
  if (!Array.isArray(value)) return safeScalar(value);
  return value.map(safeScalar).filter(item => item !== undefined);
}

function redactIssueMessage(message) {
  const wbStatus = message.match(/^\s*WB(?:\s+https?:\/\/\S+)?\s+(\d{3})(?:\s+[A-Za-z][A-Za-z -]{0,60})?\s*:/i);
  if (wbStatus) return `WB ${wbStatus[1]}`;

  const httpStatus = message.match(/^\s*(HTTP\s+\d{3}(?:\s+[A-Za-z][A-Za-z -]{0,60})?)\s*:/i);
  if (httpStatus) return httpStatus[1].trim().slice(0, 500);

  const redacted = message
    .replace(/\b(response|body|payload)(\s*:\s*)[\s\S]*$/i, '$1$2[REDACTED]')
    .replace(
      /\b(authorization)(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+|[^\s,;]+)/gi,
      '$1$2[REDACTED]'
    )
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    .replace(
      /\b((?:(?:access|refresh)[_-]?)?token|api[_-]?key|apikey|key|secret)(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      '$1$2[REDACTED]'
    )
    .replace(/\b(?:eyJ[A-Za-z0-9_-]*|[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
  return redacted.length > 500 ? `${redacted.slice(0, 497)}...` : redacted;
}

function sanitizeIssues(issues) {
  if (!Array.isArray(issues)) return [];

  const sanitized = [];
  for (const issue of issues) {
    if (!isPlainObject(issue)) continue;

    const safeIssue = {};
    for (const key of ['code', 'severity', 'message']) {
      if (!Object.prototype.hasOwnProperty.call(issue, key)) continue;
      let value = safeScalar(issue[key]);
      if (key === 'message' && typeof value === 'string') value = redactIssueMessage(value);
      if (value !== undefined) safeIssue[key] = value;
    }

    if (isPlainObject(issue.details)) {
      const details = {};
      for (const key of SAFE_DETAIL_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(issue.details, key)) continue;
        const value = safeDetailValue(issue.details[key]);
        if (value !== undefined) details[key] = value;
      }
      if (Object.keys(details).length) safeIssue.details = details;
    }

    if (Object.keys(safeIssue).length) sanitized.push(safeIssue);
  }
  return sanitized;
}

function safeCount(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function isCanonicalDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function sanitizeAggregateMetrics(value) {
  if (!isPlainObject(value)) return {};
  const sanitized = {};
  for (const [key, item] of Object.entries(value)) {
    if (!AGGREGATE_METRIC_KEYS.has(key)) continue;
    if (key === 'rows') {
      if (typeof item === 'number' && Number.isFinite(item)) sanitized[key] = item;
    } else if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
      sanitized[key] = item;
    }
  }
  return sanitized;
}

function safeMetrics(value) {
  if (!isPlainObject(value)) return {};
  const sanitized = sanitizeAggregateMetrics(value);

  if (Array.isArray(value.dates)) {
    sanitized.dates = value.dates.filter(isCanonicalDate);
  }

  if (isPlainObject(value.byDate)) {
    const byDate = {};
    for (const [date, metrics] of Object.entries(value.byDate)) {
      if (!isCanonicalDate(date) || !isPlainObject(metrics)) continue;
      const safeDay = sanitizeAggregateMetrics(metrics);
      if (Object.keys(safeDay).length) byDate[date] = safeDay;
    }
    if (Object.keys(byDate).length) sanitized.byDate = byDate;
  }

  if (isPlainObject(value.totals)) {
    const totals = sanitizeAggregateMetrics(value.totals);
    if (Object.keys(totals).length) sanitized.totals = totals;
  }

  return sanitized;
}

async function startImportRun(db, { cabId, dateFrom, dateTo }) {
  const { rows } = await db.query(
    `INSERT INTO wb_import_runs (cab_id, requested_from, requested_to, status)
     VALUES ($1, $2, $3, 'running')
     RETURNING id`,
    [cabId, dateFrom, dateTo]
  );
  return { id: rows[0].id };
}

async function finishImportRun(db, runId, result = {}) {
  const outcome = isPlainObject(result) ? result : {};
  if (!TERMINAL_IMPORT_STATUSES.has(outcome.status)) {
    throw new Error('finishImportRun status must be one of: provisional, verified, blocked, failed');
  }
  const dates = Array.isArray(outcome.dates) ? [...outcome.dates].sort() : [];
  const actualFrom = dates[0] || null;
  const actualTo = dates.at(-1) || null;

  const { rows } = await db.query(
    `UPDATE wb_import_runs
     SET actual_from=$2, actual_to=$3, status=$4, attempts=$5,
         fetched_rows=$6, accepted_rows=$7, rejected_rows=$8, source_metrics=$9::jsonb,
         candidate_metrics=$10::jsonb, issues=$11::jsonb, finished_at=NOW()
     WHERE id=$1 AND status='running'
     RETURNING id`,
    [
      runId,
      actualFrom,
      actualTo,
      outcome.status,
      safeCount(outcome.attempts, 1),
      safeCount(outcome.fetchedRows, 0),
      safeCount(outcome.acceptedRows, 0),
      safeCount(outcome.rejectedRows, 0),
      JSON.stringify(safeMetrics(outcome.sourceMetrics)),
      JSON.stringify(safeMetrics(outcome.candidateMetrics)),
      JSON.stringify(sanitizeIssues(outcome.issues)),
    ]
  );
  return { updated: rows.length > 0 };
}

async function recordImportDays(db, { cabId, runId, dates, status, issues }) {
  const sanitizedIssues = JSON.stringify(sanitizeIssues(issues));
  if (status === 'provisional' || status === 'verified') {
    const { rows } = await db.query(
      `INSERT INTO wb_import_days
       (cab_id, date, accepted_run_id, accepted_status, accepted_at,
        last_attempt_run_id, last_attempt_status, checked_at, issues)
       SELECT r.cab_id, input.date::date, r.id, r.status, NOW(), r.id, r.status, NOW(), $5::jsonb
       FROM wb_import_runs r
       CROSS JOIN unnest($2::text[]) AS input(date)
       WHERE r.id=$3 AND r.cab_id=$1 AND r.status=$4
       ON CONFLICT (cab_id, date) DO UPDATE SET
         accepted_run_id=EXCLUDED.accepted_run_id,
         accepted_status=EXCLUDED.accepted_status,
         accepted_at=NOW(),
         last_attempt_run_id=EXCLUDED.last_attempt_run_id,
         last_attempt_status=EXCLUDED.last_attempt_status,
         checked_at=NOW(),
         issues=EXCLUDED.issues
       RETURNING cab_id, date`,
      [cabId, dates, runId, status, sanitizedIssues]
    );
    return { updated: rows.length };
  } else {
    const { rows } = await db.query(
      `INSERT INTO wb_import_days
       (cab_id, date, last_attempt_run_id, last_attempt_status, checked_at, issues)
       SELECT r.cab_id, input.date::date, r.id, r.status, NOW(), $5::jsonb
       FROM wb_import_runs r
       CROSS JOIN unnest($2::text[]) AS input(date)
       WHERE r.id=$3 AND r.cab_id=$1 AND r.status=$4
       ON CONFLICT (cab_id, date) DO UPDATE SET
         last_attempt_run_id=EXCLUDED.last_attempt_run_id,
         last_attempt_status=EXCLUDED.last_attempt_status,
         checked_at=NOW(),
         issues=EXCLUDED.issues
       RETURNING cab_id, date`,
      [cabId, dates, runId, status, sanitizedIssues]
    );
    return { updated: rows.length };
  }
}

async function loadPreviousDays(db, cabId, dateFrom, dateTo) {
  const { rows } = await db.query(
    `SELECT s.date::text AS date, COALESCE(d.qty, 0)::numeric AS qty, s.rev, s.cost
     FROM wb_sales s
     LEFT JOIN (
       SELECT cab_id, date, SUM(qty) AS qty
       FROM wb_manager_sales_detail
       WHERE cab_id=$1 AND date BETWEEN $2 AND $3
       GROUP BY cab_id, date
     ) d ON d.cab_id=s.cab_id AND d.date=s.date
     WHERE s.cab_id=$1 AND s.date BETWEEN $2 AND $3
     ORDER BY s.date`,
    [cabId, dateFrom, dateTo]
  );
  return rows.map(row => ({
    ...row,
    qty: Number(row.qty),
    rev: Number(row.rev),
    cost: Number(row.cost),
  }));
}

module.exports = { startImportRun, finishImportRun, recordImportDays, loadPreviousDays };
