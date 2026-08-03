const test = require('node:test');
const assert = require('node:assert/strict');
const {
  prepareFinancialRows,
  rowArticle,
  rowDate,
  validateImportCandidate,
} = require('../wbImportValidation');

const range = { dateFrom: '2026-07-01', dateTo: '2026-07-31' };

function financialRow(overrides = {}) {
  return {
    doc_type_name: 'Продажа',
    sale_dt: '2026-07-15T12:00:00Z',
    sa_name: 'article-1',
    quantity: 1,
    retail_amount: 1000,
    rrd_id: 1,
    ...overrides,
  };
}

test('rowArticle and rowDate use the documented fallbacks', () => {
  assert.equal(rowArticle({ supplier_article: ' fallback-article ' }), 'fallback-article');
  assert.equal(rowArticle({ supplierArticle: 'camel-article' }), 'camel-article');
  assert.equal(rowDate({ order_dt: '2026-07-12' }), '2026-07-12');
  assert.equal(rowDate({ date_from: '2026-07-10' }), '2026-07-10');
});

test('accepts a valid sale', () => {
  const row = financialRow();
  const result = prepareFinancialRows({ rows: [row], ...range });

  assert.deepEqual(result, {
    ok: true,
    acceptedRows: [row],
    fetchedRows: 1,
    rejectedRows: 0,
    issues: [],
  });
});

test('accepts a valid return with case and whitespace differences', () => {
  const row = financialRow({ doc_type_name: '  вОзВрАт  ', rrd_id: 2 });
  const result = prepareFinancialRows({ rows: [row], ...range });

  assert.equal(result.ok, true);
  assert.deepEqual(result.acceptedRows, [row]);
  assert.equal(result.rejectedRows, 0);
});

test('accepts zero retail amount', () => {
  const row = financialRow({ retail_amount: 0, rrd_id: 3 });
  const result = prepareFinancialRows({ rows: [row], ...range });

  assert.equal(result.ok, true);
  assert.deepEqual(result.acceptedRows, [row]);
});

test('skips service rows and reports their count', () => {
  const sale = financialRow();
  const service = { doc_type_name: 'Логистика', retail_amount: 300 };
  const result = prepareFinancialRows({ rows: [sale, service], ...range });

  assert.equal(result.ok, true);
  assert.deepEqual(result.acceptedRows, [sale]);
  assert.equal(result.fetchedRows, 2);
  assert.equal(result.rejectedRows, 1);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'service_rows_skipped');
  assert.equal(result.issues[0].severity, 'warning');
  assert.equal(typeof result.issues[0].message, 'string');
  assert.deepEqual(result.issues[0].details, { count: 1 });
});

test('accepts a financial-shaped row with a blank document type as a sale with warning', () => {
  const row = financialRow({ doc_type_name: '   ' });
  const result = prepareFinancialRows({ rows: [row], ...range });

  assert.equal(result.ok, true);
  assert.deepEqual(result.acceptedRows, [row]);
  assert.equal(result.rejectedRows, 0);
  assert.deepEqual(result.issues.map(issue => [issue.code, issue.severity, issue.details]), [
    ['inferred_document_type', 'warning', { rowIndex: 0 }],
  ]);
});

test('filters out-of-range rows while accepting rows inside the inclusive range', () => {
  const beforeRange = financialRow({ sale_dt: '2026-06-30T23:59:59Z', rrd_id: 4 });
  const firstDay = financialRow({ sale_dt: '2026-07-01', rrd_id: 5 });
  const result = prepareFinancialRows({ rows: [beforeRange, firstDay], ...range });

  assert.equal(result.ok, true);
  assert.deepEqual(result.acceptedRows, [firstDay]);
  assert.equal(result.rejectedRows, 1);
  assert.deepEqual(result.issues.map(issue => [issue.code, issue.severity, issue.details]), [
    ['out_of_range_rows', 'warning', { count: 1 }],
  ]);
});

