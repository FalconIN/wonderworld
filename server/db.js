const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.PG_HOST     || 'localhost',
  port:     parseInt(process.env.PG_PORT || '5432'),
  database: process.env.PG_DATABASE || 'wonderworld',
  user:     process.env.PG_USER     || 'wonderworld',
  password: process.env.PG_PASSWORD || '',
  ssl:      false,
});

// The business operates in NZ time, and party_date is stored as the NZ calendar
// date the customer picked. Without this, CURRENT_DATE/NOW() resolve in the
// server OS's timezone, which can be a different calendar day than NZ.
pool.on('connect', client => {
  client.query("SET TIME ZONE 'Pacific/Auckland'");
});

module.exports = pool;
