const baseUrl = process.argv[2] || 'http://localhost:3000/api';
const dateFrom = process.argv[3];
const dateTo = process.argv[4];
const cabId = process.argv[5] || 'all';

if (!dateFrom || !dateTo) {
  console.error('Usage: node scripts/check-report-consistency.js [baseUrl] <dateFrom> <dateTo> [cabId]');
  process.exit(2);
}

const metrics = ['qty', 'rev', 'cost', 'comm', 'ads', 'cab_comm', 'log_f', 'log_r', 'ret', 'profit'];
const dimensions = ['category', 'article', 'product'];
const tolerance = { qty: 0.001, money: 1 };

function totals(rows) {
  return Object.fromEntries(metrics.map(metric => [
    metric,
    rows.reduce((sum, row) => sum + (Number(row[metric]) || 0), 0),
  ]));
}

async function loadReport(name) {
  const query = new URLSearchParams({ dateFrom, dateTo, cabId });
  const response = await fetch(`${baseUrl}/reports/${name}?${query}`);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const [daily, monthly, ...dimensionRows] = await Promise.all(
    ['daily', 'monthly', ...dimensions].map(loadReport)
  );
  const expected = totals(daily);
  const failures = [];

  for (const [name, rows] of [['monthly', monthly], ...dimensions.map((name, index) => [name, dimensionRows[index]])]) {
    const actual = totals(rows);
    for (const metric of metrics) {
      const difference = actual[metric] - expected[metric];
      const allowedDifference = metric === 'qty' ? tolerance.qty : tolerance.money;
      if (Math.abs(difference) > allowedDifference) {
        failures.push({ report: name, metric, expected: expected[metric], actual: actual[metric], difference });
      }
    }
  }

  const productRows = dimensionRows[2];
  const invalidProducts = productRows.filter(row => !String(row.product || '').trim());
  if (invalidProducts.length) failures.push({ report: 'product', metric: 'blank_product', rows: invalidProducts.length });
  const zeroFinancialProducts = productRows.filter(row =>
    Number(row.rev) === 0 && Number(row.cost) === 0 && Number(row.comm) === 0
  );
  if (zeroFinancialProducts.length) {
    failures.push({ report: 'product', metric: 'zero_financial_products', rows: zeroFinancialProducts.length });
  }

  if (failures.length) {
    console.error(JSON.stringify(failures, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, dateFrom, dateTo, cabId, totals: expected }, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
