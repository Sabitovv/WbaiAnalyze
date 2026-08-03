const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findCatalogProduct,
  isFinancialDocumentRow,
  allocateCents,
} = require('../wb');

test('учитывает только документы продажи и возврата', () => {
  assert.equal(isFinancialDocumentRow({ doc_type_name: 'Продажа' }), true);
  assert.equal(isFinancialDocumentRow({ doc_type_name: ' возврат ' }), true);
  assert.equal(isFinancialDocumentRow({ doc_type_name: '' }), false);
  assert.equal(isFinancialDocumentRow({ doc_type_name: 'Логистика' }), false);
});

test('не использует автоматически назначенный полный товар для аксессуара', () => {
  const article = 'almg_bg_batareika_1';
  const product = { article, name: 'Болгарка', source: 'wb', cost: 16000 };
  assert.equal(findCatalogProduct(article, { [article]: product }), null);
});

test('разрешает точную ручную карточку аксессуара', () => {
  const article = 'almg_bg_batareika_1';
  const product = { article, name: 'Аккумулятор', source: 'manual', cost: 2500 };
  assert.equal(findCatalogProduct(article, { [article]: product }), product);
});

test('сохраняет обычное сопоставление товара по суффиксу менеджера', () => {
  const product = { article: 'base_shr', name: 'Шурик', source: 'manual', cost: 7842 };
  assert.equal(findCatalogProduct('base_shr_manager', { base_shr: product }), product);
});

test('не принимает произвольное строковое начало за артикул каталога', () => {
  const product = { article: 'abc', name: 'Шурик', source: 'manual', cost: 7842 };
  assert.equal(findCatalogProduct('abcd', { abc: product }), null);
});

test('allocateCents spreads equally when all weights are zero', () => {
  const entries = [
    { key: 'a', weight: 0 },
    { key: 'b', weight: 0 },
    { key: 'c', weight: 0 },
  ];
  const result = allocateCents(7, entries);
  assert.equal(result.get('a'), 3);
  assert.equal(result.get('b'), 2);
  assert.equal(result.get('c'), 2);
  assert.equal([...result.values()].reduce((s, v) => s + v, 0), 7);
});

test('allocateCents distributes exact proportional amounts', () => {
  const entries = [
    { key: 'a', weight: 50 },
    { key: 'b', weight: 30 },
    { key: 'c', weight: 20 },
  ];
  const result = allocateCents(100, entries);
  assert.equal(result.get('a'), 50);
  assert.equal(result.get('b'), 30);
  assert.equal(result.get('c'), 20);
  assert.equal([...result.values()].reduce((s, v) => s + v, 0), 100);
});

test('allocateCents handles remainder with highest-fraction-first', () => {
  const entries = [{ key: 'a', weight: 1 }, { key: 'b', weight: 2 }];
  const result = allocateCents(10, entries);
  const sum = [...result.values()].reduce((s, v) => s + v, 0);
  assert.equal(sum, 10);
  assert.ok(result.get('a') >= 0);
  assert.ok(result.get('b') >= 0);
});

test('allocateCents returns zero map for zero total', () => {
  const entries = [{ key: 'a', weight: 100 }];
  const result = allocateCents(0, entries);
  assert.equal(result.get('a'), 0);
});

test('allocateCents returns zero map for empty entries', () => {
  const result = allocateCents(50, []);
  assert.equal(result.size, 0);
});