test('preserves the WB source calendar date across timezone offsets', () => {
  const row = financialRow({ sale_dt: '2026-07-01T00:30:00+05:00' });
  const result = prepareFinancialRows({
    rows: [row],
    dateFrom: '2026-07-01',
    dateTo: '2026-07-01',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.acceptedRows, [row]);
  assert.deepEqual(result.issues, []);
});

test('rejects an impossible WB source calendar date', () => {
  const result = prepareFinancialRows({
    rows: [financialRow({ sale_dt: '2026-02-30' })],
    dateFrom: '2026-02-01',
    dateTo: '2026-02-28',
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.acceptedRows, []);
  assert.deepEqual(result.issues.map(issue => [issue.code, issue.severity, issue.details]), [
    ['missing_date', 'critical', { rowIndex: 0 }],
  ]);
});

test('accepts despite malformed article and logs it as a warning', () => {
  const row = financialRow({ sa_name: '   ', rrd_id: 6 });
  const result = prepareFinancialRows({ rows: [row], ...range });

  assert.equal(result.ok, true);
  assert.deepEqual(result.acceptedRows, []);
  assert.equal(result.rejectedRows, 1);
  assert.equal(result.issues[0].code, 'missing_article');
  assert.equal(result.issues[0].severity, 'warning');
  assert.deepEqual(result.issues[0].details, { rowIndex: 0 });
  assert.doesNotMatch(JSON.stringify(result.issues), /article-1|retail_amount|doc_type_name/);
});

test('reports a non-array response as an invalid shape', () => {
  const result = prepareFinancialRows({ rows: { data: [] }, ...range });

  assert.equal(result.ok, false);
  assert.deepEqual(result.acceptedRows, []);
  assert.equal(result.fetchedRows, 0);
  assert.equal(result.rejectedRows, 0);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'invalid_response_shape');
  assert.equal(result.issues[0].severity, 'critical');
  assert.equal(typeof result.issues[0].message, 'string');
  assert.deepEqual(result.issues[0].details, { receivedType: 'object' });
});

test('rejects malformed requested range bounds without exposing them', () => {
  const malformedRanges = [
    { dateFrom: 'not-a-date', dateTo: '2026-07-31' },
    { dateFrom: '2026-07-01', dateTo: '2026-02-30' },
  ];

  for (const requestedRange of malformedRanges) {
    const result = prepareFinancialRows({ rows: [financialRow()], ...requestedRange });

    assert.equal(result.ok, false);
    assert.deepEqual(result.acceptedRows, []);
    assert.equal(result.fetchedRows, 1);
    assert.equal(result.rejectedRows, 1);
    assert.deepEqual(result.issues.map(item => [item.code, item.severity, item.details]), [
      ['invalid_requested_range', 'critical', {}],
    ]);
    assert.doesNotMatch(JSON.stringify(result.issues), /not-a-date|2026-02-30/);
  }
});

test('rejects a requested range whose start is after its end', () => {
  const result = prepareFinancialRows({
    rows: [financialRow()],
    dateFrom: '2026-07-31',
    dateTo: '2026-07-01',
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.acceptedRows, []);
  assert.equal(result.fetchedRows, 1);
  assert.equal(result.rejectedRows, 1);
  assert.deepEqual(result.issues.map(item => [item.code, item.severity, item.details]), [
    ['invalid_requested_range', 'critical', {}],
  ]);
});

test('reports duplicate rrd ids among financial rows', () => {
  const rows = [
    financialRow({ rrd_id: null, rrdId: 'duplicate' }),
    financialRow({ rrd_id: undefined, rrdId: 'duplicate', sa_name: 'article-2' }),
  ];
  const result = prepareFinancialRows({ rows, ...range });

  assert.equal(result.ok, false);
  assert.deepEqual(result.acceptedRows, rows);
  assert.deepEqual(result.issues.map(issue => issue.code), ['duplicate_rrd_id']);
  assert.deepEqual(result.issues[0].details, { count: 1, rowIndexes: [1] });
  assert.doesNotMatch(JSON.stringify(result.issues), /article-1|article-2/);
});

test('rejects non-finite and empty financial numbers', () => {
  const invalidValues = ['Infinity', Infinity, 'NaN', NaN, '', null];

  for (const [index, value] of invalidValues.entries()) {
    const quantityResult = prepareFinancialRows({
      rows: [financialRow({ quantity: value, rrd_id: index + 10 })],
      ...range,
    });
    const amountResult = prepareFinancialRows({
      rows: [financialRow({ retail_amount: value, rrd_id: index + 20 })],
      ...range,
    });

    assert.equal(quantityResult.issues[0].code, 'invalid_quantity');
    assert.equal(amountResult.issues[0].code, 'invalid_retail_amount');
  }
});

test('reports when all structurally valid financial rows are outside the range', () => {
  const rows = [
    financialRow({ sale_dt: '2026-06-01', rrd_id: 30 }),
    financialRow({ sale_dt: '2026-08-01', rrd_id: 31 }),
  ];
  const result = prepareFinancialRows({ rows, ...range });

  assert.equal(result.ok, false);
  assert.deepEqual(result.acceptedRows, []);
  assert.equal(result.rejectedRows, 2);
  assert.deepEqual(result.issues.map(issue => [issue.code, issue.severity, issue.details]), [
    ['out_of_range_rows', 'warning', { count: 2 }],
    ['no_rows_in_requested_range', 'critical', { count: 2 }],
  ]);
});

test('rejects malformed dates and zero quantities with critical issues', () => {
  const result = prepareFinancialRows({
    rows: [
      financialRow({ sale_dt: 'not-a-date', rrd_id: 40 }),
      financialRow({ quantity: 0, rrd_id: 41 }),
    ],
    ...range,
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(issue => issue.code), ['missing_date', 'invalid_quantity']);
  assert.deepEqual(result.issues.map(issue => issue.details), [{ rowIndex: 0 }, { rowIndex: 1 }]);
});

function importCandidate() {
  return {
    buyout: 0.88,
    days: [{
      date: '2026-07-15',
      qty: 10,
      rev: 100000,
      ads: 5000,
      cost: 40000,
      comm: 20000,
      cabComm: 0,
      logF: 2000,
      logR: 100,
      ret: 0,
      profit: 20900,
      margin: 20.9,
      drr: 5,
    }],
    managerDays: [{
      date: '2026-07-15',
      userId: 7,
      qty: 6,
      rev: 60000,
      ads: 3000,
      cost: 24000,
      comm: 12000,
      cabComm: 0,
      logF: 1200,
      logR: 60,
      ret: 0,
      profit: 12540,
      margin: 20.9,
      drr: 5,
    }],
    details: [
      {
        date: '2026-07-15',
        userId: 7,
        article: 'fa_shr_nastya_1',
        qty: 6,
        rev: 60000,
        ads: 3000,
        cost: 24000,
        comm: 12000,
      },
      {
        date: '2026-07-15',
        userId: null,
        article: 'fa_shr_nastya_1',
        qty: 4,
        rev: 40000,
        ads: 2000,
        cost: 16000,
        comm: 8000,
      },
    ],
    catalogMatches: [{
      article: 'fa_shr_nastya_1',
      source: 'inferred',
      cost: 4000,
      w: 20,
      d: 15,
      h: 10,
    }],
  };
}

test('accepts a consistent import candidate', () => {
  assert.deepEqual(validateImportCandidate({ candidate: importCandidate() }), {
    ok: true,
    issues: [],
  });
});

test('rejects non-canonical or invalid candidate dates with scope and index only', () => {
  const cases = [
    ['days', '2026-07-15T00:00:00Z', candidate => { candidate.days[0].date = '2026-07-15T00:00:00Z'; }],
    ['details', '2026-02-30', candidate => { candidate.details[0].date = '2026-02-30'; }],
    ['managerDays', 'bad-manager-date', candidate => { candidate.managerDays[0].date = 'bad-manager-date'; }],
  ];

  for (const [scope, rawDate, mutate] of cases) {
    const candidate = importCandidate();
    mutate(candidate);

    const result = validateImportCandidate({ candidate });
    const invalidDate = result.issues.find(item => item.code === 'invalid_candidate_date');

    assert.equal(result.ok, false);
    assert.deepEqual(invalidDate?.details, { scope, index: 0 });
    assert.doesNotMatch(JSON.stringify(result.issues), new RegExp(rawDate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('rejects duplicate candidate days', () => {
  const candidate = importCandidate();
  candidate.days.push({ ...candidate.days[0] });

  const result = validateImportCandidate({ candidate });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(item => [item.code, item.severity, item.details]), [
    ['duplicate_candidate_day', 'critical', { index: 1 }],
  ]);
});

test('rejects detail and manager dates that have no candidate day', () => {
  const cases = [
    ['details', candidate => { candidate.details[0].date = '2026-07-16'; }],
    ['managerDays', candidate => { candidate.managerDays[0].date = '2026-07-16'; }],
  ];

  for (const [scope, mutate] of cases) {
    const candidate = importCandidate();
    mutate(candidate);

    const result = validateImportCandidate({ candidate });
    const orphan = result.issues.find(item => item.code === 'orphan_candidate_date');

    assert.equal(result.ok, false);
    assert.deepEqual(orphan?.details, { scope, index: 0 });
  }
});

test('rejects blank detail articles without exposing the detail row', () => {
  const candidate = importCandidate();
  candidate.details[0].article = '   ';

  const result = validateImportCandidate({ candidate });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(item => [item.code, item.severity, item.details]), [
    ['invalid_detail_key', 'critical', { index: 0 }],
  ]);
});

test('rejects duplicate detail keys', () => {
  const candidate = importCandidate();
  candidate.details.push({ ...candidate.details[0] });

  const result = validateImportCandidate({ candidate });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(item => [item.code, item.severity, item.details]), [
    ['duplicate_detail_key', 'critical', { index: 2 }],
  ]);
});

test('rejects duplicate manager day keys', () => {
  const candidate = importCandidate();
  candidate.managerDays.push({ ...candidate.managerDays[0] });

  const result = validateImportCandidate({ candidate });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(item => [item.code, item.severity, item.details]), [
    ['duplicate_manager_day', 'critical', { index: 1 }],
  ]);
});

test('rejects detail totals that do not match a day', () => {
  const candidate = importCandidate();
  candidate.details[1].qty = 5;

  const result = validateImportCandidate({ candidate });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(item => [item.code, item.severity, item.details]), [
    ['detail_total_mismatch', 'critical', { date: '2026-07-15', metric: 'qty' }],
  ]);
});

test('allows a detail total difference mathematically equal to 0.01', () => {
  const candidate = importCandidate();
  candidate.details[1].ads = 1999.99;

  assert.deepEqual(validateImportCandidate({ candidate }), { ok: true, issues: [] });
});

test('treats missing detail rows as zero totals', () => {
  const candidate = importCandidate();
  candidate.details = [];
  candidate.managerDays = [];

  const result = validateImportCandidate({ candidate });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(item => [item.code, item.details]), [
    ['detail_total_mismatch', { date: '2026-07-15', metric: 'qty' }],
    ['detail_total_mismatch', { date: '2026-07-15', metric: 'rev' }],
    ['detail_total_mismatch', { date: '2026-07-15', metric: 'ads' }],
    ['detail_total_mismatch', { date: '2026-07-15', metric: 'cost' }],
    ['detail_total_mismatch', { date: '2026-07-15', metric: 'comm' }],
  ]);
});

test('rejects manager totals that do not match assigned details', () => {
  const candidate = importCandidate();
  candidate.managerDays[0].qty = 7;

  const result = validateImportCandidate({ candidate });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(item => [item.code, item.severity, item.details]), [
    ['manager_total_mismatch', 'critical', { date: '2026-07-15', userId: 7, metric: 'qty' }],
  ]);
});

test('rejects an assigned detail group without a manager aggregate', () => {
  const candidate = importCandidate();
  candidate.managerDays = [];

  const result = validateImportCandidate({ candidate });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(item => [item.code, item.severity, item.details]), [
    ['manager_total_mismatch', 'critical', { date: '2026-07-15', userId: 7 }],
  ]);
});

