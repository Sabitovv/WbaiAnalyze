require('dotenv').config();
const pool = require('./db');
const { CATALOG_TEMPLATE_NAMES, inferCatalogTemplate, normalizeProductText, accessoryCatalogRepair } = require('./catalogTemplates');

function coalescePositive(current, fallback) {
  const value = Number(current) || 0;
  return value > 0 ? value : (Number(fallback) || 0);
}

async function backfillWbCatalogFromTemplates(client) {
  const { rows: templateRows } = await client.query(
    `SELECT DISTINCT ON (name) name, cost, comm, w, d, h
     FROM catalog
     WHERE name = ANY($1)
     ORDER BY name, id`,
    [CATALOG_TEMPLATE_NAMES]
  );
  const templates = new Map(templateRows.map(row => [row.name, row]));
  if (!templates.size) return;

  const { rows } = await client.query(
    `SELECT id, name, article, subject, cost, comm, w, d, h
     FROM catalog
     WHERE source = 'wb' AND article IS NOT NULL`
  );

  let updated = 0;
  for (const row of rows) {
    const match = inferCatalogTemplate(row.article, row.subject);
    const template = match ? templates.get(match.templateName) : null;
    if (!template) continue;

    const nextName = normalizeProductText(row.name) === normalizeProductText(row.article) ? match.displayName : row.name;
    const nextCost = coalescePositive(row.cost, template.cost);
    const nextComm = coalescePositive(row.comm, template.comm);
    const nextW = coalescePositive(row.w, template.w);
    const nextD = coalescePositive(row.d, template.d);
    const nextH = coalescePositive(row.h, template.h);

    if (
      nextName === row.name &&
      Number(row.cost) === nextCost &&
      Number(row.comm) === nextComm &&
      Number(row.w) === nextW &&
      Number(row.d) === nextD &&
      Number(row.h) === nextH
    ) continue;

    await client.query(
      `UPDATE catalog
       SET name=$1, cost=$2, comm=$3, w=$4, d=$5, h=$6, updated_at=NOW()
       WHERE id=$7`,
      [nextName, nextCost, nextComm, nextW, nextD, nextH, row.id]
    );
    updated++;
  }

  if (updated) console.log(`Обновлено WB-товаров по шаблонам каталога: ${updated}`);
}

