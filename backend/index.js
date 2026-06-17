require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const pool    = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

// ── Создать таблицу user_cabs если нет ───────────────────────────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS user_cabs (
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    cab_id  INTEGER REFERENCES cabs(id)  ON DELETE CASCADE,
    PRIMARY KEY (user_id, cab_id)
  )
`).catch(e => console.error('user_cabs init error:', e.message));

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
    // Получаем список разрешённых кабинетов
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
  const { rows } = await pool.query(`SELECT id,login,name,role,created_at FROM users ORDER BY id`);
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
  const cabIds = req.body.cab_ids || []; // массив id кабинетов
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

// ── Cabs ─────────────────────────────────────────────────────────────────────
app.get('/api/cabs', async (_req, res) => {
  const { rows } = await pool.query(`SELECT * FROM cabs ORDER BY id`);
  res.json(rows);
});

app.post('/api/cabs', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO cabs (name) VALUES ($1) RETURNING *`, [req.body.name]
    );
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Уже существует' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/cabs/:id', async (req, res) => {
  await pool.query(`DELETE FROM cabs WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

// ── History ───────────────────────────────────────────────────────────────────
app.get('/api/history', async (_req, res) => {
  const { rows } = await pool.query(`SELECT * FROM history ORDER BY created_at DESC`);
  res.json(rows);
});

app.post('/api/history', async (req, res) => {
  const { date, cabinet, user_login, rev, ads, cost, comm, log_f, log_r, ret, profit, margin, drr } = req.body;
  const { rows } = await pool.query(
    `INSERT INTO history (date,cabinet,user_login,rev,ads,cost,comm,log_f,log_r,ret,profit,margin,drr)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [date, cabinet, user_login, rev, ads, cost, comm, log_f, log_r, ret, profit, margin, drr]
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API сервер запущен на http://localhost:${PORT}`));