test('rejects a manager aggregate whose assigned detail group is absent', () => {
  const candidate = importCandidate();
  candidate.details[0].userId = null;
  candidate.details[0].article = 'unassigned-article-2';

  const result = validateImportCandidate({ candidate });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(item => [item.code, item.severity, item.details]), [
    ['manager_total_mismatch', 'critical', { date: '2026-07-15', userId: 7, metric: 'group' }],
  ]);
});

test('rejects a zero-rollup manager aggregate without an assigned detail group', () => {
  const candidate = importCandidate();
  candidate.managerDays.push({
    date: '2026-07-15',
    userId: 99,
    qty: 0,
    rev: 0,
    ads: 0,
    cost: 0,
    comm: 0,
    cabComm: 1,
    logF: 2,
    logR: 3,
    ret: 4,
    profit: 5,
    margin: 6,
    drr: 7,
  });

  const result = validateImportCandidate({ candidate });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(item => [item.code, item.severity, item.details]), [
    ['manager_total_mismatch', 'critical', { date: '2026-07-15', userId: 99, metric: 'group' }],
  ]);
});

test('isolates manager aggregates by both date and user', () => {
  const candidate = importCandidate();
  candidate.days.push({
    date: '2026-07-16',
    qty: 5,
    rev: 50000,
    ads: 2500,
    cost: 20000,
    comm: 10000,
    cabComm: 0,
    logF: 1000,
    logR: 50,
    ret: 0,
    profit: 10450,
    margin: 20.9,
    drr: 5,
  });
  candidate.details[1].userId = 8;
  candidate.details.push(
    {
      date: '2026-07-16',
      userId: 7,
      article: 'fa_shr_nastya_1',
      qty: 2,
      rev: 20000,
      ads: 1000,
      cost: 8000,
      comm: 4000,
    },
    {
      date: '2026-07-16',
      userId: 8,
      article: 'fa_shr_nastya_1',
      qty: 3,
      rev: 30000,
      ads: 1500,
      cost: 12000,
      comm: 6000,
    },
  );
  candidate.managerDays.push(
    {
      date: '2026-07-15',
      userId: 8,
      qty: 4,
      rev: 40000,
      ads: 2000,
      cost: 16000,
      comm: 8000,
      cabComm: 0,
      logF: 800,
      logR: 40,
      ret: 0,
      profit: 8360,
      margin: 20.9,
      drr: 5,
    },
    {
      date: '2026-07-16',
      userId: 7,
      qty: 2,
      rev: 20000,
      ads: 1000,
      cost: 8000,
      comm: 4000,
      cabComm: 0,
      logF: 400,
      logR: 20,
      ret: 0,
      profit: 4180,
      margin: 20.9,
      drr: 5,
    },
    {
      date: '2026-07-16',
      userId: 8,
      qty: 3,
      rev: 30000,
      ads: 1500,
      cost: 12000,
      comm: 6000,
      cabComm: 0,
      logF: 600,
      logR: 30,
      ret: 0,
      profit: 6270,
      margin: 20.9,
      drr: 5,
    },
  );

  assert.deepEqual(validateImportCandidate({ candidate }), { ok: true, issues: [] });
});

