const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ── testParseFilters (inline logic copy for reliable testing) ───────────

function testParseFilters(query) {
  const raw = parseInt(query.limit, 10);
  const limit = Math.min(Math.max(raw > 0 ? raw : 50, 1), 200);
  const cabId = query.cabId && /^\d+$/.test(query.cabId) ? parseInt(query.cabId, 10) : null;
  const dateFrom = query.dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(query.dateFrom) ? query.dateFrom : null;
  const dateTo = query.dateTo && /^\d{4}-\d{2}-\d{2}$/.test(query.dateTo) ? query.dateTo : null;
  return { limit, cabId, dateFrom, dateTo };
}

function extractImportRoutesSrc() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const importRunsStart = src.indexOf("app.get('/api/wb/import-runs'");
  const importStatusStart = src.indexOf("app.get('/api/wb/import-status'");
  return {
    importRunsRegion: importRunsStart > -1
      ? src.slice(importRunsStart, src.indexOf("app.", importRunsStart + 30))
      : '',
    importStatusRegion: importStatusStart > -1
      ? src.slice(importStatusStart, src.indexOf("app.", importStatusStart + 30))
      : '',
  };
}

// ── testParseFilters tests ──────────────────────────────────────────────

test('testParseFilters: default limit=50, max=200', () => {
  const r1 = testParseFilters({});
  assert.equal(r1.limit, 50);
  const r2 = testParseFilters({ limit: '999' });
  assert.equal(r2.limit, 200);
  const r3 = testParseFilters({ limit: '30' });
  assert.equal(r3.limit, 30);
  const r4 = testParseFilters({ limit: '-5' });
  assert.equal(r4.limit, 50);
  const r5 = testParseFilters({ limit: '0' });
  assert.equal(r5.limit, 50);
});

test('testParseFilters: nullable cabId', () => {
  const r1 = testParseFilters({});
  assert.equal(r1.cabId, null);
  const r2 = testParseFilters({ cabId: '7' });
  assert.equal(r2.cabId, 7);
  const r3 = testParseFilters({ cabId: 'abc' });
  assert.equal(r3.cabId, null);
  const r4 = testParseFilters({ cabId: '-3' });
  assert.equal(r4.cabId, null);
});

test('testParseFilters: nullable dateFrom/dateTo', () => {
  const r1 = testParseFilters({});
  assert.equal(r1.dateFrom, null);
  assert.equal(r1.dateTo, null);
  const r2 = testParseFilters({ dateFrom: '2026-07-01', dateTo: '2026-07-15' });
  assert.equal(r2.dateFrom, '2026-07-01');
  assert.equal(r2.dateTo, '2026-07-15');
  const r3 = testParseFilters({ dateFrom: 'not-a-date', dateTo: '2026-07-15' });
  assert.equal(r3.dateFrom, null);
  assert.equal(r3.dateTo, '2026-07-15');
  const r4 = testParseFilters({ dateFrom: '2026-07-01', dateTo: 'bad' });
  assert.equal(r4.dateTo, null);
});

test('testParseFilters: empty string treated as null', () => {
  const r = testParseFilters({ cabId: '', dateFrom: '', dateTo: '' });
  assert.equal(r.cabId, null);
  assert.equal(r.dateFrom, null);
  assert.equal(r.dateTo, null);
});

// ── Route structure tests ────────────────────────────────────────────────────

test('GET /api/wb/import-runs: SQL excludes source_metrics and candidate_metrics', () => {
  const { importRunsRegion } = extractImportRoutesSrc();
  assert.ok(importRunsRegion.length > 0, 'import-runs route not found');
  assert.doesNotMatch(importRunsRegion, /source_metrics/,
    'SQL in import-runs MUST NOT include source_metrics');
  assert.doesNotMatch(importRunsRegion, /candidate_metrics/,
    'SQL in import-runs MUST NOT include candidate_metrics');
  assert.match(importRunsRegion, /SELECT[\s\S]*?id[\s\S]*?FROM\s+wb_import_runs/,
    'import-runs should query wb_import_runs with safe columns');
});

test('GET /api/wb/import-status: route exists and excludes wb_token', () => {
  const { importStatusRegion } = extractImportRoutesSrc();
  assert.ok(importStatusRegion.length > 0, 'import-status route not found');
  assert.doesNotMatch(importStatusRegion, /wb_token/,
    'import-status route MUST NOT reference wb_token');
});

// ── Startup cleanup test ────────────────────────────────────────────────────

test('startup: marks stale running imports as failed before listen', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const listenIdx = src.indexOf('app.listen(');
  const region = src.slice(Math.max(0, listenIdx - 500), listenIdx);
  assert.match(region, /UPDATE\s+wb_import_runs[\s\S]*?SET\s+status\s*=\s*'failed'/,
    'startup block must mark stale running imports as failed');
  assert.match(region, /status\s*=\s*'running'/,
    'should only target running imports');
  assert.match(region, /finished_at\s*=\s*NOW\(\)/,
    'should set finished_at for cleaned runs');
  assert.match(region, /INTERVAL\s+'30\s*minutes'/,
    'should use 30-minute staleness window');
});

// ── Frontend API method tests ───────────────────────────────────────────────

test('frontend api.js: getImportRuns method exists', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'my-react-app', 'src', 'api.js'), 'utf8'
  );
  assert.match(src, /getImportRuns/,
    'api.js must export getImportRuns');
  assert.match(src, /\/wb\/import-runs/,
    'getImportRuns must call /wb/import-runs');
  assert.match(src, /URLSearchParams/,
    'getImportRuns must use URLSearchParams for filtering');
});

test('frontend api.js: getImportStatus method exists', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'my-react-app', 'src', 'api.js'), 'utf8'
  );
  assert.match(src, /getImportStatus/,
    'api.js must export getImportStatus');
  assert.match(src, /\/wb\/import-status/,
    'getImportStatus must call /wb/import-status');
});
