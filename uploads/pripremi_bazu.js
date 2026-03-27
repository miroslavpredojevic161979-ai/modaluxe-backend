const pool = require('./db');

async function popraviSve() {
  try {
    console.log("⏳ Pokrećem potpunu provjeru i popravak baze...");
    
    await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS brand VARCHAR(255) DEFAULT '';");
    await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS cost_price NUMERIC DEFAULT 0;");
    await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '';");
    await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS category VARCHAR(255) DEFAULT 'OSTALO';");
    await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS images TEXT DEFAULT '[]';");
    await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS variants TEXT DEFAULT '[]';");
    
    console.log("✅ Baza je uspješno popravljena! Sve potrebne kolone su tu.");
  } catch (err) {
    console.error("❌ Greška pri popravku baze:", err.message);
  } finally {
    process.exit();
  }
}

popraviSve();