test('rejects a day with an inconsistent profit', () => {
  const candidate = importCandidate();
  candidate.days[0].profit = 20900.02;

  const result = validateImportCandidate({ candidate });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(item => [item.code, item.severity, item.details]), [
    ['profit_formula_mismatch', 'critical', { date: '2026-07-15' }],
  ]);
});

test('allows a profit difference mathematically equal to 0.01', () => {
  const candidate = importCandidate();
  candidate.days[0].logR = 99.7;
  candidate.days[0].profit = 20900.31;

  assert.deepEqual(validateImportCandidate({ candidate }), { ok: true, issues: [] });
});

test('rejects non-finite day, detail, and manager metrics without exposing values', () => {
  const candidate = importCandidate();
  candidate.days[0].logR = Infinity;
  candidate.details[0].ads = NaN;
  candidate.managerDays[0].comm = 'Infinity';

  const result = validateImportCandidate({ candidate });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(item => [item.code, item.severity, item.details]), [
    ['non_finite_candidate_value', 'critical', { date: '2026-07-15', metric: 'logR' }],
    ['non_finite_candidate_value', 'critical', { date: '2026-07-15', metric: 'ads' }],
    ['non_finite_candidate_value', 'critical', { date: '2026-07-15', metric: 'comm' }],
  ]);
  assert.doesNotMatch(JSON.stringify(result.issues), /Infinity|NaN/);
});

