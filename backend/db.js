require('dotenv').config();
const { Pool } = require('pg');

const ssl = process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false };
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
});

module.exports = pool;
