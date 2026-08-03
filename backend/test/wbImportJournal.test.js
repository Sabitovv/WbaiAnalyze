const test = require('node:test');
const assert = require('node:assert/strict');
const {
  finishImportRun,
  loadPreviousDays,
  recordImportDays,
  startImportRun,
} = require('../wbImportJournal');

function recordingDb(results = []) {
  const calls = [];
  const queue = Array.isArray(results) ? [...results] : [];
  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      return { rows: queue.shift() || [] };
    },
  };
}

function normalizedSql(text) {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

test('startImportRun creates a parameterized running attempt and returns only its id', async () => {
  const db = recordingDb([[{ id: 41, status: 'running' }]]);

  const run = await startImportRun(db, {
    cabId: 6,
    dateFrom: '2026-07-25',
    dateTo: '2026-07-26',
  });

  assert.deepEqual(run, { id: 41 });
  assert.deepEqual(db.calls[0].values, [6, '2026-07-25', '2026-07-26']);
  assert.match(normalizedSql(db.calls[0].text), /values \(\$1, \$2, \$3, 'running'\)/);
  assert.doesNotMatch(db.calls[0].text, /2026-07-25|2026-07-26/);
});

test('finishImportRun stores the sorted actual range and safe missing-value defaults', async () => {
  const db = recordingDb();

  await finishImportRun(db, 41, {
    status: 'verified',
    dates: ['2026-07-31', '2026-07-01', '2026-07-15'],
  });

  assert.deepEqual(db.calls[0].values, [
    41,
    '2026-07-01',
    '2026-07-31',
    'verified',
    1,
    0,
    0,
    0,
    '{}',
    '{}',
    '[]',
  ]);
  assert.deepEqual(JSON.parse(db.calls[0].values[8]), {});
  assert.deepEqual(JSON.parse(db.calls[0].values[9]), {});
  assert.deepEqual(JSON.parse(db.calls[0].values[10]), []);
  assert.match(normalizedSql(db.calls[0].text), /finished_at\s*=\s*now\(\)/);
});

test('finishImportRun persists only aggregate-safe source and candidate metrics', async () => {
  const db = recordingDb();

  await finishImportRun(db, 41, {
    status: 'verified',
    sourceMetrics: {
      qty: 3,
      rev: 100.5,
      cost: Infinity,
      rows: 2,
      dates: ['2026-07-25', 'not-a-date', 'eyJhbGciOiJIUzI1NiJ9.payload.signature'],
      campaigns: true,
      byDate: {
        '2026-07-25': { qty: 2, rev: 100, token: 'source-token' },
        '2026-02-30': { qty: 99 },
      },
      totals: {
        qty: 2,
        margin: 12.5,
        note: 'drop this string',
        authorization: 'Bearer source-token',
      },
      token: 'source-token',
      headers: { authorization: 'Bearer source-token' },
      payload: { rows: [{ qty: 99 }] },
      rawRows: [{ qty: 99 }],
      error: new Error('source-token'),
      unknownMetric: 99,
    },
    candidateMetrics: {
      acceptedRows: 2,
      rejectedRows: 0,
      requestedCampaigns: 4,
      returnedCampaigns: 3,
      dates: ['2026-07-26'],
      byDate: { '2026-07-26': { campaigns: false } },
      totals: { profit: 50, secret: 'candidate-secret' },
      apiKey: 'candidate-secret',
      arbitrary: { profit: 500 },
    },
  });

  assert.deepEqual(JSON.parse(db.calls[0].values[8]), {
    qty: 3,
    rev: 100.5,
    rows: 2,
    dates: ['2026-07-25'],
    campaigns: true,
    byDate: { '2026-07-25': { qty: 2, rev: 100 } },
    totals: { qty: 2, margin: 12.5 },
  });
  assert.deepEqual(JSON.parse(db.calls[0].values[9]), {
    acceptedRows: 2,
    rejectedRows: 0,
    requestedCampaigns: 4,
    returnedCampaigns: 3,
    dates: ['2026-07-26'],
    byDate: { '2026-07-26': { campaigns: false } },
    totals: { profit: 50 },
  });
  assert.doesNotMatch(`${db.calls[0].values[8]}${db.calls[0].values[9]}`, /token|authorization|headers|payload|raw|error|unknown|arbitrary|candidate-secret/i);
});

test('finishImportRun drops raw rows and non-aggregate metric shapes', async () => {
  const db = recordingDb();

  await finishImportRun(db, 41, {
    status: 'verified',
    sourceMetrics: {
      rows: [{ date: '2026-07-25', article: 'private-article', qty: 1, rev: 500 }],
      qty: [1, 2],
      dates: ['2026-07-25', { date: '2026-07-26' }, 'invalid'],
      byDate: {
        '2026-07-25': {
          rev: 500,
          rows: [{ article: 'private-article', rev: 500 }],
          totals: { rev: 500 },
          article: 'private-article',
        },
        invalid: { rev: 999 },
      },
      totals: [{ rev: 500 }],
    },
    candidateMetrics: {
      rows: 4,
      dates: '2026-07-25',
      byDate: { '2026-07-25': { rows: 4, rev: 500 } },
      totals: { rows: 4, rev: 500 },
    },
  });

  assert.deepEqual(JSON.parse(db.calls[0].values[8]), {
    dates: ['2026-07-25'],
    byDate: { '2026-07-25': { rev: 500 } },
  });
  assert.deepEqual(JSON.parse(db.calls[0].values[9]), {
    rows: 4,
    byDate: { '2026-07-25': { rows: 4, rev: 500 } },
    totals: { rows: 4, rev: 500 },
  });
  assert.doesNotMatch(`${db.calls[0].values[8]}${db.calls[0].values[9]}`, /private-article|article/);
});

test('finishImportRun cannot overwrite an already finalized run', async () => {
  const db = recordingDb([[{ id: 41 }], []]);

  const first = await finishImportRun(db, 41, { status: 'verified' });
  const conflicting = await finishImportRun(db, 41, {
    status: 'failed',
    issues: [{ code: 'late_failure', severity: 'critical' }],
  });

  assert.deepEqual(first, { updated: true });
  assert.deepEqual(conflicting, { updated: false });
  assert.equal(db.calls.length, 2);
  for (const call of db.calls) {
    const sql = normalizedSql(call.text);
    assert.match(sql, /where id\s*=\s*\$1 and status\s*=\s*'running'/);
    assert.match(sql, /returning id/);
  }
  assert.equal(db.calls[0].values[3], 'verified');
  assert.equal(db.calls[1].values[3], 'failed');
});

test('finishImportRun rejects nonterminal statuses before querying', async () => {
  const db = recordingDb();

  for (const status of ['running', 'unknown', undefined]) {
    await assert.rejects(
      finishImportRun(db, 41, { status }),
      /status must be one of: provisional, verified, blocked, failed/
    );
  }

  assert.equal(db.calls.length, 0);
});

test('recordImportDays preserves accepted fields when a day is blocked', async () => {
  const db = recordingDb([[
    { cab_id: 6, date: '2026-07-25' },
    { cab_id: 6, date: '2026-07-26' },
  ]]);

  const result = await recordImportDays(db, {
    cabId: 6,
    runId: 41,
    dates: ['2026-07-25', '2026-07-26'],
    status: 'blocked',
    issues: [{ code: 'historical_delta_exceeded', severity: 'critical' }],
  });

  assert.equal(db.calls.length, 1);
  assert.deepEqual(result, { updated: 2 });
  const sql = normalizedSql(db.calls[0].text);
  const conflictUpdate = sql.split('do update set')[1];
  assert.match(sql, /from wb_import_runs r cross join unnest\(\$2::text\[\]\)/);
  assert.match(sql, /where r\.id\s*=\s*\$3 and r\.cab_id\s*=\s*\$1 and r\.status\s*=\s*\$4/);
  assert.match(sql, /returning cab_id, date/);
  assert.match(conflictUpdate, /last_attempt_run_id\s*=\s*excluded\.last_attempt_run_id/);
  assert.doesNotMatch(conflictUpdate, /accepted_run_id|accepted_status|accepted_at/);
  assert.deepEqual(db.calls[0].values.slice(0, 4), [
    6,
    ['2026-07-25', '2026-07-26'],
    41,
    'blocked',
  ]);
  assert.deepEqual(JSON.parse(db.calls[0].values[4]), [{
    code: 'historical_delta_exceeded',
    severity: 'critical',
  }]);
});

test('recordImportDays replaces accepted fields for an accepted day', async () => {
  const db = recordingDb([[
    { cab_id: 6, date: '2026-07-25' },
    { cab_id: 6, date: '2026-07-26' },
  ]]);

  const result = await recordImportDays(db, {
    cabId: 6,
    runId: 42,
    dates: ['2026-07-25', '2026-07-26'],
    status: 'provisional',
    issues: [],
  });

  assert.equal(db.calls.length, 1);
  assert.deepEqual(result, { updated: 2 });
  const sql = normalizedSql(db.calls[0].text);
  const conflictUpdate = sql.split('do update set')[1];
  assert.match(sql, /from wb_import_runs r cross join unnest\(\$2::text\[\]\)/);
  assert.match(sql, /where r\.id\s*=\s*\$3 and r\.cab_id\s*=\s*\$1 and r\.status\s*=\s*\$4/);
  assert.match(sql, /returning cab_id, date/);
  assert.match(conflictUpdate, /accepted_run_id\s*=\s*excluded\.accepted_run_id/);
  assert.match(conflictUpdate, /accepted_status\s*=\s*excluded\.accepted_status/);
  assert.match(conflictUpdate, /last_attempt_run_id\s*=\s*excluded\.last_attempt_run_id/);
  assert.deepEqual(db.calls[0].values, [
    6,
    ['2026-07-25', '2026-07-26'],
    42,
    'provisional',
    '[]',
  ]);
  assert.deepEqual(JSON.parse(db.calls[0].values[4]), []);
});

test('recordImportDays reports zero updates when run metadata does not match', async () => {
  const db = recordingDb([[]]);

  const result = await recordImportDays(db, {
    cabId: 6,
    runId: 41,
    dates: ['2026-07-25'],
    status: 'failed',
    issues: [],
  });

  assert.deepEqual(result, { updated: 0 });
  assert.equal(db.calls.length, 1);
  assert.deepEqual(db.calls[0].values.slice(0, 4), [6, ['2026-07-25'], 41, 'failed']);
});

test('loadPreviousDays sums detail quantities and converts numeric fields', async () => {
  const db = recordingDb([[
    { date: '2026-07-25', qty: '3.5', rev: '1000.25', cost: '400.10' },
  ]]);

  const days = await loadPreviousDays(db, 6, '2026-07-01', '2026-07-31');

  assert.deepEqual(days, [{ date: '2026-07-25', qty: 3.5, rev: 1000.25, cost: 400.1 }]);
  assert.deepEqual(db.calls[0].values, [6, '2026-07-01', '2026-07-31']);
  const sql = normalizedSql(db.calls[0].text);
  assert.match(sql, /sum\(qty\)/);
  assert.match(sql, /s\.date::text/);
  assert.match(sql, /from wb_sales/);
  assert.match(sql, /wb_manager_sales_detail/);
});

test('journal writes strip secrets, raw data, stacks, and arbitrary errors from issues', async () => {
  const db = recordingDb();
  const unsafeIssue = {
    code: 'historical_delta_exceeded',
    severity: 'critical',
    message: 'Закрытый день изменился более чем допустимо.',
    details: {
      count: 2,
      date: '2026-07-25',
      metric: 'rev',
      metrics: ['qty', 'rev', { payload: 'raw-row' }],
      userId: 7,
      rowIndex: 3,
      rowIndexes: [1, 2, Infinity, { authorization: 'Bearer secret' }],
      scope: 'days',
      index: 0,
      article: 'article-1',
      token: 'secret-token',
      authorization: 'Bearer secret-token',
      headers: { authorization: 'Bearer secret-token' },
      payload: { rows: [{ retail_amount: 1000 }] },
      rawRows: [{ retail_amount: 1000 }],
      error: new Error('secret-token'),
      stack: 'stack secret-token',
    },
    token: 'secret-token',
    authorization: 'Bearer secret-token',
    headers: { authorization: 'Bearer secret-token' },
    payload: { rows: [{ retail_amount: 1000 }] },
    rawRows: [{ retail_amount: 1000 }],
    error: new Error('secret-token'),
    stack: 'stack secret-token',
    arbitrary: { nested: true },
  };
  const expectedIssues = [{
    code: 'historical_delta_exceeded',
    severity: 'critical',
    message: 'Закрытый день изменился более чем допустимо.',
    details: {
      count: 2,
      date: '2026-07-25',
      metric: 'rev',
      metrics: ['qty', 'rev'],
      userId: 7,
      rowIndex: 3,
      rowIndexes: [1, 2],
      scope: 'days',
      index: 0,
      article: 'article-1',
    },
  }];

  await finishImportRun(db, 41, {
    status: 'failed',
    issues: [unsafeIssue, new Error('secret-token')],
  });
  await recordImportDays(db, {
    cabId: 6,
    runId: 41,
    dates: ['2026-07-25'],
    status: 'failed',
    issues: [unsafeIssue, new Error('secret-token')],
  });

  assert.equal(typeof db.calls[0].values[10], 'string');
  assert.equal(typeof db.calls[1].values[4], 'string');
  assert.deepEqual(JSON.parse(db.calls[0].values[10]), expectedIssues);
  assert.deepEqual(JSON.parse(db.calls[1].values[4]), expectedIssues);
  const persisted = `${db.calls[0].values[10]}${db.calls[1].values[4]}`;
  assert.doesNotMatch(persisted, /secret-token|authorization|headers|payload|rawRows|retail_amount|stack|error/);
});

test('journal redacts credentials and JWT values from issue messages', async () => {
  const db = recordingDb();
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

  await finishImportRun(db, 41, {
    status: 'failed',
    issues: [{
      code: 'wb_request_failed',
      severity: 'critical',
      message: [
        'WB request failed while secret storage was unavailable.',
        'Authorization: Basic dXNlcjpwYXNz;',
        'Bearer abc.def-ghi_123',
        'token=token-value',
        'apiKey: "api-value"',
        "secret='secret value'",
        'key=key-value',
        `jwt=${jwt}`,
        'Retry is available.',
      ].join(' '),
    }],
  });

  const [issue] = JSON.parse(db.calls[0].values[10]);
  assert.match(issue.message, /WB request failed while secret storage was unavailable/);
  assert.match(issue.message, /Retry is available/);
  assert.match(issue.message, /\[REDACTED\]/);
  assert.doesNotMatch(issue.message, /dXNlcjpwYXNz|abc\.def-ghi_123|token-value|api-value|secret value|key-value|eyJhbGciOiJIUzI1NiJ9/);
});

test('journal retains only protocol and status from WB and HTTP response messages', async () => {
  const db = recordingDb();

  await finishImportRun(db, 41, {
    status: 'failed',
    issues: [
      {
        code: 'wb_response',
        severity: 'critical',
        message: 'WB 400: {"name":"Private User","article":"private-article"}',
      },
      {
        code: 'http_response',
        severity: 'critical',
        message: 'HTTP 502 Bad Gateway: <html>private response body</html>',
      },
    ],
  });

  const issues = JSON.parse(db.calls[0].values[10]);
  assert.deepEqual(issues.map(issue => issue.message), ['WB 400', 'HTTP 502 Bad Gateway']);
  assert.doesNotMatch(db.calls[0].values[10], /Private User|private-article|private response body/);
});

test('journal removes URL and private body from production WB errors', async () => {
  const db = recordingDb();
  const url = 'https://statistics-api.wildberries.ru/api/v5/supplier/reportDetailByPeriod';

  await finishImportRun(db, 41, {
    status: 'failed',
    issues: [{
      code: 'wb_response',
      severity: 'critical',
      message: `WB ${url} 403: {"name":"Private User","article":"private-article"}`,
    }],
  });

  const [issue] = JSON.parse(db.calls[0].values[10]);
  assert.equal(issue.message, 'WB 403');
  assert.doesNotMatch(db.calls[0].values[10], /statistics-api|reportDetailByPeriod|Private User|private-article/);
});

test('journal redacts labeled response tails and caps retained messages', async () => {
  const db = recordingDb();

  await finishImportRun(db, 41, {
    status: 'failed',
    issues: [
      {
        code: 'response_tail',
        severity: 'critical',
        message: 'Import failed. response: {"name":"Private User","article":"private-article"}',
      },
      {
        code: 'body_tail',
        severity: 'critical',
        message: 'Validation failed. body: name=Private User article=private-article',
      },
      {
        code: 'payload_tail',
        severity: 'critical',
        message: 'Request failed. payload: {"rows":[{"article":"private-article"}]}',
      },
      {
        code: 'long_message',
        severity: 'warning',
        message: `Timeout while reading aggregate metrics. ${'x'.repeat(1000)}`,
      },
    ],
  });

  const issues = JSON.parse(db.calls[0].values[10]);
  assert.deepEqual(issues.slice(0, 3).map(issue => issue.message), [
    'Import failed. response: [REDACTED]',
    'Validation failed. body: [REDACTED]',
    'Request failed. payload: [REDACTED]',
  ]);
  assert.equal(issues[3].message.length <= 500, true);
  assert.match(issues[3].message, /^Timeout while reading aggregate metrics\./);
  assert.doesNotMatch(db.calls[0].values[10], /Private User|private-article/);
});
