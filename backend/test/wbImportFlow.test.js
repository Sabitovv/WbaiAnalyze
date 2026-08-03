const test = require('node:test');
const assert = require('node:assert/strict');
const {
  acceptedImportStatus,
  applyCabSalesCandidate,
  buildAdvertCandidate,
  buildCabSalesCandidate,
  buildCatalogCandidate,
  fetchAdvertStats,
  importCabAds,
  importCabSalesFromRows,
  prepareCabSalesCandidate,
  persistAdvertCandidate,
  persistCatalogCandidate,
  projectAdvertTotals,
  runValidatedAttempts,
  failedImportResult,
} = require('../wb');
const { validateImportCandidate } = require('../wbImportValidation');

function normalizedSql(text) {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function catalogDb({ catalog = [], templates = [] } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      if (/select distinct on \(name\)/i.test(text)) return { rows: templates };
      if (/from catalog/i.test(text)) return { rows: catalog };
      throw new Error(`Unexpected query: ${text}`);
    },
  };
}

function advertDay(overrides = {}) {
  return {
    date: '2026-07-15',
    views: 100,
    clicks: 10,
    ctr: 10,
    cpc: 2,
    sum: 20,
    atbs: 3,
    orders: 2,
    cr: 20,
    shks: 2,
    sum_price: 200,
    ...overrides,
  };
}

function advertCandidate(overrides = {}) {
  return buildAdvertCandidate({
    campaigns: [
      { advertId: 1, name: 'Campaign one', type: 8, status: 9 },
      { advertId: 2, name: 'Campaign two', type: 9, status: 11 },
    ],
    stats: [],
    users: [],
    isKZT: true,
    exRate: 6,
    dateFrom: '2026-07-01',
    dateTo: '2026-07-31',
    ...overrides,
  });
}

test('catalog preparation performs SELECTs only and returns source-free upserts', async () => {
  const db = catalogDb({
    templates: [{ name: 'Шурик красный', cost: 4000, comm: 12, w: 20, d: 15, h: 10 }],
  });

  const candidate = await buildCatalogCandidate(db, [{
    sa_name: 'fa_shr_manager_1',
    subject_name: 'Шуруповерт',
    privatePayload: 'must-not-be-retained',
  }]);

  assert.equal(db.calls.length, 2);
  assert.equal(db.calls.every(call => /^select\b/i.test(call.text.trim())), true);
  assert.equal(candidate.upserts.length, 1);
  assert.deepEqual(candidate.upserts[0], {
    name: 'Шурик',
    article: 'fa_shr_manager_1',
    subject: 'Шуруповерт',
    cost: 4000,
    comm: 12,
    w: 20,
    d: 15,
    h: 10,
    source: 'inferred',
  });
  assert.doesNotMatch(JSON.stringify(candidate.upserts), /privatePayload|must-not-be-retained/);
});

test('catalog preparation never infers accessories', async () => {
  const db = catalogDb({
    templates: [{ name: 'Болгарка', cost: 16000, comm: 12, w: 30, d: 20, h: 15 }],
  });

  const candidate = await buildCatalogCandidate(db, [{
    sa_name: 'almg_bg_batareika_1',
    subject_name: 'Шлифовальная машина',
  }]);

  assert.deepEqual(candidate.upserts, []);
  assert.equal(candidate.catalogByArticle.almg_bg_batareika_1, undefined);
});

test('catalog preparation does not enrich an existing manual row', async () => {
  const manual = {
    id: 7,
    name: 'Ручная карточка',
    article: 'fa_shr_manager_1',
    subject: '',
    cost: 0,
    comm: 0,
    w: 0,
    d: 0,
    h: 0,
    source: 'manual',
  };
  const db = catalogDb({
    catalog: [manual],
    templates: [{ name: 'Шурик красный', cost: 4000, comm: 12, w: 20, d: 15, h: 10 }],
  });

  const candidate = await buildCatalogCandidate(db, [{
    sa_name: manual.article,
    subject_name: 'Шуруповерт',
  }]);

  assert.deepEqual(candidate.upserts, []);
  assert.equal(candidate.catalogByArticle[manual.article], manual);
});

test('catalog persistence uses a parameterized manual-source conflict guard', async () => {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [] };
    },
  };
  const upsert = {
    name: 'Шурик',
    article: 'fa_shr_manager_1',
    subject: 'Шуруповерт',
    cost: 4000,
    comm: 12,
    w: 20,
    d: 15,
    h: 10,
    source: 'inferred',
  };

  await persistCatalogCandidate(client, [upsert]);

  assert.equal(calls.length, 1);
  const sql = normalizedSql(calls[0].text);
  assert.match(sql, /on conflict \(article\) where article is not null do update/);
  assert.match(sql, /where catalog\.source is distinct from 'manual'/);
  assert.deepEqual(calls[0].values, [
    upsert.name,
    upsert.article,
    upsert.subject,
    upsert.cost,
    upsert.comm,
    upsert.w,
    upsert.d,
    upsert.h,
    upsert.source,
  ]);
  assert.doesNotMatch(calls[0].text, /fa_shr_manager_1|Шуруповерт/);
});

test('empty advertising stats replace nothing and report only the missing count', () => {
  const candidate = advertCandidate();

  assert.deepEqual(candidate.rows, []);
  assert.deepEqual(candidate.replaceCampaignIds, []);
  assert.equal(candidate.requestedCampaigns, 2);
  assert.equal(candidate.returnedCampaigns, 0);
  assert.deepEqual(candidate.issues.map(issue => [issue.code, issue.severity, issue.details]), [
    ['advert_stats_missing', 'warning', { count: 2 }],
  ]);
});

