const pool = require('../db');
const wb = require('../wb');

async function main() {
  const cabId = parseInt(process.argv[2], 10) || 8;
  const dateFrom = process.argv[3] || '2026-07-24';
  const dateTo = process.argv[4] || '2026-07-30';

  const { rows } = await pool.query('SELECT * FROM cabs WHERE id=$1', [cabId]);
  if (!rows.length) {
    console.error(`Cab ${cabId} not found`);
    process.exit(1);
  }
  const cab = rows[0];
  console.log(`Manual import: cab ${cab.id} (${cab.name}) ${dateFrom}..${dateTo}`);
  try {
    const r = await wb.importCabSales(pool, cab, dateFrom, dateTo, { ads: { chunkSize: 50, chunkPauseMs: 30000 } });
    console.log('Result:', r);
  } catch (e) {
    console.error('Import error:', e.message);
  } finally {
    await pool.end();
  }
}

main();
