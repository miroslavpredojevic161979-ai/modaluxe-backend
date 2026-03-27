const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Osnovne postavke
app.use(cors());
app.use(express.json());

// Testna ruta (samo da vidimo da radi)
app.get('/', (req, res) => {
  res.send('Moda Luxe Backend radi!');
});

// Pokretanje servera
app.listen(PORT, () => {
  console.log(`Server radi na portu ${PORT}`);
});