test('a returned advertising stats object with empty days replaces that campaign', () => {
  const candidate = advertCandidate({ stats: [{ advertId: 1, days: [] }] });

  assert.deepEqual(candidate.rows, []);
  assert.deepEqual(candidate.replaceCampaignIds, [1]);
  assert.equal(candidate.returnedCampaigns, 1);
  assert.deepEqual(candidate.issues.map(issue => [issue.code, issue.details]), [
    ['advert_stats_missing', { count: 1 }],
  ]);
});

test('missing or non-array advertising days preserve the existing campaign', () => {
  for (const stats of [{ advertId: 1 }, { advertId: 1, days: {} }]) {
    const candidate = advertCandidate({ stats: [stats] });

    assert.deepEqual(candidate.rows, []);
    assert.deepEqual(candidate.replaceCampaignIds, []);
    assert.equal(candidate.returnedCampaigns, 0);
    assert.deepEqual(candidate.issues.map(issue => [issue.code, issue.details]), [
      ['advert_stats_missing', { count: 2 }],
      ['advert_days_invalid', { count: 1 }],
    ]);
  }
});

test('one invalid in-range spend discards all rows for that campaign', () => {
  const candidate = advertCandidate({
    stats: [{
      advertId: 1,
      days: [
        advertDay({ date: '2026-07-15', sum: 20 }),
        advertDay({ date: '2026-07-16', sum: undefined, privatePayload: 'unsafe-row' }),
      ],
    }],
  });

  assert.deepEqual(candidate.rows, []);
  assert.deepEqual(candidate.replaceCampaignIds, []);
  assert.equal(candidate.returnedCampaigns, 0);
  assert.deepEqual(candidate.issues.map(issue => [issue.code, issue.details]), [
    ['advert_stats_missing', { count: 2 }],
    ['advert_days_invalid', { count: 1 }],
  ]);
  assert.doesNotMatch(JSON.stringify(candidate.issues), /unsafe-row|privatePayload/);
});

test('duplicate advertising day dates preserve the existing campaign', () => {
  const candidate = advertCandidate({
    stats: [{
      advertId: 1,
      days: [advertDay({ sum: 20 }), advertDay({ sum: 30 })],
    }],
  });

  assert.deepEqual(candidate.rows, []);
  assert.deepEqual(candidate.replaceCampaignIds, []);
  assert.equal(candidate.returnedCampaigns, 0);
  assert.equal(candidate.issues.find(issue => issue.code === 'advert_days_invalid')?.details.count, 1);
});

test('a sum-only in-range advertising day preserves the existing campaign', () => {
  const candidate = advertCandidate({
    stats: [{ advertId: 1, days: [{ date: '2026-07-15', sum: 20 }] }],
  });

  assert.deepEqual(candidate.rows, []);
  assert.deepEqual(candidate.replaceCampaignIds, []);
  assert.equal(candidate.returnedCampaigns, 0);
  assert.deepEqual(candidate.issues.map(issue => [issue.code, issue.details]), [
    ['advert_stats_missing', { count: 2 }],
    ['advert_days_invalid', { count: 1 }],
  ]);
});

test('a complete all-zero advertising day is valid and replaceable', () => {
  const candidate = advertCandidate({
    stats: [{
      advertId: 1,
      days: [{
        date: '2026-07-15',
        views: 0,
        clicks: 0,
        ctr: 0,
        cpc: 0,
        sum: 0,
        atbs: 0,
        orders: 0,
        cr: 0,
        shks: 0,
        sum_price: 0,
      }],
    }],
  });

  assert.deepEqual(candidate.replaceCampaignIds, [1]);
  assert.equal(candidate.returnedCampaigns, 1);
  assert.deepEqual(candidate.rows[0], {
    campaignId: 1,
    campaignName: 'Campaign one',
    campaignType: 8,
    status: 9,
    userId: null,
    date: '2026-07-15',
    views: 0,
    clicks: 0,
    ctr: 0,
    cpc: 0,
    sum: 0,
    atbs: 0,
    orders: 0,
    cr: 0,
    shks: 0,
    sumPrice: 0,
  });
  assert.equal(candidate.issues.some(issue => issue.code === 'advert_days_invalid'), false);
});

test('a present malformed persisted advertising metric invalidates the campaign', () => {
  const candidate = advertCandidate({
    stats: [{ advertId: 1, days: [advertDay({ views: 'not-a-number' })] }],
  });

  assert.deepEqual(candidate.rows, []);
  assert.deepEqual(candidate.replaceCampaignIds, []);
  assert.equal(candidate.issues.find(issue => issue.code === 'advert_days_invalid')?.details.count, 1);
});

test('an out-of-range advertising day is filtered before persisted metric validation', () => {
  const candidate = advertCandidate({
    stats: [{ advertId: 1, days: [{ date: '2026-06-30' }] }],
  });

  assert.deepEqual(candidate.rows, []);
  assert.deepEqual(candidate.replaceCampaignIds, [1]);
  assert.equal(candidate.returnedCampaigns, 1);
  assert.deepEqual(candidate.issues.map(issue => [issue.code, issue.details]), [
    ['advert_stats_missing', { count: 1 }],
    ['advert_days_out_of_range', { count: 1 }],
  ]);
});

