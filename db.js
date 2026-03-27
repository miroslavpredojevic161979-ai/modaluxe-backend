const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

// Test spajanja
pool.connect((err, client, release) => {
  if (err) {
    return console.error('Greška u spajanju:', err.message);
  }
  console.log('USPJEH! Povezan s bazom podataka.');
  release();
});

module.exports = pool;