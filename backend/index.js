require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const pool    = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

// ── Создать таблицу user_cabs если нет ───────────────────────────────────────
pool.query(`ALTER TABLE cabs ADD COLUMN IF NOT EXISTS wb_token TEXT`).catch(e => console.error('ALTER wb_token:', e.message));
pool.query(`ALTER TABLE cabs ADD COLUMN IF NOT EXISTS cab_type TEXT`).catch(e => console.error('ALTER cab_type:', e.message));
pool.query(`ALTER TABLE cabs ADD COLUMN IF NOT EXISTS commission NUMERIC`).catch(e => console.error('ALTER commission:', e.message));
pool.query(`ALTER TABLE cabs ADD COLUMN IF NOT EXISTS wb_store_id TEXT`).catch(e => console.error('ALTER wb_store_id:', e.message));
pool.query(`ALTER TABLE cabs ADD COLUMN IF NOT EXISTS currency TEXT`).catch(e => console.error('ALTER currency:', e.message));
pool.query(`ALTER TABLE cabs ADD COLUMN IF NOT EXISTS buyout INTEGER DEFAULT 88`);
pool.query(`
  CREATE TABLE IF NOT EXISTS user_cabs (
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    cab_id  INTEGER REFERENCES cabs(id)  ON DELETE CASCADE,
    PRIMARY KEY (user_id, cab_id)
  )
`).catch(e => console.error('user_cabs init error:', e.message));

pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS salary_pct NUMERIC DEFAULT 0`)
  .catch(e => console.error('salary_pct init error:', e.message));

pool.query(`CREATE TABLE IF NOT EXISTS teams (
  id   SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
)`).catch(e => console.error('teams init error:', e.message));

pool.query(`CREATE TABLE IF NOT EXISTS team_members (
  team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
)`).catch(e => console.error('team_members init error:', e.message));

pool.query(`CREATE TABLE IF NOT EXISTS history_items (
  id         SERIAL PRIMARY KEY,
  history_id INTEGER REFERENCES history(id) ON DELETE CASCADE,
  product    TEXT,
  qty        NUMERIC DEFAULT 0,
  cost       NUMERIC DEFAULT 0,
  comm       NUMERIC DEFAULT 0
)`).catch(e => console.error('history_items init error:', e.message));

pool.query(`ALTER TABLE history ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL`)
  .catch(e => console.error('history user_id init error:', e.message));

// Backfill user_id for existing records where it's null
pool.query(`
  UPDATE history h SET user_id = u.id
  FROM users u
  WHERE h.user_id IS NULL AND LOWER(h.user_login) = LOWER(u.login)
`).catch(e => console.error('history backfill error:', e.message));

pool.query(`CREATE TABLE IF NOT EXISTS user_goals (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  month   TEXT NOT NULL,
  goal    NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, month)
)`).catch(e => console.error('user_goals init error:', e.message));

pool.query(`CREATE TABLE IF NOT EXISTS wb_advert_stats (
  id SERIAL PRIMARY KEY,
  cab_id INTEGER REFERENCES cabs(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  campaign_id BIGINT NOT NULL,
  campaign_name TEXT,
  campaign_type INTEGER,
  status INTEGER,
  date DATE NOT NULL,
  views INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  ctr NUMERIC DEFAULT 0,
  cpc NUMERIC DEFAULT 0,
  sum NUMERIC DEFAULT 0,
  atbs INTEGER DEFAULT 0,
  orders INTEGER DEFAULT 0,
  cr NUMERIC DEFAULT 0,
  shks INTEGER DEFAULT 0,
  sum_price NUMERIC DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(cab_id, campaign_id, date)
)`).catch(e => console.error('wb_advert_stats init error:', e.message));

// ── Курс RUB/KZT ─────────────────────────────────────────────────────────────
app.get('/api/rate', async (_req, res) => {
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/RUB');
    const data = await r.json();
    const kzt = data.rates?.KZT;
    if (!kzt) throw new Error('No KZT rate');
    res.json({ rate: +kzt.toFixed(4), date: data.time_last_update_utc });
  } catch (e) {
    // фолбэк: ЦБ РФ XML
    try {
      const r2 = await fetch('https://www.cbr.ru/scripts/XML_daily.asp');
      const xml = await r2.text();
      const m = xml.match(/KZT[\s\S]*?<Value>([\d,]+)<\/Value>/);
      const rubPerKzt = m ? parseFloat(m[1].replace(',', '.')) : null;
      if (!rubPerKzt) throw new Error('parse fail');
      res.json({ rate: +(1 / rubPerKzt * 100).toFixed(4), date: new Date().toUTCString() });
    } catch { res.status(500).json({ error: e.message }); }
  }
});

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { login, password } = req.body;
  try {
    const { rows } = await pool.query(`SELECT * FROM users WHERE login=$1`, [login]);
    if (!rows.length) return res.status(401).json({ error: 'Неверный логин или пароль' });
    const ok = await bcrypt.compare(password, rows[0].password);
    if (!ok)  return res.status(401).json({ error: 'Неверный логин или пароль' });
    const { password: _, ...user } = rows[0];
    const { rows: cabRows } = await pool.query(
      `SELECT cab_id FROM user_cabs WHERE user_id=$1`, [user.id]
    );
    user.cab_ids = cabRows.map(r => r.cab_id);
    res.json(user);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/register', async (req, res) => {
  const { login, password, name } = req.body;
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (login, password, name, role) VALUES ($1,$2,$3,'employee') RETURNING id,login,name,role`,
      [login, hash, name]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Логин уже занят' });
    res.status(500).json({ error: e.message });
  }
});

// ── Users ─────────────────────────────────────────────────────────────────────
app.get('/api/users', async (_req, res) => {
  const { rows } = await pool.query(`SELECT id,login,name,role,created_at,salary_pct FROM users ORDER BY id`);
  const { rows: cabRows } = await pool.query(`SELECT user_id, cab_id FROM user_cabs`);
  const cabMap = {};
  cabRows.forEach(r => {
    if (!cabMap[r.user_id]) cabMap[r.user_id] = [];
    cabMap[r.user_id].push(r.cab_id);
  });
  res.json(rows.map(u => ({ ...u, cab_ids: cabMap[u.id] || [] })));
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const { rows: admins } = await pool.query(`SELECT id FROM users WHERE role='admin'`);
    const target = await pool.query(`SELECT role FROM users WHERE id=$1`, [req.params.id]);
    if (target.rows[0]?.role === 'admin' && admins.length <= 1)
      return res.status(400).json({ error: 'Нельзя удалить последнего администратора' });
    await pool.query(`DELETE FROM users WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── User-Cabs назначение ──────────────────────────────────────────────────────
app.get('/api/user-cabs/:userId', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT cab_id FROM user_cabs WHERE user_id=$1`, [req.params.userId]
  );
  res.json(rows.map(r => r.cab_id));
});

