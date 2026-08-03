const CATALOG_TEMPLATE_NAMES = [
  'Шурик красный',
  'Лазер красный',
  'Гайковёрт',
  'Набор 5в1 Б',
  'Набор 5в1 М',
  'Набор 3в1',
  'Болгарка',
  'Пила',
  'Перфоратор',
  'Отпариватель',
  'Блендер 4в1',
  'Блендер 5в1',
  'Блендер 6в1',
  'Аэрогриль',
  'Культиватор',
  'Триммер',
  'Кресло красный',
  'Кресло черный',
];

function normalizeProductText(value) {
  return String(value || '')
    .trim()
    .replace(/ё/g, 'е')
    .replace(/Ё/g, 'Е')
    .toUpperCase();
}

function isAccessoryArticle(value) {
  const text = normalizeProductText(value).replace(/[^A-ZА-Я0-9]+/g, ' ').trim();
  if (!text) return false;
  if (/(^| )(KP|NAS|KAT)( |$)/.test(text)) return true;
  return /(КАПУЧ|KAPUCH|БАТАРЕ|BATAREIK|BATAR|НАСАДК|NASADK|ЛЕСК|LESKA|БОЛВАНК|BOLVANK)/.test(text);
}

function hasToken(text, token) {
  return new RegExp(`(^|[_\\s])${token}($|[_\\s])`, 'i').test(text);
}

function inferCatalogTemplate(article, subject = '') {
  if (isAccessoryArticle(article)) return null;
  const a = normalizeProductText(article).replace(/["']/g, '');
  const s = normalizeProductText(subject);
  if (!a && !s) return null;

  const isBlender = s.includes('БЛЕНДЕР') || hasToken(a, 'BL');
  if (isBlender) {
    if (/6[ВV]1/i.test(a)) return { templateName: 'Блендер 6в1', displayName: 'Блендер 6в1' };
    if (/4[ВV]1/i.test(a)) return { templateName: 'Блендер 4в1', displayName: 'Блендер 4в1' };
    return { templateName: 'Блендер 5в1', displayName: 'Блендер 5в1' };
  }

  if (a.includes('NAB') || s.includes('НАБОР') || /3[ВV]1/i.test(a) || /5[ВV]1/i.test(a)) {
    if (/5[ВV]1/i.test(a)) {
      if (/(^|[_\s])B($|[_\s])/i.test(a)) return { templateName: 'Набор 5в1 Б', displayName: 'Набор 5в1 Б' };
      return { templateName: 'Набор 5в1 М', displayName: 'Набор 5в1 М' };
    }
    return { templateName: 'Набор 3в1', displayName: 'Набор 3в1' };
  }

  if (a.includes('KULTIVATOR') || hasToken(a, 'KLT') || s.includes('КУЛЬТИВАТОР')) {
    return { templateName: 'Культиватор', displayName: 'Культиватор' };
  }
  if (a.includes('TRIMMER') || hasToken(a, 'TR') || s.includes('ТРИММЕР')) {
    return { templateName: 'Триммер', displayName: 'Триммер' };
  }
  if (s.includes('КРЕСЛ') || hasToken(a, 'KR')) {
    if (a.includes('BLACK')) return { templateName: 'Кресло черный', displayName: 'Кресло черный' };
    return { templateName: 'Кресло красный', displayName: 'Кресло красный' };
  }
  if (hasToken(a, 'OTP') || a.includes('ОТПАРИВАТЕЛЬ') || s.includes('ОТПАРИВАТЕЛ')) {
    return { templateName: 'Отпариватель', displayName: 'Отпариватель' };
  }
  if (a.includes('P_TA') || s.includes('ЭЛЕКТРОПИЛ') || s.includes('ПИЛ')) {
    return { templateName: 'Пила', displayName: 'Пила' };
  }
  if (hasToken(a, 'BG') || hasToken(a, 'БМ') || s.includes('ШЛИФОВАЛЬ')) {
    return { templateName: 'Болгарка', displayName: 'Болгарка' };
  }
  if (hasToken(a, 'G_M') || hasToken(a, 'ГМ') || s.includes('ГАЙКОВЕРТ')) {
    return { templateName: 'Гайковёрт', displayName: 'Гайковёрт' };
  }
  if (hasToken(a, 'LZ') || hasToken(a, 'ЛМ') || s.includes('НИВЕЛИР')) {
    return { templateName: 'Лазер красный', displayName: 'Лазер' };
  }
  if (hasToken(a, 'P') || s.includes('ПЕРФОРАТОР')) {
    return { templateName: 'Перфоратор', displayName: 'Перфоратор' };
  }
  if (hasToken(a, 'A_TA') || s.includes('АЭРОГРИЛ')) {
    return { templateName: 'Аэрогриль', displayName: 'Аэрогриль' };
  }
  if (hasToken(a, 'SHR') || s.includes('ШУРУПОВЕРТ')) {
    return { templateName: 'Шурик красный', displayName: 'Шурик' };
  }

  return null;
}

function accessoryCatalogRepair(row) {
  if (!isAccessoryArticle(row.article)) return null;
  if (row.source === 'manual') return null;
  if (!(row.cost > 0 || row.w > 0 || row.d > 0 || row.h > 0)) return null;
  return { cost: 0, w: 0, d: 0, h: 0 };
}

module.exports = { CATALOG_TEMPLATE_NAMES, inferCatalogTemplate, normalizeProductText, isAccessoryArticle, accessoryCatalogRepair };
