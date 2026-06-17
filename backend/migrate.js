require('dotenv').config();
const pool = require('./db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        login TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        name TEXT,
        role TEXT NOT NULL DEFAULT 'employee',
        salary_pct NUMERIC DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS catalog (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        cost INTEGER NOT NULL DEFAULT 0,
        comm INTEGER NOT NULL DEFAULT 25,
        w INTEGER NOT NULL DEFAULT 0,
        d INTEGER NOT NULL DEFAULT 0,
        h INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS cabs (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        buyout INTEGER NOT NULL DEFAULT 88
      );

      CREATE TABLE IF NOT EXISTS teams (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS team_members (
        team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (team_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS history (
        id SERIAL PRIMARY KEY,
        date DATE NOT NULL,
        cabinet TEXT,
        user_login TEXT,
        rev NUMERIC DEFAULT 0,
        ads NUMERIC DEFAULT 0,
        cost NUMERIC DEFAULT 0,
        comm NUMERIC DEFAULT 0,
        log_f NUMERIC DEFAULT 0,
        log_r NUMERIC DEFAULT 0,
        ret NUMERIC DEFAULT 0,
        profit NUMERIC DEFAULT 0,
        margin NUMERIC DEFAULT 0,
        drr NUMERIC DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Дефолтный admin
    const { rows } = await client.query(`SELECT id FROM users WHERE login='admin'`);
    if (!rows.length) {
      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash('admin123', 10);
      await client.query(
        `INSERT INTO users (login, password, name, role) VALUES ('admin', $1, 'Администратор', 'admin')`,
        [hash]
      );
    }

    // Дефолтные товары
    const { rows: catRows } = await client.query(`SELECT id FROM catalog LIMIT 1`);
    if (!catRows.length) {
      const products = [
        ['Шурик красный',7842,25,31,27,10],['Шурик желтый',7842,25,31,27,10],['Шурик синий',7842,25,31,27,10],
        ['Лазер красный',15670,25,46,26,17],['Лазер желтый',15670,25,46,26,17],['Лазер синий',15670,25,46,26,17],
        ['Гайковёрт',18822,25,35,30,11],['Набор 5в1 Б',39298,25,55,39,16],['Набор 5в1 М',39298,25,55,39,16],
        ['Набор 3в1',20000,25,56,42,15],['Болгарка',16000,25,25,35,11],['Пила',12000,25,36,22,13],
        ['Перфоратор',25000,25,41,25,10],['Отпариватель',7100,25,26,12,12],
        ['Блендер 4в1',7970,25,28,27,15],['Блендер 5в1',8500,25,0,0,0],['Блендер 6в1',8990,25,30,28,16],
        ['Аэрогриль',15000,25,0,0,0],['Культиватор',20000,25,26,51,22],['Триммер',15000,25,58,19,10],
        ['Кресло красный',25000,25,0,0,0],['Кресло черный',25000,25,0,0,0],
      ];
      for (const [name,cost,comm,w,d,h] of products) {
        await client.query(
          `INSERT INTO catalog (name,cost,comm,w,d,h) VALUES ($1,$2,$3,$4,$5,$6)`,
          [name,cost,comm,w,d,h]
        );
      }
      console.log('Загружен каталог товаров');
    }

    // Дефолтные кабинеты
    const { rows: cabRows } = await client.query(`SELECT id FROM cabs LIMIT 1`);
    if (!cabRows.length) {
      const cabs = ['AB Group','ALALI','ALMalik','Altay','EMOON','Fashion','Khan',
        'Арикоглобал','Ахрименко','ЛАО Компани','Найзабеков','Томми Арико','All Instruments','ТОО Томми Арико'];
      for (const name of cabs) {
        await client.query(`INSERT INTO cabs (name) VALUES ($1) ON CONFLICT DO NOTHING`, [name]);
      }
      console.log('Загружены кабинеты');
    }

    console.log('Миграция завершена');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(e => { console.error(e); process.exit(1); });