async function repairAccessoryCatalog(client) {
  const { rows } = await client.query(
    `SELECT id, name, article, source, cost, w, d, h
     FROM catalog
     WHERE article IS NOT NULL`
  );

  let repaired = 0;
  for (const row of rows) {
    const repair = accessoryCatalogRepair(row);
    if (!repair) continue;
    await client.query(
      `UPDATE catalog SET cost=0, w=0, d=0, h=0, updated_at=NOW() WHERE id=$1`,
      [row.id]
    );
    repaired++;
  }

  if (repaired) console.log(`Обнулены размеры аксессуаров в каталоге: ${repaired}`);
}

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
        pattern TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS catalog (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        cost INTEGER NOT NULL DEFAULT 0,
        comm NUMERIC NOT NULL DEFAULT 25,
        w INTEGER NOT NULL DEFAULT 0,
        d INTEGER NOT NULL DEFAULT 0,
        h INTEGER NOT NULL DEFAULT 0,
        article TEXT,
        subject TEXT,
        source TEXT DEFAULT 'manual',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      ALTER TABLE catalog ADD COLUMN IF NOT EXISTS article TEXT;
      ALTER TABLE catalog ADD COLUMN IF NOT EXISTS subject TEXT;
      ALTER TABLE catalog ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';
      ALTER TABLE catalog ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
      ALTER TABLE catalog ALTER COLUMN source SET DEFAULT 'manual';
      CREATE UNIQUE INDEX IF NOT EXISTS catalog_article_unique ON catalog(article) WHERE article IS NOT NULL;

      CREATE TABLE IF NOT EXISTS cabs (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        buyout INTEGER NOT NULL DEFAULT 88,
        cab_type TEXT,
        commission NUMERIC,
        last_synced_at TIMESTAMPTZ,
        wb_store_id TEXT
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

      CREATE TABLE IF NOT EXISTS user_goals (
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        month   TEXT NOT NULL,
        goal    NUMERIC NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, month)
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
        cab_comm NUMERIC DEFAULT 0,
        log_f NUMERIC DEFAULT 0,
        log_r NUMERIC DEFAULT 0,
        ret NUMERIC DEFAULT 0,
        profit NUMERIC DEFAULT 0,
        margin NUMERIC DEFAULT 0,
        drr NUMERIC DEFAULT 0,
        comment TEXT DEFAULT '',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS wb_sales (
        id SERIAL PRIMARY KEY,
        cab_id INTEGER REFERENCES cabs(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        rev NUMERIC DEFAULT 0,
        ads NUMERIC DEFAULT 0,
        cost NUMERIC DEFAULT 0,
        comm NUMERIC DEFAULT 0,
        cab_comm NUMERIC DEFAULT 0,
        log_f NUMERIC DEFAULT 0,
        log_r NUMERIC DEFAULT 0,
        ret NUMERIC DEFAULT 0,
        profit NUMERIC DEFAULT 0,
        margin NUMERIC DEFAULT 0,
        drr NUMERIC DEFAULT 0,
        source TEXT DEFAULT 'wb',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(cab_id, date)
      );

      UPDATE wb_sales
      SET source='wb_ads'
      WHERE source='wb' AND rev=0 AND cost=0 AND comm=0
        AND cab_comm=0 AND log_f=0 AND log_r=0;

      CREATE TABLE IF NOT EXISTS wb_manager_sales (
        id SERIAL PRIMARY KEY,
        cab_id INTEGER REFERENCES cabs(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        rev NUMERIC DEFAULT 0,
        ads NUMERIC DEFAULT 0,
        cost NUMERIC DEFAULT 0,
        comm NUMERIC DEFAULT 0,
        cab_comm NUMERIC DEFAULT 0,
        log_f NUMERIC DEFAULT 0,
        log_r NUMERIC DEFAULT 0,
        ret NUMERIC DEFAULT 0,
        profit NUMERIC DEFAULT 0,
        margin NUMERIC DEFAULT 0,
        drr NUMERIC DEFAULT 0,
        source TEXT DEFAULT 'article',
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(cab_id, user_id, date)
      );

      ALTER TABLE wb_manager_sales ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'article';

      CREATE TABLE IF NOT EXISTS wb_manager_sales_detail (
        id SERIAL PRIMARY KEY,
        cab_id INTEGER REFERENCES cabs(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        article TEXT NOT NULL,
        subject TEXT,
        qty NUMERIC DEFAULT 0,
        rev NUMERIC DEFAULT 0,
        cost NUMERIC DEFAULT 0,
        comm NUMERIC DEFAULT 0,
        ads NUMERIC DEFAULT 0,
        profit NUMERIC DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      DO $$
      BEGIN
        WITH ranked AS (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY cab_id, COALESCE(user_id, -1), date, article
                   ORDER BY updated_at DESC, id DESC
                 ) AS rn
          FROM wb_manager_sales_detail
        )
        DELETE FROM wb_manager_sales_detail d
        USING ranked r
        WHERE d.id = r.id AND r.rn > 1;

        IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wb_manager_sales_detail_cab_user_date_article_key') THEN
          ALTER TABLE wb_manager_sales_detail DROP CONSTRAINT wb_manager_sales_detail_cab_user_date_article_key;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'wb_manager_sales_detail_cab_user_date_article_uidx') THEN
          CREATE UNIQUE INDEX wb_manager_sales_detail_cab_user_date_article_uidx
            ON wb_manager_sales_detail (cab_id, COALESCE(user_id, -1), date, article);
        END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      INSERT INTO app_settings (key, value) VALUES ('buyout_days', '30')
      ON CONFLICT (key) DO NOTHING;

      CREATE TABLE IF NOT EXISTS wb_import_runs (
        id BIGSERIAL PRIMARY KEY,
        cab_id INTEGER NOT NULL REFERENCES cabs(id) ON DELETE CASCADE,
        requested_from DATE NOT NULL,
        requested_to DATE NOT NULL,
        actual_from DATE,
        actual_to DATE,
        status TEXT NOT NULL CHECK (status IN ('running', 'provisional', 'verified', 'blocked', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 1,
        fetched_rows INTEGER NOT NULL DEFAULT 0,
        accepted_rows INTEGER NOT NULL DEFAULT 0,
        rejected_rows INTEGER NOT NULL DEFAULT 0,
        source_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
        candidate_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
        issues JSONB NOT NULL DEFAULT '[]'::jsonb,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS wb_import_runs_cab_started_idx
        ON wb_import_runs (cab_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS wb_import_days (
        cab_id INTEGER NOT NULL REFERENCES cabs(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        accepted_run_id BIGINT REFERENCES wb_import_runs(id) ON DELETE SET NULL,
        accepted_status TEXT CHECK (accepted_status IN ('provisional', 'verified')),
        accepted_at TIMESTAMPTZ,
        last_attempt_run_id BIGINT REFERENCES wb_import_runs(id) ON DELETE SET NULL,
        last_attempt_status TEXT NOT NULL CHECK (last_attempt_status IN ('provisional', 'verified', 'blocked', 'failed')),
        checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        issues JSONB NOT NULL DEFAULT '[]'::jsonb,
        PRIMARY KEY (cab_id, date)
      );
      
      CREATE TABLE IF NOT EXISTS wb_order_stats (
        cab_id INTEGER REFERENCES cabs(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        ordered_qty INTEGER NOT NULL DEFAULT 0,
        ordered_amount NUMERIC NOT NULL DEFAULT 0,
        cancelled_qty INTEGER NOT NULL DEFAULT 0,
        cancelled_amount NUMERIC NOT NULL DEFAULT 0,
        PRIMARY KEY (cab_id, date)
      );

      CREATE TABLE IF NOT EXISTS wb_deductions (
        cab_id INTEGER REFERENCES cabs(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        storage NUMERIC NOT NULL DEFAULT 0,
        penalties NUMERIC NOT NULL DEFAULT 0,
        other_deductions NUMERIC NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (cab_id, date)
      );

      CREATE TABLE IF NOT EXISTS wb_finance_reports (
        id SERIAL PRIMARY KEY,
        cab_id INTEGER REFERENCES cabs(id) ON DELETE CASCADE,
        report_id BIGINT NOT NULL,
        date_from DATE NOT NULL,
        date_to DATE NOT NULL,
        create_date DATE NOT NULL,
        report_type INTEGER NOT NULL DEFAULT 1,
        retail_amount NUMERIC NOT NULL DEFAULT 0,
        for_pay NUMERIC NOT NULL DEFAULT 0,
        delivery_service NUMERIC NOT NULL DEFAULT 0,
        paid_storage NUMERIC NOT NULL DEFAULT 0,
        paid_acceptance NUMERIC NOT NULL DEFAULT 0,
        deduction NUMERIC NOT NULL DEFAULT 0,
        penalty NUMERIC NOT NULL DEFAULT 0,
        additional_payment NUMERIC NOT NULL DEFAULT 0,
        commission_amount NUMERIC NOT NULL DEFAULT 0,
        acquiring_amount NUMERIC NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(cab_id, report_id)
      );

      CREATE TABLE IF NOT EXISTS wb_advert_stats (
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
      );
    `);

    // Дефолтный admin — обновляем пароль при каждом деплое (хеш от целевой машины)
    const { rows } = await client.query(`SELECT id FROM users WHERE login='admin'`);
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('admin123', 10);
    if (!rows.length) {
      await client.query(
        `INSERT INTO users (login, password, name, role) VALUES ('admin', $1, 'Администратор', 'admin')`,
        [hash]
      );
    } else {
      await client.query(`UPDATE users SET password=$1 WHERE login='admin'`, [hash]);
    }

    // Дефолтные товары
    const { rows: catRows } = await client.query(`SELECT id FROM catalog LIMIT 1`);
    if (!catRows.length) {
      // Категорийные комиссии из Wb_Calculator
      const products = [
        ['Шурик красный',null,7842,21.693,31,27,10],['Шурик желтый',null,7842,21.693,31,27,10],['Шурик синий',null,7842,21.693,31,27,10],
        ['Лазер красный',null,15670,23.814,46,26,17],['Лазер желтый',null,15670,23.814,46,26,17],['Лазер синий',null,15670,23.814,46,26,17],
        ['Гайковёрт',null,18822,18.543,35,30,11],['Набор 5в1 Б',null,39298,25,55,39,16],['Набор 5в1 М',null,39298,25,55,39,16],
        ['Набор 3в1',null,20000,25,56,42,15],['Болгарка',null,16000,20.804,25,35,11],['Пила',null,12000,25,36,22,13],
        ['Перфоратор',null,25000,20.461,41,25,10],['Отпариватель',null,7100,25,26,12,12],
        ['Блендер 4в1',null,7970,19.453,28,27,15],['Блендер 5в1',null,8500,19.453,0,0,0],['Блендер 6в1',null,8990,19.453,30,28,16],
        ['Аэрогриль',null,15000,25,0,0,0],['Культиватор',null,20000,18.956,26,51,22],['Триммер',null,15000,17.451,58,19,10],
        ['Кресло красный',null,25000,25,0,0,0],['Кресло черный',null,25000,25,0,0,0],
      ];
      for (const [name,article,cost,comm,w,d,h] of products) {
        await client.query(
          `INSERT INTO catalog (name,article,cost,comm,w,d,h) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [name,article,cost,comm,w,d,h]
        );
      }
      console.log('Загружен каталог товаров');
    }

    await backfillWbCatalogFromTemplates(client);

    await repairAccessoryCatalog(client);

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