app.put('/api/user-cabs/:userId', async (req, res) => {
  const userId = req.params.userId;
  const cabIds = req.body.cab_ids || [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM user_cabs WHERE user_id=$1`, [userId]);
    for (const cabId of cabIds) {
      await client.query(
        `INSERT INTO user_cabs (user_id, cab_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [userId, cabId]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, cab_ids: cabIds });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ── Catalog ───────────────────────────────────────────────────────────────────
app.get('/api/catalog', async (_req, res) => {
  const { rows } = await pool.query(`SELECT * FROM catalog ORDER BY id`);
  res.json(rows);
});

app.post('/api/catalog', async (req, res) => {
  const { name, cost, comm, w, d, h } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO catalog (name,cost,comm,w,d,h) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name, cost, comm, w, d, h]
  );
  res.json(rows[0]);
});

app.put('/api/catalog/:id', async (req, res) => {
  const { name, cost, comm, w, d, h } = req.body;
  const { rows } = await pool.query(
    `UPDATE catalog SET name=$1,cost=$2,comm=$3,w=$4,d=$5,h=$6 WHERE id=$7 RETURNING *`,
    [name, cost, comm, w, d, h, req.params.id]
  );
  res.json(rows[0]);
});

app.delete('/api/catalog/:id', async (req, res) => {
  await pool.query(`DELETE FROM catalog WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/catalog/import-commission', async (req, res) => {
  try {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    await new Promise((resolve, reject) => { req.on('end', resolve); req.on('error', reject); });
    const buf = Buffer.concat(chunks);
    const match = /Content-Type:[^\r\n]*\s([\s\S]*?)------/.exec(buf.toString('latin1'));
    if (!match) return res.status(400).json({ error: 'Файл не распознан' });
    const body = match[1];
    const headerEnd = body.indexOf('\r\n\r\n');
    if (headerEnd < 0) return res.status(400).json({ error: 'Неверный формат файла' });
    const fileData = Buffer.from(body.slice(headerEnd + 4).trim(), 'latin1');
    const XLSX = require('xlsx');
    const wb = XLSX.read(fileData);
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    const rates = [];
    for (const r of rows) {
      if (!r || r.length < 2) continue;
      const article = String(r[0]).replace(/[^0-9]/g, '');
      const comm = parseFloat(String(r[1]).replace(',', '.'));
      if (article && !isNaN(comm) && comm > 0) rates.push({ article, comm });
      else if (article && !isNaN(comm)) rates.push({ article, comm: 0 });
    }
    res.json({ rates, count: rates.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/catalog/apply-commission', async (req, res) => {
  try {
    const { rates } = req.body;
    if (!Array.isArray(rates)) return res.status(400).json({ error: 'rates должен быть массивом' });
    const client = await pool.connect();
    let updated = 0;
    try {
      await client.query('BEGIN');
      for (const r of rates) {
        if (!r.article) continue;
        const { rowCount } = await client.query(
          `UPDATE catalog SET comm=$1 WHERE article=$2`, [r.comm, r.article]
        );
        updated += rowCount;
      }
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); throw err; }
    finally { client.release(); }
    res.json({ updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Cabs ─────────────────────────────────────────────────────────────────────
app.get('/api/cabs', async (_req, res) => {
  const { rows } = await pool.query(`SELECT * FROM cabs ORDER BY id`);
  res.json(rows);
});

app.post('/api/cabs', async (req, res) => {
  try {
    const { name, buyout = 88 } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO cabs (name, buyout) VALUES ($1,$2) RETURNING *`, [name, buyout]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Уже существует' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/cabs/:id', async (req, res) => {
  const { name, buyout } = req.body;
  const { rows } = await pool.query(
    `UPDATE cabs SET name=COALESCE($1,name), buyout=COALESCE($2,buyout) WHERE id=$3 RETURNING *`,
    [name, buyout, req.params.id]
  );
  res.json(rows[0]);
});

app.get('/api/cabs/:id', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM cabs WHERE id=$1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Не найден' });
  res.json(rows[0]);
});

app.delete('/api/cabs/:id', async (req, res) => {
  await pool.query(`DELETE FROM cabs WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

// ── History ───────────────────────────────────────────────────────────────────
app.get('/api/history', async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT h.*, COALESCE(h.user_id, u.id) AS user_id
    FROM history h
    LEFT JOIN users u ON LOWER(u.login) = LOWER(h.user_login)
    ORDER BY h.created_at DESC
  `);
  res.json(rows);
});

app.post('/api/history', async (req, res) => {
  const { date, cabinet, user_login, user_id, rev, ads, cost, comm, cab_comm, log_f, log_r, ret, profit, margin, drr, comment, items } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO history (date,cabinet,user_login,user_id,rev,ads,cost,comm,cab_comm,log_f,log_r,ret,profit,margin,drr,comment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [date, cabinet, user_login, user_id || null, rev, ads, cost, comm, cab_comm||0, log_f, log_r, ret, profit, margin, drr, comment||'']
    );
    const histId = rows[0].id;
    if (Array.isArray(items)) {
      for (const it of items) {
        if (!it.product || !it.qty) continue;
        await client.query(
          `INSERT INTO history_items (history_id, product, qty, cost, comm) VALUES ($1,$2,$3,$4,$5)`,
          [histId, it.product, it.qty || 0, it.cost || 0, it.comm || 0]
        );
      }
    }
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.get('/api/history-items', async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT hi.*, h.date, h.cabinet, h.user_login, h.user_id
    FROM history_items hi
    JOIN history h ON h.id = hi.history_id
    ORDER BY h.date DESC
  `);
  res.json(rows);
});

app.put('/api/history/:id', async (req, res) => {
  const { date, cabinet, rev, ads, cost, comm, cab_comm, log_f, log_r, ret, profit, margin, drr, comment } = req.body;
  const { rows } = await pool.query(
    `UPDATE history SET date=$1,cabinet=$2,rev=$3,ads=$4,cost=$5,comm=$6,cab_comm=$7,log_f=$8,log_r=$9,ret=$10,profit=$11,margin=$12,drr=$13,comment=$14 WHERE id=$15 RETURNING *`,
    [date, cabinet, rev, ads, cost, comm, cab_comm||0, log_f, log_r, ret, profit, margin, drr, comment||'', req.params.id]
  );
  res.json(rows[0]);
});

app.delete('/api/history/:id', async (req, res) => {
  await pool.query(`DELETE FROM history WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/history', async (_req, res) => {
  await pool.query(`DELETE FROM history`);
  res.json({ ok: true });
});

// ── Teams ─────────────────────────────────────────────────────────────────────
app.get('/api/teams', async (_req, res) => {
  const { rows: teams } = await pool.query(`SELECT * FROM teams ORDER BY id`);
  const { rows: members } = await pool.query(`SELECT team_id, user_id FROM team_members`);
  const map = {};
  members.forEach(m => { if (!map[m.team_id]) map[m.team_id] = []; map[m.team_id].push(m.user_id); });
  res.json(teams.map(t => ({ ...t, member_ids: map[t.id] || [] })));
});
app.post('/api/teams', async (req, res) => {
  try {
    const { rows } = await pool.query(`INSERT INTO teams (name) VALUES ($1) RETURNING *`, [req.body.name]);
    res.json({ ...rows[0], member_ids: [] });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Команда уже существует' });
    res.status(500).json({ error: e.message });
  }
});
app.delete('/api/teams/:id', async (req, res) => {
  await pool.query(`DELETE FROM teams WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});
app.put('/api/teams/:id/members', async (req, res) => {
  const { user_ids = [] } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM team_members WHERE team_id=$1`, [req.params.id]);
    for (const uid of user_ids)
      await client.query(`INSERT INTO team_members (team_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.params.id, uid]);
    await client.query('COMMIT');
    res.json({ ok: true, user_ids });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

// ── Change password ───────────────────────────────────────────────────────────
app.put('/api/users/:id/password', async (req, res) => {
  const { old_password, new_password } = req.body;
  try {
    const { rows } = await pool.query(`SELECT * FROM users WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Пользователь не найден' });
    const ok = await bcrypt.compare(old_password, rows[0].password);
    if (!ok) return res.status(400).json({ error: 'Неверный текущий пароль' });
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query(`UPDATE users SET password=$1 WHERE id=$2`, [hash, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/users/:id', async (req, res) => {
  const { name, pattern } = req.body;
  await pool.query(`UPDATE users SET name=$1, pattern=$2 WHERE id=$3`, [name, pattern, req.params.id]);
  res.json({ ok: true });
});

// ── Salary rate ───────────────────────────────────────────────────────────────
app.put('/api/users/:id/salary', async (req, res) => {
  const { salary_pct } = req.body;
  await pool.query(`UPDATE users SET salary_pct=$1 WHERE id=$2`, [salary_pct, req.params.id]);
  res.json({ ok: true });
});

// ── Manager reports ────────────────────────────────────────────────────────────
app.get('/api/users/report', async (req, res) => {
  try {
    const { userId, dateFrom, dateTo } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const { rows } = await pool.query(
      `SELECT ms.cab_id, c.name AS cab_name, ms.date, ms.rev, ms.ads, ms.cost, ms.comm,
              ms.cab_comm, ms.log_f, ms.log_r, ms.ret, ms.profit, ms.margin, ms.drr
       FROM wb_manager_sales ms JOIN cabs c ON c.id=ms.cab_id
       WHERE ms.user_id=$1 AND ms.date BETWEEN $2 AND $3
       ORDER BY ms.date DESC, ms.cab_id`,
      [parseInt(userId), dateFrom, dateTo]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/report-detail', async (req, res) => {
  try {
    const { userId, dateFrom, dateTo } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    const { rows } = await pool.query(
      `SELECT d.cab_id, c.name AS cab_name, d.date, d.article, COALESCE(cat.name,d.article) AS product,
              d.subject, d.qty, d.rev, d.cost, d.comm, d.cab_comm, d.log_f, d.log_r, d.ret,
              d.ads, d.profit, d.user_id
       FROM wb_manager_sales_detail d
       JOIN cabs c ON c.id=d.cab_id
       LEFT JOIN catalog cat ON cat.article=d.article AND cat.article IS NOT NULL
       WHERE d.user_id=$1 AND d.date BETWEEN $2 AND $3
       ORDER BY d.date DESC, d.cab_id, d.rev DESC`,
      [parseInt(userId), dateFrom, dateTo]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/:id/campaigns', async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const { rows } = await pool.query(
      `SELECT a.cab_id, c.name AS cab_name, a.campaign_id, a.campaign_name, COUNT(DISTINCT a.date)::int AS days,
              SUM(a.views)::bigint AS views, SUM(a.clicks)::bigint AS clicks, SUM(a.orders)::bigint AS orders,
              ROUND(SUM(a.sum)::numeric,2) AS sum
       FROM wb_advert_stats a JOIN cabs c ON c.id=a.cab_id
       WHERE a.user_id=$1 AND a.date BETWEEN $2 AND $3
       GROUP BY a.cab_id, c.name, a.campaign_id, a.campaign_name
       ORDER BY SUM(a.sum) DESC`,
      [parseInt(req.params.id), dateFrom, dateTo]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/campaigns/unassigned', async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const { rows } = await pool.query(
      `SELECT a.cab_id, c.name AS cab_name, a.campaign_id, a.campaign_name,
              COUNT(DISTINCT a.date)::int AS days, SUM(a.views)::bigint AS views,
              SUM(a.clicks)::bigint AS clicks, SUM(a.orders)::bigint AS orders,
              ROUND(SUM(a.sum)::numeric,2) AS sum
       FROM wb_advert_stats a JOIN cabs c ON c.id=a.cab_id
       WHERE a.user_id IS NULL AND a.date BETWEEN $1 AND $2
       GROUP BY a.cab_id, c.name, a.campaign_id, a.campaign_name
       ORDER BY SUM(a.sum) DESC`,
      [dateFrom, dateTo]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── User Goals (планы на месяц) ───────────────────────────────────────────────
app.get('/api/user-goals', async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const { rows } = await pool.query(
      `SELECT user_id, month, goal FROM user_goals WHERE month=$1`, [month]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/user-goals/:userId/:month', async (req, res) => {
  try {
    const { goal } = req.body;
    await pool.query(
      `INSERT INTO user_goals (user_id, month, goal) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, month) DO UPDATE SET goal=$3`,
      [req.params.userId, req.params.month, goal]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Дашборд и отчёты ────────────────────────────────────────────────────────
function parseDateRange(req) {
  let { dateFrom, dateTo } = req.query;
  if (!dateFrom || !dateTo) {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 6);
    dateTo = to.toISOString().split('T')[0];
    dateFrom = from.toISOString().split('T')[0];
  }
  return { dateFrom, dateTo };
}

async function getFinanceCosts(dateFrom, dateTo, cabId) {
  const p = [dateFrom, dateTo];
  let f = '';
  if (cabId && cabId !== 'all') { p.push(parseInt(cabId)); f = `AND fr.cab_id=$${p.length}`; }
  const { rows } = await pool.query(
    `SELECT fr.cab_id, fr.date_from, fr.date_to,
            SUM(fr.retail_amount)::float AS retail,
            SUM(fr.delivery_service)::float AS dlv, SUM(fr.paid_storage)::float AS st,
            SUM(fr.paid_acceptance)::float AS accept, SUM(fr.penalty)::float AS pen,
            SUM(fr.deduction)::float AS ded
     FROM wb_finance_reports fr
     WHERE fr.date_from <= $2 AND fr.date_to >= $1 ${f}
     GROUP BY fr.cab_id, fr.date_from, fr.date_to`, p);
  return rows;
}

function applyFinanceToRows(rows, fnRows) {
  if (!fnRows || !fnRows.length || !rows.length) return;
  const totals = { retail: 0, dlv: 0, st: 0, accept: 0, pen: 0, ded: 0 };
  fnRows.forEach(f => { totals.retail += +f.retail; totals.dlv += +f.dlv; totals.st += +f.st; totals.accept += +f.accept; totals.pen += +f.pen; totals.ded += +f.ded; });
  const totalRev = rows.reduce((s, r) => s + (+r.rev || 0), 0);
  if (totalRev <= 0) return;
  rows.forEach(row => {
    const share = (+row.rev || 0) / totalRev;
    if (share <= 0) return;
    // Always scale rev to match finance report retail_amount
    if (totals.retail > 0) {
      row.rev = +((+row.rev || 0) * totals.retail / totalRev).toFixed(2);
    }
    // Set finance costs (log_f/storage/etc.) and adjust profit — this runs when
    // applyFinanceExpenses has NOT already updated wb_sales (e.g. API-only path)
    row.log_f = +((+row.log_f || 0) + totals.dlv * share).toFixed(2);
    row.storage = +((+row.storage || 0) + totals.st * share).toFixed(2);
    row.acceptance = +((+row.acceptance || 0) + totals.accept * share).toFixed(2);
    row.penalties = +((+row.penalties || 0) + totals.pen * share).toFixed(2);
    row.other_deductions = +((+row.other_deductions || 0) + totals.ded * share).toFixed(2);
    const extra = (parseFloat(row.storage)||0) + (parseFloat(row.penalties)||0) + (parseFloat(row.other_deductions)||0) + (parseFloat(row.acceptance)||0);
    row.profit = +((+row.profit || 0) - extra).toFixed(2);
  });
}

app.get('/api/settings', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT key, value FROM app_settings');
    res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', async (req, res) => {
  try {
    const { buyout_days, deduction_pct } = req.body;
    if (buyout_days !== undefined) {
      await pool.query(`INSERT INTO app_settings (key, value) VALUES ('buyout_days', $1) ON CONFLICT (key) DO UPDATE SET value=$1`, [String(buyout_days)]);
    }
    if (deduction_pct !== undefined) {
      await pool.query(`INSERT INTO app_settings (key, value) VALUES ('deduction_pct', $1) ON CONFLICT (key) DO UPDATE SET value=$1`, [String(deduction_pct)]);
    }
    const { rows } = await pool.query('SELECT key, value FROM app_settings');
    res.json(Object.fromEntries(rows.map(r => [r.key, r.value])));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/dashboard', async (req, res) => {
  try {
    const { dateFrom, dateTo } = parseDateRange(req);
    const userId = req.query.userId ? parseInt(req.query.userId, 10) : null;
    let cabFilter = '', params = [dateFrom, dateTo];
    let finCabFilter = '', finP = [dateFrom, dateTo], isAdminFilter = true;
    if (userId) {
      const { rows: u } = await pool.query('SELECT role FROM users WHERE id=$1', [userId]);
      if (u.length && u[0].role !== 'admin') {
        cabFilter = 'AND a.cab_id IN (SELECT cab_id FROM user_cabs WHERE user_id=$3)';
        finCabFilter = 'AND fr.cab_id IN (SELECT cab_id FROM user_cabs WHERE user_id=$3)';
        params.push(userId);
        finP.push(userId);
        isAdminFilter = false;
      }
    }
    // Revenue from finance reports (100% match with WB Partners)
    const { rows: finRows } = await pool.query(
      `SELECT COALESCE(SUM(fr.retail_amount)::float,0) AS rev,
              COALESCE(SUM(fr.for_pay)::float,0) AS for_pay,
              COALESCE(SUM(fr.delivery_service)::float,0) AS dlv,
              COALESCE(SUM(fr.paid_storage)::float,0) AS sto,
              COALESCE(SUM(fr.paid_acceptance)::float,0) AS acc,
              COALESCE(SUM(fr.deduction)::float,0) AS ded,
              COALESCE(SUM(fr.penalty)::float,0) AS pen,
              MIN(fr.date_from)::text AS actual_from,
              MAX(fr.date_to)::text AS actual_to
       FROM wb_finance_reports fr
       WHERE fr.date_to >= $1 AND fr.date_from <= $2 ${finCabFilter}`, finP);
    const f = finRows[0];
    
    // Ads, cost, comm from wb_sales + advert_stats (these are independent of rev source)
    const { rows: exp } = await pool.query(
      `SELECT COALESCE(SUM(a.sum)::float,0) AS ads
       FROM wb_advert_stats a WHERE a.date BETWEEN $1 AND $2 ${cabFilter}`, params);
    const ads = exp[0].ads;
    
    const { rows: costRows } = await pool.query(
      `SELECT COALESCE(SUM(ws.cost)::float,0) AS cost, COUNT(*)::int AS days
       FROM wb_sales ws WHERE ws.date BETWEEN $1 AND $2 ${cabFilter.replace(/a\./g,'ws.')}`, params);
    
    const rev = f.rev;
    const forPay = f.for_pay;
    const logistics = f.dlv + f.sto + f.acc + f.ded + f.pen;
    const cost = costRows[0].cost;
    const pct = parseFloat((await pool.query("SELECT value FROM app_settings WHERE key='deduction_pct'")).rows[0]?.value||0);
    const dedAmount = rev * pct / 100;
    const profit = forPay - cost - ads - dedAmount;
    const netRev = rev;
    const margin = netRev > 0 ? +(profit / netRev * 100).toFixed(2) : 0;
    const drr = netRev > 0 ? +(ads / netRev * 100).toFixed(2) : 0;
    
    const expenses = cost + ads + logistics + dedAmount;
    
    // Per-cabinet breakdown from finance reports + ads + cost
    const { rows: byCab } = await pool.query(
`SELECT f.cab_id, c.name AS cab_name,
        f.rev, f.for_pay, f.logistics,
              COALESCE(a.ads::float,0) AS ads,
              COALESCE(s.cost::float,0) AS cost
       FROM (SELECT fr.cab_id,
                    SUM(fr.retail_amount)::float AS rev,
                    SUM(fr.for_pay)::float AS for_pay,
                    SUM(fr.delivery_service+fr.paid_storage+fr.paid_acceptance+fr.deduction+fr.penalty)::float AS logistics
             FROM wb_finance_reports fr
             WHERE fr.date_to >= $1 AND fr.date_from <= $2 ${finCabFilter}
             GROUP BY fr.cab_id) f
       JOIN cabs c ON c.id = f.cab_id
       LEFT JOIN (SELECT cab_id, SUM(sum)::float AS ads FROM wb_advert_stats a WHERE a.date BETWEEN $1 AND $2 ${cabFilter} GROUP BY cab_id) a ON a.cab_id = f.cab_id
       LEFT JOIN (SELECT cab_id, SUM(cost)::float AS cost FROM wb_sales ws WHERE ws.date BETWEEN $1 AND $2 ${cabFilter.replace(/a\./g,'ws.')} GROUP BY cab_id) s ON s.cab_id = f.cab_id
       ORDER BY f.rev DESC`, finP);
    
    for (const r of byCab) {
      const ded = (r.rev || 0) * pct / 100;
      r.comm = +(r.logistics || 0).toFixed(2);
      r.logistics = +(r.logistics || 0).toFixed(2);
      r.deduction = +ded.toFixed(2);
      r.profit = +(r.for_pay - (r.cost||0) - (r.ads||0) - ded).toFixed(2);
      r.expenses = +((r.cost||0) + (r.ads||0) + (r.logistics||0) + ded).toFixed(2);
      const nr = r.rev || 0;
      r.margin = nr > 0 ? +(r.profit / nr * 100).toFixed(2) : 0;
      r.drr = nr > 0 ? +((r.ads||0) / nr * 100).toFixed(2) : 0;
    }
    
    res.json({
      period: { dateFrom, dateTo, actualFrom: f.actual_from || dateFrom, actualTo: f.actual_to || dateTo },
      totals: {
        rev, for_pay: +forPay.toFixed(2),
        cost: +cost.toFixed(2), ads: +ads.toFixed(2),
        comm: +logistics.toFixed(2), // all WB fees combined
        logistics: +logistics.toFixed(2),
        deduction: +dedAmount.toFixed(2),
        profit: +profit.toFixed(2), expenses: +expenses.toFixed(2),
        margin, drr,
        qty: costRows[0].days
      },
      byCab
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/daily', async (req, res) => {
  try {
    const { dateFrom, dateTo } = parseDateRange(req);
    const cabId = req.query.cabId;
    const params = [dateFrom, dateTo];
    let cabF = '', cabF2 = '';
    if (cabId && cabId !== 'all') { params.push(parseInt(cabId)); cabF = 'AND d.cab_id=$3'; cabF2 = 'AND ws.cab_id=$3'; }
    const { rows } = await pool.query(`WITH q AS (
      SELECT DISTINCT ON (d.cab_id,d.date,d.article) d.cab_id,d.date,d.article,d.qty
      FROM wb_manager_sales_detail d WHERE d.date BETWEEN $1 AND $2 ${cabF} AND BTRIM(d.article)<>''
        AND (COALESCE(d.rev,0)<>0 OR COALESCE(d.cost,0)<>0 OR COALESCE(d.comm,0)<>0 OR COALESCE(d.ads,0)<>0 OR COALESCE(d.profit,0)<>0)
      ORDER BY d.cab_id,d.date,d.article,(d.user_id IS NULL),d.updated_at DESC,d.id DESC
    ), q2 AS (SELECT cab_id,date,SUM(qty) AS qty FROM q GROUP BY cab_id,date),
    s AS (SELECT ws.cab_id,ws.date,SUM(ws.rev)AS rev,SUM(ws.cost)AS cost,SUM(ws.comm)AS comm,SUM(ws.ads)AS ads,
      SUM(ws.cab_comm)AS cab_comm,SUM(ws.log_f)AS log_f,SUM(ws.log_r)AS log_r,
      SUM(CASE WHEN COALESCE(ws.ret,0)<>0 THEN ws.ret ELSE GREATEST(ws.rev-ws.profit-ws.cost-ws.ads-ws.comm-ws.cab_comm-ws.log_f-ws.log_r,0) END)AS ret,
      SUM(ws.profit)AS profit FROM wb_sales ws WHERE ws.date BETWEEN $1 AND $2 ${cabF2} GROUP BY cab_id,date)
    SELECT TO_CHAR(s.date,'YYYY-MM-DD') AS date,COALESCE(SUM(q2.qty),0)::float AS qty,
      SUM(s.rev)::float AS rev,SUM(s.cost)::float AS cost,SUM(s.comm)::float AS comm,SUM(s.ads)::float AS ads,
      SUM(s.cab_comm)::float AS cab_comm,SUM(s.log_f)::float AS log_f,SUM(s.log_r)::float AS log_r,SUM(s.ret)::float AS ret,SUM(s.profit)::float AS profit
    FROM s LEFT JOIN q2 ON q2.cab_id=s.cab_id AND q2.date=s.date GROUP BY s.date ORDER BY s.date`, params);
    const fnRows = await getFinanceCosts(dateFrom, dateTo, req.query.cabId);
    applyFinanceToRows(rows, fnRows);
    const ded = parseFloat((await pool.query(`SELECT value FROM app_settings WHERE key='deduction_pct'`)).rows[0]?.value||0);
    rows.forEach(r => { const nr = (+r.rev||0)-(+r.ret||0); const d = nr*ded/100; r.profit = +((+r.profit||0)-d).toFixed(2); r.margin = nr>0 ? +(+r.profit/nr*100).toFixed(2) : 0; r.drr = nr>0 ? +(+r.ads/nr*100).toFixed(2) : 0; });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/monthly', async (req, res) => {
  try {
    const { dateFrom, dateTo } = parseDateRange(req);
    const cabId = req.query.cabId;
    const params = [dateFrom, dateTo];
    let f = ''; if (cabId && cabId !== 'all') { params.push(parseInt(cabId)); f = 'AND d.cab_id=$3'; }
    let f2 = ''; if (cabId && cabId !== 'all') { f2 = 'AND ws.cab_id=$3'; }
    const { rows } = await pool.query(`WITH q AS (
      SELECT DISTINCT ON (d.cab_id,d.date,d.article) d.cab_id,d.date,d.article,d.qty
      FROM wb_manager_sales_detail d WHERE d.date BETWEEN $1 AND $2 ${f} AND BTRIM(d.article)<>''
        AND (COALESCE(d.rev,0)<>0 OR COALESCE(d.cost,0)<>0 OR COALESCE(d.comm,0)<>0 OR COALESCE(d.ads,0)<>0 OR COALESCE(d.profit,0)<>0)
      ORDER BY d.cab_id,d.date,d.article,(d.user_id IS NULL),d.updated_at DESC,d.id DESC
    ), q2 AS (SELECT cab_id,date,SUM(qty) AS qty FROM q GROUP BY cab_id,date),
    s AS (SELECT ws.cab_id,ws.date,SUM(ws.rev)AS rev,SUM(ws.cost)AS cost,SUM(ws.comm)AS comm,SUM(ws.ads)AS ads,
      SUM(ws.cab_comm)AS cab_comm,SUM(ws.log_f)AS log_f,SUM(ws.log_r)AS log_r,
      SUM(CASE WHEN COALESCE(ws.ret,0)<>0 THEN ws.ret ELSE GREATEST(ws.rev-ws.profit-ws.cost-ws.ads-ws.comm-ws.cab_comm-ws.log_f-ws.log_r,0) END)AS ret,
      SUM(ws.profit)AS profit FROM wb_sales ws WHERE ws.date BETWEEN $1 AND $2 ${f2} GROUP BY cab_id,date)
    SELECT TO_CHAR(s.date,'YYYY-MM') AS month,COALESCE(SUM(q2.qty),0)::float AS qty,
      SUM(s.rev)::float AS rev,SUM(s.cost)::float AS cost,SUM(s.comm)::float AS comm,SUM(s.ads)::float AS ads,
      SUM(s.cab_comm)::float AS cab_comm,SUM(s.log_f)::float AS log_f,SUM(s.log_r)::float AS log_r,SUM(s.ret)::float AS ret,SUM(s.profit)::float AS profit
    FROM s LEFT JOIN q2 ON q2.cab_id=s.cab_id AND q2.date=s.date GROUP BY TO_CHAR(s.date,'YYYY-MM') ORDER BY month`, params);
    const fnRows = await getFinanceCosts(dateFrom, dateTo, req.query.cabId);
    applyFinanceToRows(rows, fnRows);
    const ded = parseFloat((await pool.query(`SELECT value FROM app_settings WHERE key='deduction_pct'`)).rows[0]?.value||0);
    rows.forEach(r => { const nr = (+r.rev||0)-(+r.ret||0); const d = nr*ded/100; r.profit = +((+r.profit||0)-d).toFixed(2); r.margin = nr>0 ? +(+r.profit/nr*100).toFixed(2) : 0; r.drr = nr>0 ? +(+r.ads/nr*100).toFixed(2) : 0; });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/weekly', async (req, res) => {
  try {
    const { dateFrom, dateTo } = parseDateRange(req);
    const cabId = req.query.cabId;
    const params = [dateFrom, dateTo];
    let f = ''; if (cabId && cabId !== 'all') { params.push(parseInt(cabId)); f = 'AND ws.cab_id=$3'; }
    const { rows } = await pool.query(`WITH s AS (
      SELECT ws.cab_id, ws.date, ws.rev, ws.cost, ws.comm, ws.ads, ws.cab_comm, ws.log_f, ws.log_r, ws.ret, ws.profit
      FROM wb_sales ws WHERE ws.date BETWEEN $1 AND $2 ${f}
    ), q2 AS (
      SELECT cab_id,date,SUM(qty)::float AS qty FROM wb_import_days WHERE date BETWEEN $1 AND $2 GROUP BY cab_id,date
    )
    SELECT TO_CHAR(date_trunc('week', s.date::date + interval '1 day'), 'IYYY-"W"IW') AS week,
      MIN(s.date)::text AS week_start, MAX(s.date)::text AS week_end,
      COALESCE(SUM(q2.qty),0)::float AS qty,
      SUM(s.rev)::float AS rev, SUM(s.cost)::float AS cost, SUM(s.comm)::float AS comm, SUM(s.ads)::float AS ads,
      SUM(s.cab_comm)::float AS cab_comm, SUM(s.log_f)::float AS log_f, SUM(s.log_r)::float AS log_r,
      SUM(s.ret)::float AS ret, SUM(s.profit)::float AS profit
    FROM s LEFT JOIN q2 ON q2.cab_id=s.cab_id AND q2.date=s.date
    GROUP BY week ORDER BY week`, params);
    const fnRows = await getFinanceCosts(dateFrom, dateTo, req.query.cabId);
    applyFinanceToRows(rows, fnRows);
    const ded = parseFloat((await pool.query("SELECT value FROM app_settings WHERE key='deduction_pct'")).rows[0]?.value||0);
    rows.forEach(r => { const nr = (+r.rev||0)-(+r.ret||0); const d = nr*ded/100; r.profit = +((+r.profit||0)-d).toFixed(2); r.margin = nr>0 ? +(+r.profit/nr*100).toFixed(2) : 0; r.drr = nr>0 ? +(+r.ads/nr*100).toFixed(2) : 0; });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/category', async (req, res) => {
  try {
    const { dateFrom, dateTo } = parseDateRange(req);
    const cabId = req.query.cabId;
    const params = [dateFrom, dateTo];
    let f = ''; if (cabId && cabId !== 'all') { params.push(parseInt(cabId)); f = 'AND d.cab_id=$3'; }
    const { rows } = await pool.query(`WITH q AS (
      SELECT DISTINCT ON (d.cab_id,d.date,d.article) d.cab_id,d.date,d.article,d.subject,d.qty,d.rev,d.cost,d.comm
      FROM wb_manager_sales_detail d WHERE d.date BETWEEN $1 AND $2 ${f} AND BTRIM(d.article)<>''
        AND (COALESCE(d.rev,0)<>0 OR COALESCE(d.cost,0)<>0 OR COALESCE(d.comm,0)<>0 OR COALESCE(d.ads,0)<>0 OR COALESCE(d.profit,0)<>0)
      ORDER BY d.cab_id,d.date,d.article,(d.user_id IS NULL),d.updated_at DESC,d.id DESC
    ), c2 AS (SELECT c.id,c.subject,c.article FROM catalog c WHERE c.article IS NOT NULL),
    f2 AS (SELECT q.cab_id,q.date,q.qty,q.rev,q.cost,q.comm,COALESCE(c2.subject,q.subject) AS category
      FROM q LEFT JOIN c2 ON c2.article=q.article),
    cr AS (SELECT f2.cab_id,SUM(f2.rev)AS rev FROM f2 GROUP BY f2.cab_id),
    s AS (SELECT ws.cab_id,SUM(ws.ads)AS ads,SUM(ws.cab_comm)AS cab,SUM(ws.log_f)AS lf,SUM(ws.log_r)AS lr,
      SUM(CASE WHEN COALESCE(ws.ret,0)<>0 THEN ws.ret ELSE GREATEST(ws.rev-ws.profit-ws.cost-ws.ads-ws.comm-ws.cab_comm-ws.log_f-ws.log_r,0) END)AS ret,
      SUM(ws.profit)AS profit FROM wb_sales ws WHERE ws.date BETWEEN $1 AND $2 ${f.replace(/d\./g,'ws.')} GROUP BY ws.cab_id)
    SELECT f2.category,SUM(f2.qty)::float AS qty,SUM(f2.rev)::float AS rev,SUM(f2.cost)::float AS cost,SUM(f2.comm)::float AS comm,
      SUM(CASE WHEN cr.rev>0 THEN f2.rev/cr.rev*COALESCE(s.ads,0) ELSE 0 END)::float AS ads,
      SUM(CASE WHEN cr.rev>0 THEN f2.rev/cr.rev*COALESCE(s.cab,0) ELSE 0 END)::float AS cab_comm,
      SUM(CASE WHEN cr.rev>0 THEN f2.rev/cr.rev*COALESCE(s.lf,0) ELSE 0 END)::float AS log_f,
      SUM(CASE WHEN cr.rev>0 THEN f2.rev/cr.rev*COALESCE(s.lr,0) ELSE 0 END)::float AS log_r,
      SUM(CASE WHEN cr.rev>0 THEN f2.rev/cr.rev*COALESCE(s.ret,0) ELSE 0 END)::float AS ret,
      SUM(CASE WHEN cr.rev>0 THEN f2.rev/cr.rev*COALESCE(s.profit,0) ELSE 0 END)::float AS profit
    FROM f2 JOIN cr ON cr.cab_id=f2.cab_id LEFT JOIN s ON s.cab_id=f2.cab_id GROUP BY f2.category ORDER BY SUM(f2.rev) DESC`, params);
    const fnRows = await getFinanceCosts(dateFrom, dateTo, req.query.cabId);
    applyFinanceToRows(rows, fnRows);
    const ded = parseFloat((await pool.query(`SELECT value FROM app_settings WHERE key='deduction_pct'`)).rows[0]?.value||0);
    rows.forEach(r => { const nr = (+r.rev||0)-(+r.ret||0); const d = nr*ded/100; r.profit = +((+r.profit||0)-d).toFixed(2); r.margin = nr>0 ? +(+r.profit/nr*100).toFixed(2) : 0; r.drr = nr>0 ? +(+r.ads/nr*100).toFixed(2) : 0; });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/article', async (req, res) => {
  try {
    const { dateFrom, dateTo } = parseDateRange(req);
    const cabId = req.query.cabId;
    const params = [dateFrom, dateTo];
    let f = ''; if (cabId && cabId !== 'all') { params.push(parseInt(cabId)); f = 'AND d.cab_id=$3'; }
    let f2 = ''; if (cabId && cabId !== 'all') { f2 = 'AND ws.cab_id=$3'; }
    const { rows } = await pool.query(`WITH q AS (
      SELECT DISTINCT ON (d.cab_id,d.date,d.article) d.cab_id,d.date,d.article,d.subject,d.qty,d.rev,d.cost,d.comm
      FROM wb_manager_sales_detail d WHERE d.date BETWEEN $1 AND $2 ${f} AND BTRIM(d.article)<>''
        AND (COALESCE(d.rev,0)<>0 OR COALESCE(d.cost,0)<>0 OR COALESCE(d.comm,0)<>0 OR COALESCE(d.ads,0)<>0 OR COALESCE(d.profit,0)<>0)
      ORDER BY d.cab_id,d.date,d.article,(d.user_id IS NULL),d.updated_at DESC,d.id DESC
    ), s AS (SELECT ws.cab_id,SUM(ws.ads)AS ads,SUM(ws.cab_comm)AS cab,SUM(ws.log_f)AS lf,SUM(ws.log_r)AS lr,
      SUM(CASE WHEN COALESCE(ws.ret,0)<>0 THEN ws.ret ELSE GREATEST(ws.rev-ws.profit-ws.cost-ws.ads-ws.comm-ws.cab_comm-ws.log_f-ws.log_r,0) END)AS ret,
      SUM(ws.profit)AS profit FROM wb_sales ws WHERE ws.date BETWEEN $1 AND $2 ${f2} GROUP BY ws.cab_id),
    tot AS (SELECT q.cab_id,SUM(q.rev)AS rev FROM q GROUP BY q.cab_id),
    r AS (SELECT q.article,q.subject,SUM(q.qty)AS qty,SUM(q.rev)AS rev,SUM(q.cost)AS cost,SUM(q.comm)AS comm,q.cab_id
      FROM q GROUP BY q.article,q.subject,q.cab_id)
    SELECT r.article,MIN(r.subject)AS subject,SUM(r.qty)::float AS qty,SUM(r.rev)::float AS rev,SUM(r.cost)::float AS cost,
      SUM(r.comm)::float AS comm,
      SUM(CASE WHEN tot.rev>0 THEN r.rev/tot.rev*COALESCE(s.ads,0) ELSE 0 END)::float AS ads,
      SUM(CASE WHEN tot.rev>0 THEN r.rev/tot.rev*COALESCE(s.cab,0) ELSE 0 END)::float AS cab_comm,
      SUM(CASE WHEN tot.rev>0 THEN r.rev/tot.rev*COALESCE(s.lf,0) ELSE 0 END)::float AS log_f,
      SUM(CASE WHEN tot.rev>0 THEN r.rev/tot.rev*COALESCE(s.lr,0) ELSE 0 END)::float AS log_r,
      SUM(CASE WHEN tot.rev>0 THEN r.rev/tot.rev*COALESCE(s.ret,0) ELSE 0 END)::float AS ret,
      SUM(CASE WHEN tot.rev>0 THEN r.rev/tot.rev*COALESCE(s.profit,0) ELSE 0 END)::float AS profit
    FROM r JOIN tot ON tot.cab_id=r.cab_id LEFT JOIN s ON s.cab_id=r.cab_id
    GROUP BY r.article ORDER BY SUM(r.rev) DESC LIMIT 1000`, params);
    const fnRows = await getFinanceCosts(dateFrom, dateTo, req.query.cabId);
    applyFinanceToRows(rows, fnRows);
    const ded = parseFloat((await pool.query(`SELECT value FROM app_settings WHERE key='deduction_pct'`)).rows[0]?.value||0);
    rows.forEach(r => { const nr = (+r.rev||0)-(+r.ret||0); const d = nr*ded/100; r.profit = +((+r.profit||0)-d).toFixed(2); r.margin = nr>0 ? +(+r.profit/nr*100).toFixed(2) : 0; r.drr = nr>0 ? +(+r.ads/nr*100).toFixed(2) : 0; });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/reports/product', async (req, res) => {
  try {
    const { dateFrom, dateTo } = parseDateRange(req);
    const cabId = req.query.cabId;
    const params = [dateFrom, dateTo];
    let f = ''; if (cabId && cabId !== 'all') { params.push(parseInt(cabId)); f = 'AND d.cab_id=$3'; }
    let f2 = ''; if (cabId && cabId !== 'all') { f2 = 'AND ws.cab_id=$3'; }
    const { rows } = await pool.query(`WITH q AS (
      SELECT DISTINCT ON (d.cab_id,d.date,d.article) d.cab_id,d.date,d.article,d.subject,d.qty,d.rev,d.cost,d.comm
      FROM wb_manager_sales_detail d WHERE d.date BETWEEN $1 AND $2 ${f} AND BTRIM(d.article)<>''
        AND (COALESCE(d.rev,0)<>0 OR COALESCE(d.cost,0)<>0 OR COALESCE(d.comm,0)<>0 OR COALESCE(d.ads,0)<>0 OR COALESCE(d.profit,0)<>0)
      ORDER BY d.cab_id,d.date,d.article,(d.user_id IS NULL),d.updated_at DESC,d.id DESC
    ), c2 AS (SELECT c.id,c.article,c.name,c.subject FROM catalog c WHERE c.article IS NOT NULL),
    f2a AS (SELECT q.cab_id,q.article,COALESCE(c2.name,q.article) AS product,COALESCE(c2.subject,q.subject) AS subject,q.qty,q.rev,q.cost,q.comm
      FROM q LEFT JOIN c2 ON c2.article=q.article),
    s AS (SELECT ws.cab_id,SUM(ws.ads)AS ads,SUM(ws.cab_comm)AS cab,SUM(ws.log_f)AS lf,SUM(ws.log_r)AS lr,
      SUM(CASE WHEN COALESCE(ws.ret,0)<>0 THEN ws.ret ELSE GREATEST(ws.rev-ws.profit-ws.cost-ws.ads-ws.comm-ws.cab_comm-ws.log_f-ws.log_r,0) END)AS ret,
      SUM(ws.profit)AS profit FROM wb_sales ws WHERE ws.date BETWEEN $1 AND $2 ${f2} GROUP BY ws.cab_id),
    cr AS (SELECT f2a.cab_id,SUM(f2a.rev)AS rev FROM f2a GROUP BY f2a.cab_id)
    SELECT f2a.product,MIN(f2a.subject)AS subject,COUNT(DISTINCT f2a.article)::int AS articles,
      SUM(f2a.qty)::float AS qty,SUM(f2a.rev)::float AS rev,SUM(f2a.cost)::float AS cost,SUM(f2a.comm)::float AS comm,
      SUM(CASE WHEN cr.rev>0 THEN f2a.rev/cr.rev*COALESCE(s.ads,0) ELSE 0 END)::float AS ads,
      SUM(CASE WHEN cr.rev>0 THEN f2a.rev/cr.rev*COALESCE(s.cab,0) ELSE 0 END)::float AS cab_comm,
      SUM(CASE WHEN cr.rev>0 THEN f2a.rev/cr.rev*COALESCE(s.lf,0) ELSE 0 END)::float AS log_f,
      SUM(CASE WHEN cr.rev>0 THEN f2a.rev/cr.rev*COALESCE(s.lr,0) ELSE 0 END)::float AS log_r,
      SUM(CASE WHEN cr.rev>0 THEN f2a.rev/cr.rev*COALESCE(s.ret,0) ELSE 0 END)::float AS ret,
      SUM(CASE WHEN cr.rev>0 THEN f2a.rev/cr.rev*COALESCE(s.profit,0) ELSE 0 END)::float AS profit
    FROM f2a JOIN cr ON cr.cab_id=f2a.cab_id LEFT JOIN s ON s.cab_id=f2a.cab_id
    GROUP BY f2a.product ORDER BY SUM(f2a.rev) DESC`, params);
    const fnRows = await getFinanceCosts(dateFrom, dateTo, req.query.cabId);
    applyFinanceToRows(rows, fnRows);
    const ded = parseFloat((await pool.query(`SELECT value FROM app_settings WHERE key='deduction_pct'`)).rows[0]?.value||0);
    rows.forEach(r => { const nr = (+r.rev||0)-(+r.ret||0); const d = nr*ded/100; r.profit = +((+r.profit||0)-d).toFixed(2); r.margin = nr>0 ? +(+r.profit/nr*100).toFixed(2) : 0; r.drr = nr>0 ? +(+r.ads/nr*100).toFixed(2) : 0; });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const scheduler = require('./scheduler');
const wb = require('./wb');
app.use('/api/wb', (function() {
  const r = require('express').Router();

  r.get('/scheduler-status', async (_req, res) => {
    try {
      const { rows } = await pool.query(`SELECT key,value FROM app_settings WHERE key IN ('scheduler_last_run','scheduler_last_deep_run')`);
      const s = Object.fromEntries(rows.map(rr => [rr.key, rr.value]));
      res.json({ ...scheduler.getStatus(), settings: s });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.post('/scheduler-run', async (_req, res) => {
    try {
      const result = await scheduler.runImport(pool);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.get('/import-status', async (_req, res) => {
    try {
      const { rows } = await pool.query(`SELECT c.id, c.name, r.status, r.issues->0->>'message' AS issue, r.started_at FROM cabs c LEFT JOIN LATERAL (SELECT * FROM wb_import_runs WHERE cab_id=c.id ORDER BY started_at DESC LIMIT 1) r ON true ORDER BY c.id`);
      res.json(rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  r.get('/import-runs', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit)||50, 200);
      const { rows } = await pool.query(`SELECT r.id,r.cab_id,c.name AS cab_name,r.requested_from::text,r.requested_to::text,r.status,r.attempts,r.fetched_rows,r.accepted_rows,r.rejected_rows,r.issues,r.started_at,r.finished_at FROM wb_import_runs r JOIN cabs c ON c.id=r.cab_id ORDER BY r.started_at DESC LIMIT $1`, [limit]);
      res.json(rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  r.get('/order-stats', async (req, res) => {
    try {
      const p = [req.query.dateFrom||'2026-01-01', req.query.dateTo||'2099-12-31'];
      let f = ''; if (req.query.cabId && req.query.cabId!=='all') { p.push(parseInt(req.query.cabId)); f = 'AND os.cab_id=$3'; }
      const { rows } = await pool.query(`SELECT os.cab_id,c.name AS cab_name,SUM(os.ordered_qty)::int AS ordered_qty,SUM(os.ordered_amount)::float AS ordered_amount,SUM(os.cancelled_qty)::int AS cancelled_qty FROM wb_order_stats os JOIN cabs c ON c.id=os.cab_id WHERE os.date BETWEEN $1 AND $2 ${f} GROUP BY os.cab_id,c.name ORDER BY SUM(os.ordered_amount) DESC`, p);
      res.json(rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  r.get('/finance-reports', async (req, res) => {
    try {
      const p = [req.query.dateFrom||'2026-01-01', req.query.dateTo||'2099-12-31'];
      let f = ''; if (req.query.cabId && req.query.cabId!=='all') { p.push(parseInt(req.query.cabId)); f = 'AND fr.cab_id=$3'; }
      const { rows } = await pool.query(`SELECT fr.cab_id, c.name AS cab_name, SUM(fr.retail_amount)::float AS retail, SUM(fr.for_pay)::float AS pay, SUM(fr.delivery_service)::float AS dlv, SUM(fr.paid_storage)::float AS st, SUM(fr.paid_acceptance)::float AS accept, SUM(fr.penalty)::float AS pen, SUM(fr.deduction)::float AS ded, COUNT(*)::int AS cnt FROM wb_finance_reports fr JOIN cabs c ON c.id=fr.cab_id WHERE fr.date_from <= $2 AND fr.date_to >= $1 ${f} GROUP BY fr.cab_id,c.name ORDER BY SUM(fr.retail_amount) DESC`, p);
      res.json(rows);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  r.post('/sync/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM cabs WHERE id=$1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Кабинет не найден' });
      const result = await wb.syncCab(pool, rows[0]);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.post('/import/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM cabs WHERE id=$1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Кабинет не найден' });
      const { dateFrom, dateTo } = req.query;
      const result = await wb.importCabSales(pool, rows[0], dateFrom, dateTo);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.post('/import-all', async (req, res) => {
    try {
      const { dateFrom, dateTo } = req.query;
      const result = await scheduler.runImport(pool, { dateFrom, dateTo });
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.post('/sync-products/:cabId', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM cabs WHERE id=$1`, [req.params.cabId]);
      if (!rows[0]) return res.status(404).json({ error: 'Кабинет не найден' });
      const result = await wb.syncCabProducts(pool, rows[0]);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.post('/seed-demo/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM cabs WHERE id=$1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Кабинет не найден' });
      const days = parseInt(req.query.days) || 7;
      const result = await wb.seedDemoSales(pool, rows[0], days);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.post('/seed-demo-ads/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM cabs WHERE id=$1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Кабинет не найден' });
      const days = parseInt(req.query.days) || 7;
      const result = await wb.seedDemoAds(pool, rows[0], days);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.get('/adverts/:id', async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT * FROM cabs WHERE id=$1`, [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Кабинет не найден' });
      const token = wb.getCabToken(rows[0]);
      if (!token) return res.status(400).json({ error: 'Нет WB токена' });
      const campaigns = await wb.fetchAdverts(token);
      res.json(campaigns);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.get('/advert-metrics', async (req, res) => {
    try {
      const { cabId, dateFrom, dateTo } = req.query;
      const p = [dateFrom || '2026-01-01', dateTo || '2099-12-31'];
      let f = '';
      if (cabId && cabId !== 'all') { p.push(parseInt(cabId)); f = 'AND a.cab_id=$3'; }
      const { rows } = await pool.query(
        `SELECT a.cab_id, c.name AS cab_name, a.date, SUM(a.views)::bigint AS views,
                SUM(a.clicks)::bigint AS clicks, SUM(a.orders)::bigint AS orders,
                ROUND(SUM(a.sum)::numeric,2) AS sum
         FROM wb_advert_stats a JOIN cabs c ON c.id=a.cab_id
         WHERE a.date BETWEEN $1 AND $2 ${f}
         GROUP BY a.cab_id, c.name, a.date
         ORDER BY a.date DESC, a.cab_id`, p);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return r;
})());

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API сервер запущен на http://localhost:${PORT}`));
scheduler.start(pool);
