const { isAccessoryArticle } = require('./catalogTemplates');

const DAY_METRICS = [
  'qty', 'rev', 'ads', 'cost', 'comm', 'cabComm', 'logF', 'logR', 'ret', 'profit', 'margin', 'drr',
];
const MANAGER_METRICS = DAY_METRICS;
const ROLLUP_METRICS = ['qty', 'rev', 'ads', 'cost', 'comm'];
const IMPORT_TOLERANCE = 0.01;

function firstPresent(values) {
  return values.find(value => value !== null && value !== undefined && String(value).trim() !== '');
}

function rowArticle(row) {
  const value = firstPresent([row?.sa_name, row?.supplier_article, row?.supplierArticle]);
  return value === undefined ? '' : String(value).trim();
}

function rowDate(row) {
  return firstPresent([row?.sale_dt, row?.order_dt, row?.date_from]);
}

function financialDocument(row) {
  return ['продажа', 'возврат'].includes(String(row?.doc_type_name || '').trim().toLowerCase());
}

function hasFinancialSignals(row) {
  if (!row || typeof row !== 'object') return false;
  return [
    'sale_dt', 'order_dt', 'date_from',
    'sa_name', 'supplier_article', 'supplierArticle',
    'quantity', 'retail_amount', 'rrd_id', 'rrdId',
  ].some(field => Object.prototype.hasOwnProperty.call(row, field));
}

function finiteNumber(value) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return false;
  return Number.isFinite(Number(value));
}

