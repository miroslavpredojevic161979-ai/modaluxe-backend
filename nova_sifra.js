const bcrypt = require('bcrypt');

// Ovdje unutar navodnika upišite šifru koju želite (umjesto MOJATAJNASIFRA)
const mojaNovaSifra = "Miroslav2026"; 

bcrypt.hash(mojaNovaSifra, 10).then(hash => {
    console.log("------------------------------------------------");
    console.log("Kopirajte ovaj donji tekst u svoju .env datoteku:");
    console.log("ADMIN_HASH=" + hash);
    console.log("------------------------------------------------");
});