test('rejects non-finite persisted day and manager ratio fields', () => {
  const candidate = importCandidate();
  candidate.days[0].margin = Infinity;
  candidate.managerDays[0].drr = NaN;

  const result = validateImportCandidate({ candidate });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(item => [item.code, item.severity, item.details]), [
    ['non_finite_candidate_value', 'critical', { date: '2026-07-15', metric: 'margin' }],
    ['non_finite_candidate_value', 'critical', { date: '2026-07-15', metric: 'drr' }],
  ]);
});

test('rejects a non-finite manager aggregate produced by finite detail values', () => {
  const candidate = importCandidate();
  candidate.buyout = 0;
  candidate.days[0].rev = Number.MAX_VALUE;
  candidate.days[0].profit = -67100;
  candidate.details[0].article = 'overflow-a';
  candidate.details[0].rev = Number.MAX_VALUE;
  candidate.details[1].article = 'overflow-unassigned';
  candidate.details[1].rev = -Number.MAX_VALUE;
  candidate.details.push({
    date: '2026-07-15',
    userId: 7,
    article: 'overflow-b',
    qty: 0,
    rev: Number.MAX_VALUE,
    ads: 0,
    cost: 0,
    comm: 0,
  });
  candidate.managerDays[0].rev = Number.MAX_VALUE;

  const result = validateImportCandidate({ candidate });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(item => [item.code, item.severity, item.details]), [
    ['non_finite_candidate_value', 'critical', { date: '2026-07-15', metric: 'rev' }],
  ]);
});

