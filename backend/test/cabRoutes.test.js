const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function getCabRouteRegion(src) {
  const start = src.indexOf("app.get('/api/cabs/:id'");
  const before = src.lastIndexOf('// ──', start - 1);
  const after = src.indexOf("app.", start + 30);
  const end = after > 0 ? after : start + 500;
  return { start, end, region: src.slice(before >= 0 ? before : start, end) };
}

test('GET /api/cabs/:id SELECT исключает wb_token', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const { region } = getCabRouteRegion(src);

  assert.match(region, /SELECT\s+id,\s*name,\s*buyout,\s*cab_type,\s*commission,\s*last_synced_at\s+FROM\s+cabs/,
    'SELECT в GET /api/cabs/:id должен возвращать только безопасные поля');
  assert.doesNotMatch(region, /SELECT[\s\S]*?wb_token[\s\S]*?FROM\s+cabs/,
    'SELECT в GET /api/cabs/:id не должен включать wb_token');
});

test('PUT /api/cabs/:id RETURNING исключает wb_token', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

  assert.match(src, /app\.put\(\s*'\/api\/cabs\/:id'[\s\S]*?RETURNING\s+id,\s*name,\s*buyout,\s*cab_type,\s*commission,\s*last_synced_at/,
    'PUT /api/cabs/:id RETURNING должен исключать wb_token');
});

test('frontend api.js не использует wb_token в setEditCab', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'my-react-app', 'src', 'App.jsx'), 'utf8');

  const setEditCabBlock = src.match(/setEditCab\(\{[^}]*wb_token[^}]*\}\)/g);
  if (setEditCabBlock) {
    for (const block of setEditCabBlock) {
      assert.doesNotMatch(block, /full\.wb_token/,
        'setEditCab не должен читать wb_token из ответа API');
    }
  }
});