function dateKey(value) {
  if (typeof value !== 'string') return null;
  const key = value.match(/^(\d{4}-\d{2}-\d{2})(?:$|T)/)?.[1];
  if (!key) return null;
  const date = new Date(`${key}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== key) return null;
  return key;
}

function issue(code, severity, message, details) {
  return { code, severity, message, details };
}

function prepareFinancialRows({ rows, dateFrom, dateTo } = {}) {
  if (!Array.isArray(rows)) {
    return {
      ok: false,
      acceptedRows: [],
      fetchedRows: 0,
      rejectedRows: 0,
      issues: [issue(
        'invalid_response_shape',
        'critical',
        'Ответ Wildberries должен быть массивом строк.',
        { receivedType: rows === null ? 'null' : typeof rows },
      )],
    };
  }

  const fromKey = dateKey(dateFrom);
  const toKey = dateKey(dateTo);
  if ((dateFrom !== undefined && !fromKey)
    || (dateTo !== undefined && !toKey)
    || (fromKey && toKey && fromKey > toKey)) {
    return {
      ok: false,
      acceptedRows: [],
      fetchedRows: rows.length,
      rejectedRows: rows.length,
      issues: [issue(
        'invalid_requested_range',
        'critical',
        'Запрошенный период должен содержать корректные границы.',
        {},
      )],
    };
  }

  const acceptedRows = [];
  const issues = [];
  const seenRrdIds = new Set();
  const duplicateIndexes = [];
  let financialRows = 0;
  let structurallyValidRows = 0;
  let serviceRows = 0;
  let outOfRangeRows = 0;

  rows.forEach((row, rowIndex) => {
    const docType = String(row?.doc_type_name || '').trim();
    if (!docType) {
      const hasSignals = hasFinancialSignals(row);
      const qty = Number(row?.quantity ?? 0);
      const article = rowArticle(row);
      if (!hasSignals || Number.isNaN(qty) || qty === 0 || !article) {
        serviceRows += 1;
        return;
      }
      issues.push(issue(
        'inferred_document_type',
        'warning',
        'У финансовой строки отсутствует тип документа — трактуется как Продажа.',
        { rowIndex },
      ));
    } else if (!financialDocument(row)) {
      serviceRows += 1;
      return;
    }
    financialRows += 1;

    const rrdId = row?.rrd_id ?? row?.rrdId;
    if (rrdId !== null && rrdId !== undefined) {
      const key = String(rrdId);
      if (seenRrdIds.has(key)) duplicateIndexes.push(rowIndex);
      else seenRrdIds.add(key);
    }

    const currentDateKey = dateKey(rowDate(row));
    const article = rowArticle(row);
    const quantityValid = finiteNumber(row?.quantity) && Number(row.quantity) !== 0;
    const retailAmountValid = finiteNumber(row?.retail_amount);

    if (!currentDateKey) {
      issues.push(issue('missing_date', 'critical', 'У финансовой строки отсутствует корректная дата.', { rowIndex }));
    }
    if (!article) {
      issues.push(issue('missing_article', 'warning', 'У финансовой строки отсутствует артикул.', { rowIndex }));
    }
    if (!quantityValid) {
      issues.push(issue('invalid_quantity', 'warning', 'Количество должно быть конечным ненулевым числом.', { rowIndex }));
    }
    if (!retailAmountValid) {
      issues.push(issue('invalid_retail_amount', 'warning', 'Сумма продажи должна быть конечным числом.', { rowIndex }));
    }
    if (!currentDateKey || !article || !quantityValid || !retailAmountValid) return;

    structurallyValidRows += 1;
    if ((fromKey && currentDateKey < fromKey) || (toKey && currentDateKey > toKey)) {
      outOfRangeRows += 1;
      return;
    }
    acceptedRows.push(row);
  });

  if (serviceRows > 0) {
    issues.push(issue(
      'service_rows_skipped',
      'warning',
      'Сервисные строки не участвуют в финансовом импорте.',
      { count: serviceRows },
    ));
  }
  if (outOfRangeRows > 0) {
    issues.push(issue(
      'out_of_range_rows',
      'warning',
      'Строки вне запрошенного периода исключены.',
      { count: outOfRangeRows },
    ));
  }
  if (financialRows > 0 && structurallyValidRows > 0 && outOfRangeRows === structurallyValidRows) {
    issues.push(issue(
      'no_rows_in_requested_range',
      'critical',
      'В запрошенном периоде нет финансовых строк.',
      { count: outOfRangeRows },
    ));
  }
  if (duplicateIndexes.length > 0) {
    issues.push(issue(
      'duplicate_rrd_id',
      'critical',
      'Обнаружены повторяющиеся идентификаторы финансовых строк.',
      { count: duplicateIndexes.length, rowIndexes: duplicateIndexes },
    ));
  }

  return {
    ok: !issues.some(item => item.severity === 'critical'),
    acceptedRows,
    fetchedRows: rows.length,
    rejectedRows: rows.length - acceptedRows.length,
    issues,
  };
}

function candidateDate(row) {
  const value = row?.date;
  return dateKey(value) || (value === null || value === undefined ? null : String(value));
}

function safeUserId(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  return value === undefined ? null : String(value);
}

function validateCandidateMetrics(rows, metrics, issues) {
  for (const row of rows) {
    for (const metric of metrics) {
      if (finiteNumber(row?.[metric])) continue;
      issues.push(issue(
        'non_finite_candidate_value',
        'critical',
        'Числовое значение кандидата должно быть конечным.',
        { date: candidateDate(row), metric },
      ));
    }
  }
}

function emptyTotals() {
  return Object.fromEntries(ROLLUP_METRICS.map(metric => [metric, 0]));
}

function reportAggregateOverflow(date, metric, issues, reportedOverflows) {
  const key = `${date}\0${metric}`;
  if (reportedOverflows.has(key)) return;
  reportedOverflows.add(key);
  issues.push(issue(
    'non_finite_candidate_value',
    'critical',
    'Сумма конечных значений кандидата вышла за допустимый диапазон.',
    { date, metric },
  ));
}

function addToTotals(current, row, date, issues, reportedOverflows) {
  for (const metric of ROLLUP_METRICS) {
    if (!finiteNumber(row?.[metric]) || !Number.isFinite(current[metric])) {
      current[metric] = NaN;
      continue;
    }
    const total = current[metric] + Number(row[metric]);
    if (!Number.isFinite(total)) {
      current[metric] = NaN;
      reportAggregateOverflow(date, metric, issues, reportedOverflows);
    } else {
      current[metric] = total;
    }
  }
}

function aggregateByDate(rows, issues, reportedOverflows) {
  const totals = new Map();
  for (const row of rows) {
    const date = candidateDate(row);
    const current = totals.get(date) || emptyTotals();
    addToTotals(current, row, date, issues, reportedOverflows);
    totals.set(date, current);
  }
  return totals;
}

function aggregateByManager(rows, issues, reportedOverflows) {
  const totals = new Map();
  for (const row of rows) {
    const date = candidateDate(row);
    const userId = row?.userId;
    const dateTotals = totals.get(date) || new Map();
    const current = dateTotals.get(userId) || emptyTotals();
    addToTotals(current, row, date, issues, reportedOverflows);
    dateTotals.set(userId, current);
    totals.set(date, dateTotals);
  }
  return totals;
}

function differs(left, right) {
  return Math.abs(Number(left) - Number(right)) > IMPORT_TOLERANCE + 1e-9;
}

function canonicalCandidateDate(value) {
  return typeof value === 'string' && dateKey(value) === value;
}

function validateCandidateStructure(days, details, managerDays, issues) {
  const dayDates = new Set();
  for (const [index, day] of days.entries()) {
    if (!canonicalCandidateDate(day?.date)) {
      issues.push(issue(
        'invalid_candidate_date',
        'critical',
        'Дата кандидата должна иметь формат YYYY-MM-DD.',
        { scope: 'days', index },
      ));
      continue;
    }
    if (dayDates.has(day.date)) {
      issues.push(issue(
        'duplicate_candidate_day',
        'critical',
        'Для даты кандидата допустим только один итог дня.',
        { index },
      ));
    } else {
      dayDates.add(day.date);
    }
  }

  const detailKeys = new Map();
  for (const [index, detail] of details.entries()) {
    const article = String(detail?.article ?? '').trim();
    if (!canonicalCandidateDate(detail?.date)) {
      issues.push(issue(
        'invalid_candidate_date',
        'critical',
        'Дата кандидата должна иметь формат YYYY-MM-DD.',
        { scope: 'details', index },
      ));
    }
    if (!article) {
      issues.push(issue(
        'invalid_detail_key',
        'critical',
        'Ключ детализации должен содержать артикул.',
        { index },
      ));
    }
    if (!canonicalCandidateDate(detail?.date) || !article) continue;
    if (!dayDates.has(detail.date)) {
      issues.push(issue(
        'orphan_candidate_date',
        'critical',
        'Дата детализации отсутствует в итогах кандидата.',
        { scope: 'details', index },
      ));
      continue;
    }

    const dateKeys = detailKeys.get(detail.date) || new Map();
    const articles = dateKeys.get(detail?.userId) || new Set();
    if (articles.has(article)) {
      issues.push(issue(
        'duplicate_detail_key',
        'critical',
        'Ключ детализации должен быть уникальным.',
        { index },
      ));
    } else {
      articles.add(article);
      dateKeys.set(detail?.userId, articles);
      detailKeys.set(detail.date, dateKeys);
    }
  }

  const managerKeys = new Map();
  for (const [index, managerDay] of managerDays.entries()) {
    if (!canonicalCandidateDate(managerDay?.date)) {
      issues.push(issue(
        'invalid_candidate_date',
        'critical',
        'Дата кандидата должна иметь формат YYYY-MM-DD.',
        { scope: 'managerDays', index },
      ));
      continue;
    }
    if (!dayDates.has(managerDay.date)) {
      issues.push(issue(
        'orphan_candidate_date',
        'critical',
        'Дата менеджера отсутствует в итогах кандидата.',
        { scope: 'managerDays', index },
      ));
      continue;
    }

    const userIds = managerKeys.get(managerDay.date) || new Set();
    if (userIds.has(managerDay?.userId)) {
      issues.push(issue(
        'duplicate_manager_day',
        'critical',
        'Для менеджера и даты допустим только один агрегат.',
        { index },
      ));
    } else {
      userIds.add(managerDay?.userId);
      managerKeys.set(managerDay.date, userIds);
    }
  }

  return managerKeys;
}

function validateImportCandidate({ candidate, previousDays = [], ignoreHistoricalDelta } = {}) {
  const current = candidate || {};
  const days = Array.isArray(current.days) ? current.days : [];
  const details = Array.isArray(current.details) ? current.details : [];
  const managerDays = Array.isArray(current.managerDays) ? current.managerDays : [];
  const catalogMatches = Array.isArray(current.catalogMatches) ? current.catalogMatches : [];
  const issues = [];

  const managerKeys = validateCandidateStructure(days, details, managerDays, issues);
  if (issues.length > 0) return { ok: false, issues };

  const daysByDate = new Map(days.map(day => [candidateDate(day), day]));
  const adsOnlyDates = new Set();
  for (const value of Array.isArray(current.adsOnlyDates) ? current.adsOnlyDates : []) {
    const day = daysByDate.get(value);
    const financialMetrics = ['qty', 'rev', 'cost', 'comm', 'cabComm', 'logF', 'logR', 'ret'];
    const valid = canonicalCandidateDate(value)
      && !adsOnlyDates.has(value)
      && day
      && financialMetrics.every(metric => finiteNumber(day?.[metric]) && Number(day[metric]) === 0)
      && finiteNumber(day?.ads)
      && finiteNumber(day?.profit)
      && !differs(day.profit, -Number(day.ads))
      && !details.some(detail => candidateDate(detail) === value)
      && !managerDays.some(managerDay => candidateDate(managerDay) === value);
    if (!valid) {
      issues.push(issue(
        'invalid_ads_only_day',
        'critical',
        'День только с рекламой должен содержать нулевые финансовые итоги без детализации.',
        canonicalCandidateDate(value) ? { date: value } : {},
      ));
      continue;
    }
    adsOnlyDates.add(value);
  }

  if (!finiteNumber(current.buyout)) {
    issues.push(issue(
      'non_finite_candidate_value',
      'critical',
      'Числовое значение кандидата должно быть конечным.',
      { metric: 'buyout' },
    ));
  }
  validateCandidateMetrics(days, DAY_METRICS, issues);
  validateCandidateMetrics(details, ROLLUP_METRICS, issues);
  validateCandidateMetrics(managerDays, MANAGER_METRICS, issues);

  const reportedOverflows = new Set();
  const detailTotals = aggregateByDate(details, issues, reportedOverflows);
  for (const day of days) {
    const date = candidateDate(day);
    if (adsOnlyDates.has(date)) continue;
    const totals = detailTotals.get(date) || emptyTotals();
    for (const metric of ROLLUP_METRICS) {
      if (!finiteNumber(day?.[metric]) || !Number.isFinite(totals[metric]) || !differs(day[metric], totals[metric])) continue;
      issues.push(issue(
        'detail_total_mismatch',
        'critical',
        'Сумма детализации не совпадает с итогом дня.',
        { date, metric },
      ));
    }
  }

  const managerTotals = aggregateByManager(details, issues, reportedOverflows);
  for (const managerDay of managerDays) {
    const date = candidateDate(managerDay);
    const dateTotals = managerTotals.get(date);
    if (!dateTotals?.has(managerDay?.userId)) {
      issues.push(issue(
        'manager_total_mismatch',
        'critical',
        'Для агрегата менеджера отсутствует назначенная детализация.',
        { date, userId: safeUserId(managerDay?.userId), metric: 'group' },
      ));
      continue;
    }
    const totals = dateTotals.get(managerDay?.userId);
    for (const metric of ROLLUP_METRICS) {
      if (!finiteNumber(managerDay?.[metric]) || !Number.isFinite(totals[metric])
        || !differs(managerDay[metric], totals[metric])) continue;
      issues.push(issue(
        'manager_total_mismatch',
        'critical',
        'Сумма детализации менеджера не совпадает с агрегатом.',
        { date, userId: safeUserId(managerDay?.userId), metric },
      ));
    }
  }
  for (const [date, dateTotals] of managerTotals) {
    for (const userId of dateTotals.keys()) {
      if (userId === null || userId === undefined || managerKeys.get(date)?.has(userId)) continue;
      issues.push(issue(
        'manager_total_mismatch',
        'critical',
        'Для назначенной детализации отсутствует агрегат менеджера.',
        { date, userId: safeUserId(userId) },
      ));
    }
  }

  const profitInputs = ['rev', 'cost', 'ads', 'comm', 'cabComm', 'logF', 'logR', 'profit'];
  const deductionPct = Number(current.deductionPct) || 0;
  for (const day of days) {
    if (!finiteNumber(current.buyout) || !profitInputs.every(metric => finiteNumber(day?.[metric]))) continue;
    const netRev = Number(day.rev) * Number(current.buyout);
    const expectedProfit = netRev
      - Number(day.cost)
      - Number(day.ads)
      - Number(day.comm)
      - Number(day.cabComm)
      - Number(day.logF)
      - Number(day.logR)
      - netRev * deductionPct / 100
      - (Number(day.storage) || 0)
      - (Number(day.penalty) || 0);
    if (!differs(day.profit, expectedProfit)) continue;
    issues.push(issue(
      'profit_formula_mismatch',
      'critical',
      'Прибыль дня не соответствует формуле импорта.',
      { date: candidateDate(day) },
    ));
  }

  for (const match of catalogMatches) {
    if (!isAccessoryArticle(match?.article) || match?.source === 'manual') continue;
    if (!['cost', 'w', 'd', 'h'].some(metric => Number(match?.[metric]) > 0)) continue;
    issues.push(issue(
      'automatic_accessory_match',
      'critical',
      'Автоматическое сопоставление аксессуара с товаром запрещено.',
      { article: String(match?.article || '') },
    ));
  }

  const candidateDays = new Map(days.map(day => [candidateDate(day), day]));
  const historicalChanges = new Map();
  const historicalThresholds = { qty: 5, rev: 50000, cost: 50000 };
  if (ignoreHistoricalDelta !== true) {
  for (const previousDay of Array.isArray(previousDays) ? previousDays : []) {
    const date = candidateDate(previousDay);
    const day = candidateDays.get(date);
    if (!day) continue;
    for (const [metric, threshold] of Object.entries(historicalThresholds)) {
      if (!finiteNumber(previousDay?.[metric]) || !finiteNumber(day?.[metric])) continue;
      const oldValue = Number(previousDay[metric]);
      if (Math.abs(oldValue) < threshold) continue;
      const relativeChange = Math.abs(Number(day[metric]) - oldValue) / Math.abs(oldValue);
      if (relativeChange <= 0.8) continue;
      const metrics = historicalChanges.get(date) || new Set();
      metrics.add(metric);
      historicalChanges.set(date, metrics);
    }
  }
  for (const [date, metrics] of historicalChanges) {
    issues.push(issue(
      'historical_delta_exceeded',
      'critical',
      'Изменение значимых исторических итогов превышает допустимый порог.',
      { date, metrics: [...metrics] },
    ));
  }
  }

  if (Array.isArray(current.unknownArticles) && current.unknownArticles.length > 0) {
    issues.push(issue(
      'unknown_articles',
      'warning',
      'В импорте есть неизвестные артикулы.',
      { count: current.unknownArticles.length },
    ));
  }
  if (Array.isArray(current.catalogChanges) && current.catalogChanges.length > 0) {
    issues.push(issue(
      'catalog_metadata_changed',
      'warning',
      'Метаданные каталога изменились.',
      { count: current.catalogChanges.length },
    ));
  }

  return {
    ok: !issues.some(item => item.severity === 'critical'),
    issues,
  };
}

module.exports = { prepareFinancialRows, rowArticle, rowDate, validateImportCandidate };