test('rejects a non-finite buyout before checking profit formulas', () => {
  const candidate = importCandidate();
  candidate.buyout = NaN;

  const result = validateImportCandidate({ candidate });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(item => [item.code, item.severity, item.details]), [
    ['non_finite_candidate_value', 'critical', { metric: 'buyout' }],
  ]);
});

test('blocks an automatic accessory catalog match with positive metadata', () => {
  const candidate = importCandidate();
  candidate.catalogMatches = [{
    article: 'fa_капучинатор_2',
    source: 'inferred',
    cost: 1,
    w: 0,
    d: 0,
    h: 0,
  }];

  const result = validateImportCandidate({ candidate });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(item => [item.code, item.severity, item.details]), [
    ['automatic_accessory_match', 'critical', { article: 'fa_капучинатор_2' }],
  ]);
});

test('blocks an automatic accessory match with zero cost and a positive dimension', () => {
  const candidate = importCandidate();
  candidate.catalogMatches = [{
    article: 'fa_капучинатор_2',
    source: 'inferred',
    cost: 0,
    w: 1,
    d: 0,
    h: 0,
  }];

  const result = validateImportCandidate({ candidate });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(item => [item.code, item.severity, item.details]), [
    ['automatic_accessory_match', 'critical', { article: 'fa_капучинатор_2' }],
  ]);
});

test('allows a manual accessory catalog match', () => {
  const candidate = importCandidate();
  candidate.catalogMatches = [{
    article: 'fa_капучинатор_2',
    source: 'manual',
    cost: 1,
    w: 2,
    d: 3,
    h: 4,
  }];

  assert.deepEqual(validateImportCandidate({ candidate }), { ok: true, issues: [] });
});

