function compileUsers(rows) {
  return rows.map(user => ({
    ...user,
    regexes: String(user.pattern)
      .split(/[,;]/)
      .map(pattern => pattern.trim())
      .filter(Boolean)
      .map(pattern => {
        try { return new RegExp(pattern, 'i'); }
        catch { return null; }
      })
      .filter(Boolean),
  }));
}

function findUser(text, users) {
  return users.find(user => user.regexes.some(regex => regex.test(String(text || '')))) || null;
}

async function reassignStoredCampaigns(pool) {
  const { rows: userRows } = await pool.query(
    `SELECT id, pattern
     FROM users
     WHERE pattern IS NOT NULL AND pattern <> ''
     ORDER BY id`
  );
  const users = compileUsers(userRows);
  const { rows: campaigns } = await pool.query(
    `SELECT DISTINCT campaign_name
     FROM wb_advert_stats
     WHERE campaign_name IS NOT NULL`
  );

  const namesByUser = new Map(users.map(user => [user.id, []]));
  const unassigned = [];
  for (const { campaign_name: name } of campaigns) {
    const user = findUser(name, users);
    if (user) namesByUser.get(user.id).push(name);
    else unassigned.push(name);
  }

  const client = await pool.connect();
  let updated = 0;
  try {
    await client.query('BEGIN');
    for (const [userId, names] of namesByUser) {
      if (!names.length) continue;
      const result = await client.query(
        `UPDATE wb_advert_stats
         SET user_id=$1, updated_at=NOW()
         WHERE campaign_name = ANY($2::text[]) AND user_id IS DISTINCT FROM $1`,
        [userId, names]
      );
      updated += result.rowCount;
    }
    if (unassigned.length) {
      const result = await client.query(
        `UPDATE wb_advert_stats
         SET user_id=NULL, updated_at=NOW()
         WHERE campaign_name = ANY($1::text[]) AND user_id IS NOT NULL`,
        [unassigned]
      );
      updated += result.rowCount;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return updated;
}

async function rebuildAdShareManagerSales(pool, options = {}) {
  const userId = options.userId || null;
  const dateFrom = options.dateFrom || null;
  const dateTo = options.dateTo || null;
  const cabId = options.cabId || null;
  const params = [userId, dateFrom, dateTo, cabId];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM wb_manager_sales
       WHERE source='ads_share'
         AND ($1::int IS NULL OR user_id=$1)
         AND ($2::date IS NULL OR date >= $2)
         AND ($3::date IS NULL OR date <= $3)
         AND ($4::int IS NULL OR cab_id=$4)`,
      params
    );
    const result = await client.query(
      `WITH manager_ads AS (
         SELECT cab_id, user_id, date, SUM(sum) AS ads
         FROM wb_advert_stats
         WHERE user_id IS NOT NULL
           AND ($1::int IS NULL OR user_id=$1)
           AND ($2::date IS NULL OR date >= $2)
           AND ($3::date IS NULL OR date <= $3)
           AND ($4::int IS NULL OR cab_id=$4)
         GROUP BY cab_id, user_id, date
       ),
       total_ads AS (
         SELECT cab_id, date, SUM(sum) AS ads
         FROM wb_advert_stats
         WHERE ($2::date IS NULL OR date >= $2)
           AND ($3::date IS NULL OR date <= $3)
           AND ($4::int IS NULL OR cab_id=$4)
         GROUP BY cab_id, date
       ),
       shares AS (
         SELECT ws.cab_id, ma.user_id, ws.date, ma.ads,
                ma.ads / NULLIF(ta.ads, 0) AS share,
                ws.rev, ws.cost, ws.comm, ws.cab_comm, ws.log_f, ws.log_r,
                CASE WHEN COALESCE(ws.ret, 0) <> 0 THEN ws.ret
                     ELSE ws.rev * (1 - GREATEST(COALESCE(c.buyout, 88), 0.01) / 100)
                END AS ret
         FROM manager_ads ma
         JOIN total_ads ta ON ta.cab_id=ma.cab_id AND ta.date=ma.date
         JOIN wb_sales ws ON ws.cab_id=ma.cab_id AND ws.date=ma.date
         JOIN cabs c ON c.id=ma.cab_id
         WHERE ta.ads > 0
           AND NOT EXISTS (
             SELECT 1 FROM wb_manager_sales_detail d
             WHERE d.cab_id=ma.cab_id AND d.user_id=ma.user_id AND d.date=ma.date
           )
       ),
       metrics AS (
         SELECT cab_id, user_id, date,
                ROUND(rev * share, 2) AS rev,
                ROUND(ads, 2) AS ads,
                ROUND(cost * share, 2) AS cost,
                ROUND(comm * share, 2) AS comm,
                ROUND(cab_comm * share, 2) AS cab_comm,
                ROUND(log_f * share, 2) AS log_f,
                ROUND(log_r * share, 2) AS log_r,
                ROUND(ret * share, 2) AS ret
         FROM shares
       ),
       calculated AS (
         SELECT *,
                ROUND(rev - ret - cost - ads - comm - cab_comm - log_f - log_r, 2) AS profit
         FROM metrics
       )
       INSERT INTO wb_manager_sales
         (cab_id, user_id, date, rev, ads, cost, comm, cab_comm, log_f, log_r,
          ret, profit, margin, drr, source, updated_at)
       SELECT cab_id, user_id, date, rev, ads, cost, comm, cab_comm, log_f, log_r,
              ret, profit,
              CASE WHEN rev-ret > 0 THEN ROUND(profit / (rev-ret) * 100, 2) ELSE 0 END,
              CASE WHEN rev-ret > 0 THEN ROUND(ads / (rev-ret) * 100, 2) ELSE 0 END,
              'ads_share', NOW()
       FROM calculated
       ON CONFLICT (cab_id, user_id, date) DO NOTHING
    `,
      params
    );
    await client.query('COMMIT');
    return result.rowCount;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function refreshStoredManagerAssignments(pool, options = {}) {
  const campaigns = await reassignStoredCampaigns(pool);
  const sales = await rebuildAdShareManagerSales(pool, options);
  return { campaigns, sales };
}

module.exports = { reassignStoredCampaigns, rebuildAdShareManagerSales, refreshStoredManagerAssignments };
