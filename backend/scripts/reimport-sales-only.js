require('dotenv').config();
const pool = require('../db');
const { fetchReportDetailByPeriod, importCabSalesFromRows } = require('../wb');

const cabId = parseInt(process.argv[2], 10) || 13;
const dateFrom = process.argv[3] || '2026-07-01';
const dateTo = process.argv[4] || '2026-07-30';

async function main() {
  const { rows } = await pool.query('SELECT * FROM cabs WHERE id=$1', [cabId]);
  if (!rows.length) {
    console.error(`Cab ${cabId} not found`);
    process.exit(1);
  }
  const cab = rows[0];
  const token = process.env.WB_TOKEN || cab.wb_token;
  if (!token) {
    console.error(`Token not set for cab ${cabId}`);
    process.exit(1);
  }
  console.log(`Sales-only re-import cab ${cab.id} (${cab.name}) ${dateFrom}..${dateTo}`);
  const reportRows = await fetchReportDetailByPeriod(token, dateFrom, dateTo);
  console.log(`Fetched ${reportRows.length} report rows`);
  const result = await importCabSalesFromRows(pool, cab, reportRows, {}, {});
  console.log('Result:', JSON.stringify(result, null, 2));
  await pool.end();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