test('blocks historical changes over 80 percent for significant old values', () => {
  const result = validateImportCandidate({
    candidate: importCandidate(),
    previousDays: [{ date: '2026-07-15', qty: 100, rev: 50000, cost: 50000 }],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(item => [item.code, item.severity, item.details]), [
    ['historical_delta_exceeded', 'critical', { date: '2026-07-15', metrics: ['qty', 'rev'] }],
  ]);
});

test('allows historical changes of exactly 80 percent', () => {
  const result = validateImportCandidate({
    candidate: importCandidate(),
    previousDays: [{ date: '2026-07-15', qty: 50, rev: 500000, cost: 200000 }],
  });

  assert.deepEqual(result, { ok: true, issues: [] });
});

test('allows an exactly 80 percent quantity change from the significance floor', () => {
  const candidate = importCandidate();
  candidate.days[0].qty = 9;
  candidate.details[1].qty = 3;

  const result = validateImportCandidate({
    candidate,
    previousDays: [{ date: '2026-07-15', qty: 5, rev: 100000, cost: 40000 }],
  });

  assert.deepEqual(result, { ok: true, issues: [] });
});

test('blocks a quantity change over 80 percent from the significance floor', () => {
  const result = validateImportCandidate({
    candidate: importCandidate(),
    previousDays: [{ date: '2026-07-15', qty: 5, rev: 100000, cost: 40000 }],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.issues.map(item => [item.code, item.severity, item.details]), [
    ['historical_delta_exceeded', 'critical', { date: '2026-07-15', metrics: ['qty'] }],
  ]);
});

test('ignores historical deltas when old values are below significance thresholds', () => {
  const result = validateImportCandidate({
    candidate: importCandidate(),
    previousDays: [{ date: '2026-07-15', qty: 4, rev: 49999, cost: 49999 }],
  });

  assert.deepEqual(result, { ok: true, issues: [] });
});

test('reports unknown articles and catalog changes as count-only warnings', () => {
  const candidate = importCandidate();
  candidate.unknownArticles = ['unknown-1', 'unknown-2'];
  candidate.catalogChanges = [{ article: 'changed-1', before: {}, after: {} }];

  const result = validateImportCandidate({ candidate });

  assert.equal(result.ok, true);
  assert.deepEqual(result.issues.map(item => [item.code, item.severity, item.details]), [
    ['unknown_articles', 'warning', { count: 2 }],
    ['catalog_metadata_changed', 'warning', { count: 1 }],
  ]);
  assert.doesNotMatch(JSON.stringify(result.issues), /unknown-1|unknown-2|changed-1|before|after/);
});

test('allows an explicit ads-only day without detail rollup', () => {
  const candidate = importCandidate();
  candidate.days.push({
    date: '2026-07-16',
    qty: 0,
    rev: 0,
    ads: 125.5,
    cost: 0,
    comm: 0,
    cabComm: 0,
    logF: 0,
    logR: 0,
    ret: 0,
    profit: -125.5,
    margin: 0,
    drr: 0,
  });
  candidate.adsOnlyDates = ['2026-07-16'];

  assert.deepEqual(validateImportCandidate({ candidate }), { ok: true, issues: [] });
});

test('rejects an ads-only exemption with financial values or synthetic details', () => {
  const cases = [
    candidate => { candidate.days[1].cost = 1; candidate.days[1].profit = -126.5; },
    candidate => {
      candidate.details.push({
        date: '2026-07-16', userId: null, article: '__ads__', qty: 0, rev: 0,
        ads: 125.5, cost: 0, comm: 0,
      });
    },
  ];

  for (const mutate of cases) {
    const candidate = importCandidate();
    candidate.days.push({
      date: '2026-07-16', qty: 0, rev: 0, ads: 125.5, cost: 0, comm: 0,
      cabComm: 0, logF: 0, logR: 0, ret: 0, profit: -125.5, margin: 0, drr: 0,
    });
    candidate.adsOnlyDates = ['2026-07-16'];
    mutate(candidate);

    const result = validateImportCandidate({ candidate });
    assert.equal(result.ok, false);
    assert.equal(result.issues.some(item => item.code === 'invalid_ads_only_day'), true);
  }
});
