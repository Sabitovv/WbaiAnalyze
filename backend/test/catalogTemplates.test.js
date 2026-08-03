const test = require('node:test');
const assert = require('node:assert/strict');
const {
  inferCatalogTemplate,
  isAccessoryArticle,
  accessoryCatalogRepair,
} = require('../catalogTemplates');

const inferredAliases = [
  ['nz_tr_talgat11', 'Триммеры садовые', 'Триммер'],
  ['nz_nab_5v1_b_yersin6', 'Гайковерты', 'Набор 5в1 Б'],
  ['nz_g_ta_san_14', 'Гайковерты', 'Гайковёрт'],
  ['fa_shr_b_didar_3', 'Шуруповерты', 'Шурик'],
  ['ah_5v1_b_01', 'Шуруповерты', 'Набор 5в1 Б'],
];

for (const [article, subject, name] of inferredAliases) {
  test(`распознает исторический артикул ${article}`, () => {
    assert.equal(inferCatalogTemplate(article, subject)?.displayName, name);
  });
}

const accessories = [
  ['ah_bl_kp_1_bainazar', 'Блендеры'],
  ['fa_капучинатор_2', 'Блендеры'],
  ['almg_bg_batareika_1', 'Шлифовальные машины'],
  ['almg_g_batareika_1', 'Гайковерты'],
  ['almg_batareiky_111', 'Шуруповерты'],
  ['fa_g_nas_10mm', 'Гайковерты'],
  ['fa_shr_nas_50mm', 'Шуруповерты'],
  ['almg_nas_rake', 'Шуруповерты'],
  ['almg_t_leska', 'Триммеры садовые'],
  ['fa_tr_kat_1', 'Триммеры садовые'],
  ['almg_bolvanka', 'Наборы инструментов'],
];

for (const [article, subject] of accessories) {
  test(`не назначает полный товар аксессуару ${article}`, () => {
    assert.equal(isAccessoryArticle(article), true);
    assert.equal(inferCatalogTemplate(article, subject), null);
  });
}

test('короткие маркеры аксессуаров проверяются как отдельные токены', () => {
  assert.equal(isAccessoryArticle('fa_shr_nastya_1'), false);
  assert.equal(isAccessoryArticle('fa_tr_katya_1'), false);
});

test('не угадывает неизвестный товар ардаш', () => {
  assert.equal(inferCatalogTemplate('ардаш', 'Сучкорезы'), null);
});

test('accessoryCatalogRepair: аксессуар source=wb cost>0 — обнуляет cost,w,d,h', () => {
  const result = accessoryCatalogRepair({
    name: 'Батарейка', article: 'fa_batareika_1', source: 'wb',
    cost: 100, w: 5, d: 5, h: 2,
  });
  assert.deepEqual(result, { cost: 0, w: 0, d: 0, h: 0 });
});

test('accessoryCatalogRepair: source=manual — возвращает null', () => {
  const result = accessoryCatalogRepair({
    name: 'Батарейка', article: 'fa_batareika_1', source: 'manual',
    cost: 100,
  });
  assert.equal(result, null);
});

test('accessoryCatalogRepair: не-аксессуар — возвращает null', () => {
  const result = accessoryCatalogRepair({
    name: 'Шурик', article: 'fa_shr_1', source: 'wb',
    cost: 100,
  });
  assert.equal(result, null);
});

test('accessoryCatalogRepair: аксессуар со всеми нулевыми cost/params — возвращает null', () => {
  const result = accessoryCatalogRepair({
    name: 'Батарейка', article: 'fa_batareika_1', source: 'wb',
    cost: 0, w: 0, d: 0, h: 0,
  });
  assert.equal(result, null);
});