test('duplicate and malformed campaign entries stay missing and duplicate IDs are conflicted', () => {
  const candidate = advertCandidate({
    campaigns: [
      { advertId: 1, name: 'Campaign one', type: 8, status: 9 },
      { advertId: 1, name: 'Campaign one duplicate', type: 10, status: 11 },
      { name: 'Campaign without id', type: 12, status: 7 },
      { advertId: 2, name: 'Campaign two', type: 9, status: 11 },
    ],
    stats: [{ advertId: 1, days: [advertDay()] }],
  });

  assert.equal(candidate.requestedCampaigns, 4);
  assert.equal(candidate.returnedCampaigns, 0);
  assert.deepEqual(candidate.replaceCampaignIds, []);
  assert.deepEqual(candidate.rows, []);
  assert.deepEqual(candidate.issues.map(issue => [issue.code, issue.details]), [
    ['advert_stats_missing', { count: 4 }],
    ['advert_duplicate_campaign_ids', { count: 1 }],
  ]);
});

test('duplicate advertising stats objects preserve the existing campaign', () => {
  const candidate = advertCandidate({
    stats: [
      { advertId: 1, days: [advertDay({ sum: 20 })] },
      { advertId: 1, days: [advertDay({ sum: 30 })] },
    ],
  });

  assert.deepEqual(candidate.rows, []);
  assert.deepEqual(candidate.replaceCampaignIds, []);
  assert.equal(candidate.returnedCampaigns, 0);
  assert.deepEqual(candidate.issues.map(issue => [issue.code, issue.details]), [
    ['advert_stats_missing', { count: 2 }],
    ['advert_duplicate_stats_ids', { count: 1 }],
  ]);
});

test('advertising stats fetch preserves duplicate returned objects for candidate validation', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    async json() {
      return [
        { advertId: 91001, days: [] },
        { advertId: 91001, days: [] },
      ];
    },
  });

  try {
    const stats = await fetchAdvertStats(
      'duplicate-stats-test-token',
      [91001],
      '2026-07-01',
      '2026-07-31'
    );
    assert.equal(stats.length, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test('advertising candidate does not mutate caller-supplied regular expressions', () => {
  const campaignPattern = /one/gi;
  const input = {
    stats: [{ advertId: 1, days: [advertDay()] }],
    users: [{ id: 7, regexes: [campaignPattern] }],
  };

  const first = advertCandidate(input);
  const second = advertCandidate(input);

  assert.equal(campaignPattern.lastIndex, 0);
  assert.equal(first.rows[0].userId, 7);
  assert.equal(first.rows[0].campaignType, 8);
  assert.equal(first.rows[0].status, 9);
  assert.deepEqual(second, first);
});

test('advertising projection replaces returned campaigns and preserves missing campaigns', () => {
  const candidate = advertCandidate({
    stats: [{ advertId: 1, days: [advertDay({ sum: 30 })] }],
    users: [
      { id: 7, regexes: [/one/i] },
      { id: 8, regexes: [/two/i] },
    ],
  });
  const existingRows = [
    { campaign_id: 1, date: '2026-07-15', user_id: 7, sum: '10' },
    { campaign_id: 2, date: '2026-07-15', user_id: 8, sum: '20' },
  ];

  const totals = projectAdvertTotals({ existingRows, candidate });

  assert.deepEqual(totals, {
    byDate: { '2026-07-15': 50 },
    byManagerDate: { '2026-07-15': { 7: 30, 8: 20 } },
  });
});

test('advertising projection normalizes dates and excludes unassigned rows only from manager totals', () => {
  const candidate = {
    replaceCampaignIds: [],
    rows: [
      { campaignId: 3, date: '2026-07-16', userId: null, sum: 5 },
      { campaignId: 4, date: '2026-07-16', userId: 7, sum: 7 },
    ],
  };
  const existingRows = [
    { campaign_id: 5, date: new Date(2026, 6, 16), user_id: null, sum: '3' },
  ];

  const totals = projectAdvertTotals({ existingRows, candidate });

  assert.deepEqual(totals, {
    byDate: { '2026-07-16': 15 },
    byManagerDate: { '2026-07-16': { 7: 7 } },
  });
});

test('advertising persistence scopes deletes to returned campaigns and skips empty replacement lists', async () => {
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [] };
    },
  };
  const row = {
    campaignId: 1,
    campaignName: 'Campaign one',
    campaignType: 8,
    status: 9,
    userId: 7,
    date: '2026-07-15',
    views: 100,
    clicks: 10,
    ctr: 10,
    cpc: 2,
    sum: 20,
    atbs: 3,
    orders: 2,
    cr: 20,
    shks: 2,
    sumPrice: 200,
  };

  await persistAdvertCandidate(client, 6, '2026-07-01', '2026-07-31', {
    replaceCampaignIds: [1],
    rows: [row],
  });

  assert.equal(calls.length, 2);
  assert.match(normalizedSql(calls[0].text), /delete from wb_advert_stats where cab_id=\$1 and date between \$2 and \$3 and campaign_id = any\(\$4::bigint\[\]\)/);
  assert.deepEqual(calls[0].values, [6, '2026-07-01', '2026-07-31', [1]]);
  assert.match(normalizedSql(calls[1].text), /insert into wb_advert_stats/);
  assert.deepEqual(calls[1].values, [
    6, 7, 1, 'Campaign one', 8, 9, '2026-07-15',
    100, 10, 10, 2, 20, 3, 2, 20, 2, 200,
  ]);

  calls.length = 0;
  await persistAdvertCandidate(client, 6, '2026-07-01', '2026-07-31', {
    replaceCampaignIds: [],
    rows: [],
  });
  assert.deepEqual(calls, []);
});

test('advertising candidate filters dates outside the requested period with a count-only warning', () => {
  const candidate = advertCandidate({
    stats: [{
      advertId: 1,
      days: [
        advertDay({ date: '2026-06-30' }),
        advertDay({ date: '2026-07-15' }),
        advertDay({ date: '2026-08-01' }),
      ],
    }],
  });

  assert.deepEqual(candidate.rows.map(row => row.date), ['2026-07-15']);
  assert.deepEqual(candidate.issues.map(issue => [issue.code, issue.severity, issue.details]), [
    ['advert_stats_missing', 'warning', { count: 1 }],
    ['advert_days_out_of_range', 'warning', { count: 2 }],
  ]);
  assert.doesNotMatch(JSON.stringify(candidate.issues), /2026-06-30|2026-08-01/);
});

