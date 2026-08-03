require('dotenv').config();
const pool = require('../db');
const {
  importCabSales,
  fetchCabOperationalRows,
  importCabSalesFromRows,
} = require('../wb');
const { rebuildAdShareManagerSales } = require('../managerAssignments');
const { toDateKey } = require('../dateUtils');

const dateFrom = process.argv[2] || new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
const dateTo = process.argv[3] || new Date().toISOString().split('T')[0];
const concurrency = Math.max(1, parseInt(process.argv[4], 10) || 3);

async function loadAds(cabId) {
  const { rows: totals } = await pool.query(
    `SELECT date, SUM(sum) AS ads
     FROM wb_advert_stats
     WHERE cab_id=$1 AND date BETWEEN $2 AND $3
     GROUP BY date`,
    [cabId, dateFrom, dateTo]
  );
  const adsByDate = Object.fromEntries(
    totals.map(row => [toDateKey(row.date), +row.ads])
  );

  const { rows: direct } = await pool.query(
    `SELECT date, user_id, SUM(sum) AS ads
     FROM wb_advert_stats
     WHERE cab_id=$1 AND user_id IS NOT NULL AND date BETWEEN $2 AND $3
     GROUP BY date, user_id`,
    [cabId, dateFrom, dateTo]
  );
  const directAdsByManagerDate = {};
  for (const row of direct) {
    const date = toDateKey(row.date);
    if (!directAdsByManagerDate[date]) directAdsByManagerDate[date] = {};
    directAdsByManagerDate[date][row.user_id] = +row.ads;
  }
  return { adsByDate, directAdsByManagerDate };
}

async function backfillCab(cab) {
  try {
    const result = await importCabSales(pool, cab, dateFrom, dateTo, { maxAttempts: 1 });
    await rebuildAdShareManagerSales(pool, { cabId: cab.id, dateFrom, dateTo });
    return result;
  } catch (error) {
    return { cabId: cab.id, name: cab.name, error: error.message, status: 'failed' };
  }
}

async function main() {
  const { rows: cabs } = await pool.query(
    `SELECT * FROM cabs
     WHERE wb_token IS NOT NULL AND wb_token <> ''
     ORDER BY id`
  );
  console.log(`Backfill ${dateFrom}..${dateTo}: ${cabs.length} cabinets, concurrency ${concurrency}`);

  let cursor = 0;
  const results = [];
  let hasSystemFailure = false;
  const workers = Array.from({ length: Math.min(concurrency, cabs.length) }, async () => {
    while (cursor < cabs.length) {
      const cab = cabs[cursor++];
      try {
        const result = await backfillCab(cab);
        results.push(result);
        const firstIssueCode = (Array.isArray(result.issues) && result.issues[0]?.code)
          ? result.issues[0].code
          : '';
        console.log(
          `runId=${result.runId || '-'} status=${result.status || 'failed'} attempts=${result.attempts || 0} ` +
          `fetched=${result.fetchedRows || 0} accepted=${result.acceptedRows || 0} ` +
          `rejected=${result.rejectedRows || 0} issue=${firstIssueCode} ` +
          `cabId=${cab.id} name=${cab.name}`
        );
        if (result.status === 'failed') hasSystemFailure = true;
      } catch (error) {
        results.push({ cabId: cab.id, name: cab.name, error: error.message, status: 'failed' });
        console.error(`${cab.id} ${cab.name}: ${error.message}`);
        hasSystemFailure = true;
      }
    }
  });
  await Promise.all(workers);

  const blocked = results.filter(r => r.status === 'blocked').length;
  const verified = results.filter(r => r.status === 'verified' || r.status === 'provisional').length;
  const failed = results.filter(r => r.status === 'failed').length;
  console.log(`Backfill summary: ${verified} ok, ${blocked} blocked, ${failed} failed out of ${results.length}`);
  await pool.end();
  process.exit(hasSystemFailure ? 1 : 0);
}

main().catch(async error => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
