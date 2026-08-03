require('dotenv').config();
const pool = require('../db');
const { importCabSales } = require('../wb');

const cabId = parseInt(process.argv[2], 10) || 13;
const dateFrom = process.argv[3] || '2026-07-24';
const dateTo = process.argv[4] || '2026-07-30';
const chunkSize = parseInt(process.argv[5], 10) || 1;
const chunkPauseMs = parseInt(process.argv[6], 10) || 20000;

async function main() {
  const { rows } = await pool.query('SELECT * FROM cabs WHERE id=$1', [cabId]);
  if (!rows.length) {
    console.error(`Cab ${cabId} not found`);
    process.exit(1);
  }
  const cab = rows[0];
  console.log(`Re-import cab ${cab.id} (${cab.name}) ${dateFrom}..${dateTo} with chunkSize=${chunkSize}, pause=${chunkPauseMs}ms`);
  const result = await importCabSales(pool, cab, dateFrom, dateTo, { ads: { chunkSize, chunkPauseMs } });
  console.log('Result:', JSON.stringify(result, null, 2));
  await pool.end();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