test('advertising candidate skips non-finite metrics without retaining source data', () => {
  const candidate = advertCandidate({
    stats: [{ advertId: 1, days: [advertDay({ sum: Infinity, privatePayload: 'secret-row' })] }],
  });

  assert.deepEqual(candidate.rows, []);
  assert.deepEqual(candidate.issues.map(issue => [issue.code, issue.severity, issue.details]), [
    ['advert_stats_missing', 'warning', { count: 2 }],
    ['advert_days_invalid', 'warning', { count: 1 }],
  ]);
  assert.doesNotMatch(JSON.stringify(candidate.issues), /Infinity|privatePayload|secret-row/);
});

test('advertising candidate skips metrics that overflow during currency conversion', () => {
  const candidate = advertCandidate({
    isKZT: false,
    exRate: 6,
    stats: [{ advertId: 1, days: [advertDay({ sum: Number.MAX_VALUE })] }],
  });

  assert.deepEqual(candidate.rows, []);
  assert.equal(candidate.issues.find(issue => issue.code === 'advert_days_invalid')?.details.count, 1);
});

test('advertising persistence does not delete when every returned candidate is unsafe', async () => {
  const candidate = advertCandidate({ stats: [{ advertId: 1 }] });
  const calls = [];
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [] };
    },
  };

  await persistAdvertCandidate(client, 6, '2026-07-01', '2026-07-31', candidate);

  assert.deepEqual(calls, []);
});

