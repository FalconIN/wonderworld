const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.PG_HOST     || 'localhost',
  port:     parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DATABASE || 'wonderworld',
  user:     process.env.PG_USER     || 'wonderworld',
  password: process.env.PG_PASSWORD || '',
  ssl:      false,
});

module.exports = pool;
