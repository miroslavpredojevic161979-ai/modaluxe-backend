const pool = require('./db');

async function clearAll() {
  try {
    console.log("Čistim bazu podataka...");
    
    // Brišemo sve narudžbe kupaca i vraćamo ID na 1
    await pool.query('TRUNCATE TABLE orders RESTART IDENTITY CASCADE');
    console.log("✅ Sve izlazne narudžbe su obrisane!");

    // Brišemo sve ulazne račune (dobavljače) i vraćamo ID na 1
    await pool.query('TRUNCATE TABLE inbound_invoices RESTART IDENTITY CASCADE');
    console.log("✅ Svi ulazni računi su obrisani!");

    console.log("🎉 Baza je potpuno čista! Možeš pokrenuti server.");
    process.exit(0);
  } catch (err) {
    console.error("Greška pri čišćenju:", err);
    process.exit(1);
  }
}

clearAll();