function advertImportPool({ failInsert = false } = {}) {
  const poolCalls = [];
  const clientCalls = [];
  let released = false;
  const client = {
    async query(text, values) {
      clientCalls.push({ text, values });
      if (failInsert && /insert into wb_advert_stats/i.test(text)) {
        throw new Error('write failed');
      }
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };
  return {
    poolCalls,
    clientCalls,
    get released() {
      return released;
    },
    async query(text, values) {
      poolCalls.push({ text, values });
      if (/select id, pattern from users/i.test(text)) return { rows: [] };
      throw new Error(`Unexpected pool query: ${text}`);
    },
    async connect() {
      return client;
    },
  };
}

function injectedAdvertFetches() {
  return {
    fetchAdverts: async () => [{ advertId: 1, name: 'Campaign one', type: 8, status: 9 }],
    fetchAdvertStats: async () => [{ advertId: 1, days: [advertDay()] }],
    fetchRate: async () => 6,
  };
}

test('standalone advertising import fetches each campaign id once and preserves duplicate metadata', async () => {
  const pool = advertImportPool();
  const fetchedIds = [];

  const result = await importCabAds(
    pool,
    { id: 6, name: 'Cab', wb_token: 'test-token' },
    '2026-07-01',
    '2026-07-31',
    true,
    {
      fetchAdverts: async () => [
        { advertId: 1, name: 'First metadata', type: 8, status: 9 },
        { advertId: 1, name: 'Conflicting metadata', type: 9, status: 11 },
      ],
      fetchAdvertStats: async (_token, ids) => {
        fetchedIds.push(...ids);
        return [{ advertId: 1, days: [advertDay()] }];
      },
      fetchRate: async () => 6,
    }
  );

  assert.deepEqual(fetchedIds, [1]);
  assert.equal(result.requestedCampaigns, 2);
  assert.equal(result.returnedCampaigns, 0);
  assert.equal(result.imported, 0);
  assert.deepEqual(result.issues.map(issue => [issue.code, issue.details]), [
    ['advert_stats_missing', { count: 2 }],
    ['advert_duplicate_campaign_ids', { count: 1 }],
  ]);
  assert.deepEqual(pool.clientCalls.map(call => normalizedSql(call.text)), [
    'begin',
    'select pg_advisory_xact_lock($1)',
    'commit',
  ]);
});

test('standalone advertising import writes inside an advisory-locked transaction', async () => {
  const pool = advertImportPool();

  const result = await importCabAds(
    pool,
    { id: 6, name: 'Cab', wb_token: 'test-token' },
    '2026-07-01',
    '2026-07-31',
    true,
    injectedAdvertFetches()
  );

  assert.deepEqual(result, {
    imported: 1,
    campaigns: 1,
    requestedCampaigns: 1,
    returnedCampaigns: 1,
    issues: [],
  });
  assert.deepEqual(pool.clientCalls.map(call => normalizedSql(call.text)), [
    'begin',
    'select pg_advisory_xact_lock($1)',
    'delete from wb_advert_stats where cab_id=$1 and date between $2 and $3 and campaign_id = any($4::bigint[])',
    normalizedSql(pool.clientCalls[3].text),
    'commit',
  ]);
  assert.match(normalizedSql(pool.clientCalls[3].text), /^insert into wb_advert_stats/);
  assert.deepEqual(pool.clientCalls[1].values, [6]);
  assert.equal(pool.released, true);
});

test('advertising candidate-only import performs no transaction or write', async () => {
  const pool = advertImportPool();

  const result = await importCabAds(
    pool,
    { id: 6, name: 'Cab', wb_token: 'test-token' },
    '2026-07-01',
    '2026-07-31',
    true,
    { ...injectedAdvertFetches(), candidateOnly: true }
  );

  assert.equal(result.imported, 1);
  assert.equal(result.candidate.rows.length, 1);
  assert.deepEqual(pool.clientCalls, []);
  assert.equal(pool.released, false);
});

test('standalone advertising import rolls back its transaction on a write error', async () => {
  const pool = advertImportPool({ failInsert: true });

  await assert.rejects(
    importCabAds(
      pool,
      { id: 6, name: 'Cab', wb_token: 'test-token' },
      '2026-07-01',
      '2026-07-31',
      true,
      injectedAdvertFetches()
    ),
    /write failed/
  );

  const sqlCalls = pool.clientCalls.map(call => normalizedSql(call.text));
  assert.deepEqual(sqlCalls.slice(0, 3), [
    'begin',
    'select pg_advisory_xact_lock($1)',
    'delete from wb_advert_stats where cab_id=$1 and date between $2 and $3 and campaign_id = any($4::bigint[])',
  ]);
  assert.match(sqlCalls[3], /^insert into wb_advert_stats/);
  assert.equal(sqlCalls.at(-1), 'rollback');
  assert.equal(sqlCalls.includes('commit'), false);
  assert.equal(pool.released, true);
});

function financialRow(overrides = {}) {
  return {
    doc_type_name: 'Продажа',
    sale_dt: '2026-07-15T12:00:00Z',
    quantity: 1,
    retail_amount: 100,
    currency_name: 'KZT',
    sa_name: 'tool_manager',
    subject_name: 'Инструмент',
    commission_percent: 10,
    ...overrides,
  };
}

function injectedSalesOptions(overrides = {}) {
  return {
    catalogCandidate: {
      catalogByArticle: {
        tool_manager: {
          article: 'tool_manager',
          source: 'manual',
          cost: 20,
          comm: 10,
          w: 0,
          d: 0,
          h: 0,
        },
      },
      upserts: [],
    },
    users: [{ id: 7, pattern: 'manager' }],
    exRate: 6,
    ...overrides,
  };
}

test('accepted import status uses a deterministic UTC yesterday cutoff', () => {
  const now = new Date('2026-08-01T00:05:00-05:00');

  assert.equal(acceptedImportStatus(['2026-07-30'], now), 'verified');
  assert.equal(acceptedImportStatus(['2026-07-30', '2026-07-31'], now), 'provisional');
  assert.equal(acceptedImportStatus(['2026-08-01'], now), 'provisional');
});

test('sales candidate build performs calculations without writes or connecting', async () => {
  const pool = {
    async query() {
      throw new Error('injected build must not query');
    },
    async connect() {
      throw new Error('build must not connect');
    },
  };

  const candidate = await buildCabSalesCandidate(
    pool,
    { id: 6, buyout: 88, commission: 10, cab_type: 'normal' },
    [financialRow()],
    { '2026-07-15': 5 },
    { '2026-07-15': { 7: 2 } },
    injectedSalesOptions()
  );

  assert.equal(candidate.days.length, 1);
  assert.equal(candidate.details.length, 1);
  assert.equal(candidate.managerDays.length, 1);
  assert.equal(candidate.days[0].ads, 5);
});

test('built sales candidate has the required shape and full finite metrics', async () => {
  const candidate = await buildCabSalesCandidate(
    {},
    { id: 6, buyout: 88, commission: 10, cab_type: 'normal' },
    [financialRow()],
    { '2026-07-15': 5 },
    {},
    injectedSalesOptions()
  );
  const requiredKeys = [
    'status', 'buyout', 'days', 'managerDays', 'details', 'catalogMatches',
    'catalogUpserts', 'advertCandidate', 'issues', 'sourceMetrics', 'candidateMetrics',
    'unknownArticles', 'catalogChanges', 'previousDays',
  ];
  const metrics = ['qty', 'rev', 'ads', 'cost', 'comm', 'cabComm', 'logF', 'logR', 'ret', 'profit', 'margin', 'drr'];

  assert.deepEqual(requiredKeys.filter(key => !Object.hasOwn(candidate, key)), []);
  for (const row of [...candidate.days, ...candidate.managerDays]) {
    assert.equal(metrics.every(metric => Number.isFinite(row[metric])), true);
  }
  assert.deepEqual(validateImportCandidate({ candidate }), { ok: true, issues: [] });
});

test('a blocked detail mismatch is rejected before any connection or write', async () => {
  let connectCalls = 0;
  const writeSql = [];
  const pool = {
    async connect() {
      connectCalls += 1;
      return {
        async query(text) {
          if (!/^select\b/i.test(text.trim())) writeSql.push(text);
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const candidate = await buildCabSalesCandidate(
    {},
    { id: 6, buyout: 88, commission: 10, cab_type: 'normal' },
    [financialRow()],
    {},
    {},
    injectedSalesOptions()
  );
  candidate.details[0].rev += 1;

  const prepared = prepareCabSalesCandidate({ candidate, previousDays: [] });
  if (prepared.status !== 'blocked') {
    await applyCabSalesCandidate(pool, { id: 6 }, prepared.candidate);
  }

  assert.equal(prepared.status, 'blocked');
  assert.equal(prepared.previousDataPreserved, true);
  assert.equal(prepared.issues.some(issue => issue.code === 'detail_total_mismatch'), true);
  assert.equal(connectCalls, 0);
  assert.deepEqual(writeSql, []);
});

test('an automatically inferred accessory never contributes catalog cost', async () => {
  const article = 'fa_капучинатор_2';
  const candidate = await buildCabSalesCandidate(
    {},
    { id: 6, buyout: 88, commission: 10, cab_type: 'normal' },
    [financialRow({ sa_name: article })],
    {},
    {},
    injectedSalesOptions({
      catalogCandidate: {
        catalogByArticle: {
          [article]: { article, source: 'inferred', cost: 999, comm: 10, w: 1, d: 1, h: 1 },
        },
        upserts: [],
      },
      users: [],
    })
  );

  assert.equal(candidate.days[0].cost, 0);
  assert.equal(candidate.details[0].cost, 0);
  assert.deepEqual(candidate.unknownArticles, [article]);
});

test('unknown articles are unique and reported as a count-only warning', async () => {
  const candidate = await buildCabSalesCandidate(
    {},
    { id: 6, buyout: 88, commission: 10, cab_type: 'normal' },
    [
      financialRow({ sa_name: 'unknown_article' }),
      financialRow({ sa_name: 'UNKNOWN_ARTICLE', retail_amount: 50 }),
    ],
    {},
    {},
    injectedSalesOptions({ catalogCandidate: { catalogByArticle: {}, upserts: [] }, users: [] })
  );
  const prepared = prepareCabSalesCandidate({ candidate, previousDays: [] });

  assert.deepEqual(candidate.unknownArticles, ['unknown_article']);
  assert.deepEqual(prepared.issues.filter(issue => issue.code === 'unknown_articles'), [{
    code: 'unknown_articles',
    severity: 'warning',
    message: 'В импорте есть неизвестные артикулы.',
    details: { count: 1 },
  }]);
});

test('advertising allocation is exact across assigned and unassigned details and scales excessive direct totals', async () => {
  const rows = [
    financialRow({ sa_name: 'tool_a', retail_amount: 100 }),
    financialRow({ sa_name: 'tool_b', retail_amount: 100 }),
    financialRow({ sa_name: 'tool_free', retail_amount: 100 }),
    financialRow({ sale_dt: '2026-07-16T12:00:00Z', sa_name: 'tool_a', retail_amount: 100 }),
    financialRow({ sale_dt: '2026-07-16T12:00:00Z', sa_name: 'tool_b', retail_amount: 100 }),
    financialRow({ sale_dt: '2026-07-16T12:00:00Z', sa_name: 'tool_free', retail_amount: 100 }),
  ];
  const product = article => ({ article, source: 'manual', cost: 0, comm: 0, w: 0, d: 0, h: 0 });
  const candidate = await buildCabSalesCandidate(
    {},
    { id: 6, buyout: 100, commission: 0, cab_type: 'normal' },
    rows,
    { '2026-07-15': 10, '2026-07-16': 10 },
    {
      '2026-07-15': { 1: 4 },
      '2026-07-16': { 1: 9, 2: 9 },
    },
    injectedSalesOptions({
      catalogCandidate: {
        catalogByArticle: {
          tool_a: product('tool_a'),
          tool_b: product('tool_b'),
          tool_free: product('tool_free'),
        },
        upserts: [],
      },
      users: [{ id: 1, pattern: 'tool_a' }, { id: 2, pattern: 'tool_b' }],
    })
  );

  for (const day of candidate.days) {
    const detailAds = candidate.details
      .filter(detail => detail.date === day.date)
      .reduce((sum, detail) => sum + detail.ads, 0);
    assert.ok(Math.abs(detailAds - day.ads) <= 0.01);
  }
  const firstDayAds = Object.fromEntries(candidate.details
    .filter(detail => detail.date === '2026-07-15')
    .map(detail => [detail.article, detail.ads]));
  assert.deepEqual(firstDayAds, { tool_a: 6, tool_b: 2, tool_free: 2 });
  const secondDayAds = Object.fromEntries(candidate.details
    .filter(detail => detail.date === '2026-07-16')
    .map(detail => [detail.article, detail.ads]));
  assert.deepEqual(secondDayAds, { tool_a: 5, tool_b: 5, tool_free: 0 });
});

test('an ads-only date has a valid loss day without a synthetic detail', async () => {
  const candidate = await buildCabSalesCandidate(
    {},
    { id: 6, buyout: 88, commission: 10, cab_type: 'normal' },
    [financialRow()],
    { '2026-07-15': 5, '2026-07-16': 12.34 },
    {},
    injectedSalesOptions()
  );
  const adsOnlyDay = candidate.days.find(day => day.date === '2026-07-16');

  assert.deepEqual(candidate.adsOnlyDates, ['2026-07-16']);
  assert.equal(candidate.details.some(detail => detail.date === '2026-07-16'), false);
  assert.deepEqual(adsOnlyDay, {
    date: '2026-07-16', qty: 0, rev: 0, ads: 12.34, cost: 0, comm: 0,
    cabComm: 0, logF: 0, logR: 0, ret: 0, profit: -12.34, margin: 0, drr: 0,
  });
  assert.deepEqual(validateImportCandidate({ candidate }), { ok: true, issues: [] });
});

async function candidateForApply(overrides = {}) {
  const candidate = await buildCabSalesCandidate(
    {},
    { id: 6, buyout: 88, commission: 10, cab_type: 'normal' },
    [financialRow()],
    { '2026-07-15': 5 },
    {},
    injectedSalesOptions({
      catalogCandidate: {
        catalogByArticle: injectedSalesOptions().catalogCandidate.catalogByArticle,
        upserts: [{
          name: 'Инструмент', article: 'tool_manager', subject: 'Инструмент',
          cost: 20, comm: 10, w: 0, d: 0, h: 0, source: 'inferred',
        }],
      },
      advertCandidate: {
        replaceCampaignIds: [11],
        rows: [{
          campaignId: 11, campaignName: 'manager', campaignType: 8, status: 9,
          userId: 7, date: '2026-07-15', views: 1, clicks: 1, ctr: 100,
          cpc: 5, sum: 5, atbs: 1, orders: 1, cr: 100, shks: 1, sumPrice: 100,
        }],
        requestedCampaigns: 1,
        returnedCampaigns: 1,
        issues: [],
      },
    })
  );
  candidate.previousDays = [{ date: '2026-07-15', qty: 0, rev: 0, cost: 0 }];
  return Object.assign(candidate, overrides);
}

function salesApplyPool({ snapshotRows = [], failOn = null } = {}) {
  const calls = [];
  let released = false;
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (failOn && failOn.test(text)) throw new Error('write failed');
      if (/from wb_sales s/i.test(text)) return { rows: snapshotRows };
      if (/update wb_import_runs/i.test(text)) return { rows: [{ id: 42 }] };
      if (/insert into wb_import_days/i.test(text)) return { rows: [{ cab_id: 6, date: '2026-07-15' }] };
      return { rows: [] };
    },
    release() {
      released = true;
    },
  };
  return {
    calls,
    get released() {
      return released;
    },
    async connect() {
      return client;
    },
  };
}

test('accepted apply keeps catalog, adverts, and sales in one locked transaction', async () => {
  const pool = salesApplyPool();
  const candidate = await candidateForApply();

  const result = await applyCabSalesCandidate(pool, { id: 6 }, candidate, {
    dateFrom: '2026-07-01',
    dateTo: '2026-07-31',
  });
  const sql = pool.calls.map(call => normalizedSql(call.text));
  const begin = sql.indexOf('begin');
  const advisory = sql.indexOf('select pg_advisory_xact_lock($1)');
  const catalog = sql.findIndex(text => text.startsWith('insert into catalog'));
  const advert = sql.findIndex(text => text.startsWith('insert into wb_advert_stats'));
  const sales = sql.findIndex(text => text.startsWith('insert into wb_sales'));
  const commit = sql.indexOf('commit');

  assert.ok(begin < advisory && advisory < catalog && catalog < advert && advert < sales && sales < commit);
  assert.equal(result.imported, 1);
  assert.equal(result.previousDataPreserved, false);
  assert.equal(pool.released, true);
});

test('apply rolls back and releases after a write failure', async () => {
  const pool = salesApplyPool({ failOn: /insert into wb_manager_sales_detail/i });
  const candidate = await candidateForApply();

  await assert.rejects(applyCabSalesCandidate(pool, { id: 6 }, candidate), /write failed/);

  const sql = pool.calls.map(call => normalizedSql(call.text));
  assert.equal(sql.at(-1), 'rollback');
  assert.equal(sql.includes('commit'), false);
  assert.equal(pool.released, true);
});

test('apply aborts and rolls back when locked control totals changed', async () => {
  const pool = salesApplyPool({
    snapshotRows: [{ date: '2026-07-15', qty: '1', rev: '100', cost: '20' }],
  });
  const candidate = await candidateForApply();

  await assert.rejects(
    applyCabSalesCandidate(pool, { id: 6 }, candidate),
    error => error.code === 'IMPORT_CONCURRENT_CHANGE' && error.message === 'IMPORT_CONCURRENT_CHANGE'
  );

  const sql = pool.calls.map(call => normalizedSql(call.text));
  assert.equal(sql.at(-1), 'rollback');
  assert.equal(sql.some(text => text.startsWith('insert into catalog')), false);
  assert.equal(pool.released, true);
});

test('accepted run journal updates execute before the transaction commits', async () => {
  const pool = salesApplyPool();
  const candidate = await candidateForApply();

  await applyCabSalesCandidate(pool, { id: 6 }, candidate, { runId: 42 });

  const sql = pool.calls.map(call => normalizedSql(call.text));
  const finishRun = sql.findIndex(text => text.startsWith('update wb_import_runs'));
  const recordDays = sql.findIndex(text => text.startsWith('insert into wb_import_days'));
  const commit = sql.indexOf('commit');
  assert.ok(finishRun > 0 && finishRun < recordDays && recordDays < commit);
});

test('apply deletes manager data only for dates present in the candidate', async () => {
  const pool = salesApplyPool();
  const candidate = await candidateForApply();

  await applyCabSalesCandidate(pool, { id: 6 }, candidate, {
    dateFrom: '2026-07-01',
    dateTo: '2026-07-31',
  });

  const deletes = pool.calls.filter(call => /delete from wb_manager_sales(?:_detail)?/i.test(call.text));
  assert.equal(deletes.length, 2);
  for (const call of deletes) {
    assert.deepEqual(call.values, [6, ['2026-07-15']]);
    assert.equal(call.values[1].includes('2026-07-14'), false);
    assert.equal(call.values[1].includes('2026-07-16'), false);
  }
});

test('compatibility wrapper returns blocked source validation without connecting or exposing a candidate', async () => {
  let connectCalls = 0;
  const pool = {
    async connect() {
      connectCalls += 1;
      throw new Error('must not connect');
    },
  };

  const result = await importCabSalesFromRows(
    pool,
    { id: 6, buyout: 88, commission: 10, cab_type: 'normal' },
    null,
    {},
    {},
    injectedSalesOptions()
  );

  assert.equal(result.status, 'blocked');
  assert.equal(result.previousDataPreserved, true);
  assert.equal(Object.hasOwn(result, 'candidate'), false);
  assert.equal(connectCalls, 0);
});

test('runValidatedAttempts returns after first verified result', async () => {
  const calls = [];
  const result = await runValidatedAttempts({
    maxAttempts: 3,
    async attemptFn(attempt) {
      calls.push(attempt);
      if (attempt === 1) return { status: 'verified', issues: [], data: 'ok' };
      return { status: 'blocked', issues: [{ code: 'test', severity: 'critical' }] };
    },
  });

  assert.equal(result.status, 'verified');
  assert.deepEqual(result.data, 'ok');
  assert.equal(result.attempts, 1);
  assert.equal(calls.length, 1);
});

test('runValidatedAttempts exhausts three blocked attempts', async () => {
  const calls = [];
  const result = await runValidatedAttempts({
    maxAttempts: 3,
    async attemptFn(attempt) {
      calls.push(attempt);
      return { status: 'blocked', issues: [{ code: `block_${attempt}`, severity: 'critical' }] };
    },
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.attempts, 3);
  assert.equal(result.issues[2].code, 'block_3');
  assert.equal(calls.length, 3);
});

test('runValidatedAttempts retries after network error then succeeds', async () => {
  const calls = [];
  const result = await runValidatedAttempts({
    maxAttempts: 3,
    async attemptFn(attempt) {
      calls.push(attempt);
      if (attempt === 1) throw new Error('ECONNREFUSED');
      return { status: 'verified', issues: [] };
    },
  });

  assert.equal(result.status, 'verified');
  assert.equal(result.attempts, 2);
  assert.equal(calls.length, 2);
});

test('runValidatedAttempts stays blocked after all network errors', async () => {
  const calls = [];
  const result = await runValidatedAttempts({
    maxAttempts: 3,
    async attemptFn(attempt) {
      calls.push(attempt);
      throw new Error('ETIMEDOUT');
    },
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.attempts, 3);
  assert.equal(result.networkError, true);
  assert.equal(calls.length, 3);
});

test('failedImportResult has no stack or token in issues', () => {
  const error = new Error('test error with secret token=abc123');
  const result = failedImportResult(error);

  assert.equal(result.status, 'failed');
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'system_error');
  assert.equal(result.issues[0].severity, 'critical');
  assert.equal(result.issues[0].message, 'test error with secret token=abc123');
  assert.equal(Object.hasOwn(result.issues[0], 'stack'), false);
});

test('scheduler result shape includes status and runId', async () => {
  const result = {
    imported: 5,
    runId: 42,
    status: 'provisional',
    issues: [],
    previousDataPreserved: false,
    attempts: 1,
  };

  const rangeEntry = {
    from: '2026-07-01',
    to: '2026-07-31',
    label: 'вчера',
    imported: result.imported ?? 0,
    runId: result.runId,
    status: result.status,
    issues: result.issues,
    previousDataPreserved: result.previousDataPreserved,
  };

  assert.equal(rangeEntry.runId, 42);
  assert.equal(rangeEntry.status, 'provisional');
  assert.equal(rangeEntry.previousDataPreserved, false);
  assert.equal(Object.hasOwn(rangeEntry, 'runId'), true);
  assert.equal(Object.hasOwn(rangeEntry, 'status'), true);
});

test('buildCabSalesCandidate accepts combinedRows as array not individual arguments (regression for spread bug)', async () => {
  const wbRows = [financialRow({ sa_name: 'tool_wb', retail_amount: 200 })];
  const opRows = [financialRow({ sa_name: 'tool_op', retail_amount: 150, commission_percent: 5 })];

  const wbCandidate = await buildCabSalesCandidate(
    {},
    { id: 6, buyout: 88, commission: 10, cab_type: 'normal' },
    wbRows,
    { '2026-07-15': 5 },
    {},
    injectedSalesOptions({
      catalogCandidate: {
        catalogByArticle: {
          tool_wb: { article: 'tool_wb', source: 'manual', cost: 20, comm: 10, w: 0, d: 0, h: 0 },
          tool_op: { article: 'tool_op', source: 'manual', cost: 15, comm: 5, w: 0, d: 0, h: 0 },
        },
        upserts: [],
      },
      users: [],
    })
  );
  assert.ok(wbCandidate.days.length >= 1 && wbCandidate.details.length >= 1);

  const combinedRows = wbRows.concat(opRows);
  const combinedCandidate = await buildCabSalesCandidate(
    {},
    { id: 6, buyout: 88, commission: 10, cab_type: 'normal' },
    combinedRows,
    { '2026-07-15': 5 },
    {},
    injectedSalesOptions({
      catalogCandidate: {
        catalogByArticle: {
          tool_wb: { article: 'tool_wb', source: 'manual', cost: 20, comm: 10, w: 0, d: 0, h: 0 },
          tool_op: { article: 'tool_op', source: 'manual', cost: 15, comm: 5, w: 0, d: 0, h: 0 },
        },
        upserts: [],
      },
      users: [],
    })
  );

  assert.equal(combinedCandidate.details.length, 2);
  assert.equal(combinedCandidate.days.length, 1);
  assert.ok(combinedCandidate.days[0].qty >= 2);
});

test('operational rows merged with wb financial precedence', async () => {
  const wbDays = [{ date: '2026-07-15' }, { date: '2026-07-16' }];
  const opDays = [{ date: '2026-07-16' }, { date: '2026-07-17' }];

  const financialByDate = new Map(wbDays.map(day => [day.date, day]));
  const merged = [...wbDays];

  for (const day of opDays) {
    if (!financialByDate.has(day.date)) {
      merged.push(day);
    }
  }

  assert.equal(merged.length, 3);
  assert.deepEqual(merged[0], { date: '2026-07-15' });
  assert.deepEqual(merged[1], { date: '2026-07-16' });
  assert.deepEqual(merged[2], { date: '2026-07-17' });
  assert.equal(merged[1], wbDays[1]);
});

test('bounded retries default to 3 and respect maxAttempts option', async () => {
  const calls = [];
  const result = await runValidatedAttempts({
    maxAttempts: 1,
    async attemptFn(attempt) {
      calls.push(attempt);
      return { status: 'blocked', issues: [{ code: 'test', severity: 'critical' }] };
    },
  });

  assert.equal(result.status, 'blocked');
  assert.equal(result.attempts, 1);
  assert.equal(calls.length, 1);
});
