const pool = require('./db');

// Ovo je naredba koja stvara tablicu
const sql = `
  CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    phone TEXT NOT NULL,
    total NUMERIC NOT NULL,
    items JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`;

async function stvoriTablicu() {
  try {
    await pool.query(sql);
    console.log("✅ Tablica 'orders' je uspješno napravljena!");
  } catch (error) {
    console.error("❌ Greška:", error);
  } finally {
    pool.end();
  }
}

stvoriTablicu();