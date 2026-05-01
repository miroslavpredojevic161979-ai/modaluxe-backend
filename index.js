const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
require('dotenv').config();
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const pool = require('./db');
const nodemailer = require('nodemailer');
const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;
const cron = require('node-cron');
const puppeteer = require('puppeteer'); // PAMETNI SKENER
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();

const DEFAULT_ALLOWED_ORIGINS = [
  process.env.STOREFRONT_URL,
  process.env.ADMIN_URL,
  'https://moda-luxe-trgovina.vercel.app',
  'https://www.kisfaluba.hr',
  'https://kisfaluba.hr',
  'https://moda-luxe-admin.vercel.app',
  'https://modaluxe-admin.vercel.app',
  'http://localhost:8081',
  'http://127.0.0.1:8081',
  'http://localhost:19006',
  'http://127.0.0.1:19006',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
].filter(Boolean);

const allowedOrigins = Array.from(
  new Set(
    (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : DEFAULT_ALLOWED_ORIGINS)
      .map((origin) => String(origin).trim())
      .filter(Boolean)
  )
);

const isAllowedOrigin = (origin) => !origin || allowedOrigins.includes(origin);

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error('Origin nije dopušten.'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
};

app.use(cors(corsOptions));

// --- SOCKET.IO DODATAK ---
const http = require('http');
const { Server } = require('socket.io');

const server = http.createServer(app);
const io = new Server(server, {
  cors: corsOptions
});

app.set('io', io); // Spremamo io instancu da je možemo koristiti bilo gdje!
// -------------------------

// --- KONFIGURACIJA ---
const PORT = process.env.PORT || 10000;
const INVOICE_SECRET = process.env.INVOICE_SECRET;
const STOREFRONT_URL = process.env.STOREFRONT_URL || 'https://moda-luxe-trgovina.vercel.app';
const PAYMENT_SUCCESS_WEB_URL = process.env.PAYMENT_SUCCESS_WEB_URL || `${STOREFRONT_URL}?clearCart=true`;
const PAYMENT_CANCEL_WEB_URL = process.env.PAYMENT_CANCEL_WEB_URL || STOREFRONT_URL;
const PAYMENT_SUCCESS_APP_URL = process.env.PAYMENT_SUCCESS_APP_URL || 'modaluxe://payment-success';
const PAYMENT_CANCEL_APP_URL = process.env.PAYMENT_CANCEL_APP_URL || 'modaluxe://payment-cancel';
const SOLO_DEFAULT_KPD = (process.env.SOLO_DEFAULT_KPD || '').trim();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

if (!fs.existsSync(path.join(__dirname, 'uploads'))) {
  fs.mkdirSync(path.join(__dirname, 'uploads'));
}

// --- BAZA PODATAKA (MIGRACIJE) ---
const initDB = async () => {
  try {
    await pool.query("ALTER TABLE inbound_invoices ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'DOLAZNI'");
    await pool.query("ALTER TABLE inbound_invoices ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT false");
    await pool.query("ALTER TABLE inbound_invoices ADD COLUMN IF NOT EXISTS supplier_email VARCHAR(255)");
    await pool.query("ALTER TABLE inbound_invoices ADD COLUMN IF NOT EXISTS storno_url VARCHAR(255)");
    await pool.query("ALTER TABLE inbound_invoices ADD COLUMN IF NOT EXISTS image_url VARCHAR(1024)");
    await pool.query("ALTER TABLE inbound_invoices ADD COLUMN IF NOT EXISTS original_invoice_id INTEGER");
    await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT false");
    await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS storno_url VARCHAR(255)");
    await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount JSONB DEFAULT '{\"amount\": 0}'::jsonb");
    await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS stripe_session_id VARCHAR(255)");
    await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP");
    await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS company_name VARCHAR(255)");
    await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS company_oib VARCHAR(64)");
    await pool.query("ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS coupons JSONB DEFAULT '[]'::jsonb");
    await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS fit_info TEXT");
    await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS material_info TEXT");
    await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS manufacturer_info TEXT");
    await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS sustainability_info TEXT");
    await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_email VARCHAR(255)");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS complaints (
        id VARCHAR(255) PRIMARY KEY,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        full_name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        phone VARCHAR(255),
        order_id VARCHAR(255),
        message TEXT NOT NULL,
        status VARCHAR(50) DEFAULT 'NEW',
        admin_note TEXT
      );
    `);
    console.log("Baza podataka (kolone i tablice) uspješno sinkronizirana.");
  } catch (err) {
    console.error("Greška pri sinkronizaciji baze:", err.message);
  }
};
initDB();

// --- HELPER FUNKCIJE ---
const parseJsonSafe = (data, fallback) => {
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch (e) { return fallback; }
  }
  return data || fallback;
};

const escapeHtml = (v) => {
  if (v === null || v === undefined) return '';
  return String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
};


const normalizeNumberInput = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return value;

  let normalized = value.trim().replace(/\s/g, '');
  if (!normalized) return '';

  const hasComma = normalized.includes(',');
  const hasDot = normalized.includes('.');

  if (hasComma && hasDot) {
    normalized =
      normalized.lastIndexOf(',') > normalized.lastIndexOf('.')
        ? normalized.replace(/\./g, '').replace(',', '.')
        : normalized.replace(/,/g, '');
  } else if (hasComma) {
    normalized = normalized.replace(',', '.');
  }

  return normalized;
};

const toNumberSafe = (v) => {
  const n = Number(normalizeNumberInput(v));
  return Number.isFinite(n) ? n : 0;
};

const formatSoloDecimal = (value, decimals = 2) =>
  toNumberSafe(value).toFixed(decimals).replace('.', ',');

const normalizeHeroSlides = (slides) => {
  if (!Array.isArray(slides)) return [];

  return slides
    .filter((slide) => slide && typeof slide === 'object')
    .map((slide, index) => ({
      id: String(slide.id || `slide-${index + 1}`),
      image: String(slide.image || '').trim(),
      bgColor: String(slide.bgColor || '#FFFFFF').trim() || '#FFFFFF',
      textColor: String(slide.textColor || '#000000').trim() || '#000000',
      title: String(slide.title || '').trim(),
      sub: String(slide.sub || '').trim(),
      target: String(slide.target || '').trim(),
    }))
    .filter((slide) => slide.image);
};

const buildLegacyHeroSlides = (settings) => {
  if (!settings?.hero_img) return [];

  return [{
    id: 'legacy-hero',
    image: settings.hero_img,
    bgColor: '#FFFFFF',
    textColor: '#000000',
    title: settings.hero_title || '',
    sub: settings.hero_sub || '',
    target: '',
  }];
};

const fixText = (text) => {
  if (!text) return '';
  return String(text)
    .replace(/č/g, 'c').replace(/Č/g, 'C')
    .replace(/ć/g, 'c').replace(/Ć/g, 'C')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/š/g, 's').replace(/Š/g, 'S')
    .replace(/ž/g, 'z').replace(/Ž/g, 'Z');
};

const looksLikeUtf8Mojibake = (text) =>
  /(?:Ã.|Ä.|Å.|Æ.|Ë.|Œ.|Â.|â.|Ð.|Ñ.|Ò.|Ó.|Ô.|Õ.|Ö.|×.|Ø.|Ù.|Ú.|Û.|Ü.|Ý.|Þ.|ß.|Ĺ.|Ä‡|Ä‘|ÄŤ|ÄŤ|Äć|Ä‡|Å¾|Å¡|Å½|Å )/.test(text);

const cleanInboundUtfText = (value, options = {}) => {
  const { preserveWhitespace = false } = options;
  if (value === null || value === undefined) return '';

  let text = String(value).replace(/\u0000/g, '');
  if (!text) return '';

  if (looksLikeUtf8Mojibake(text)) {
    try {
      const decoded = Buffer.from(text, 'latin1').toString('utf8');
      if (decoded && decoded !== text && !decoded.includes('�')) {
        text = decoded;
      }
    } catch (err) {}
  }

  text = text.replace(/\u00A0/g, ' ').replace(/\r\n/g, '\n');
  return preserveWhitespace ? text.trim() : text.replace(/\s+/g, ' ').trim();
};

const parseInboundInvoiceAmount = (value) => {
  const normalized = normalizeNumberInput(value);
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return null;

  const rounded = Number(amount.toFixed(2));
  return rounded > 0 ? rounded : null;
};

const invoiceNumberFromOrderId = (orderId) => `${orderId}/${new Date().getFullYear()}/KF`;

const calcTotals = (items) => {
  const sum = parseJsonSafe(items, []).reduce((acc, it) => {
    return acc + toNumberSafe(it.price) * toNumberSafe(it.qty || it.quantity || 1);
  }, 0);
  return Number(sum.toFixed(2));
};

const normalizeText = (value = '') => String(value ?? '').trim();

const getSoloPaymentType = (paymentMethod, isPaid) => {
  const normalized = normalizeText(paymentMethod).toUpperCase();

  if (normalized === 'TRANSAKCIJSKI') return '1';
  if (normalized === 'GOTOVINA') return '2';
  if (normalized === 'KARTICE' || normalized === 'KARTICA' || normalized === 'STRIPE' || normalized === 'CARD') return '3';

  return isPaid ? '3' : '2';
};

const getSoloCustomerData = (orderData = {}) => {
  const companyName = normalizeText(orderData.companyName);
  const oib = normalizeText(orderData.oib);
  const name = normalizeText(orderData.name) || 'Gost';
  const address = normalizeText(orderData.address);
  const isB2B = Boolean(companyName && oib);

  return { companyName, oib, name, address, isB2B };
};

const buildBlagajnaOrderData = (body = {}) => {
  const rawItems = parseJsonSafe(body.items, []);
  const normalizedItems = Array.isArray(rawItems)
    ? rawItems
        .map((item) => {
          const description = normalizeText(item.description || item.name);
          const qty = toNumberSafe(item.qty || item.quantity || 1);
          const price = toNumberSafe(String(item.price ?? 0).replace(',', '.'));

          if (!description || qty <= 0 || price < 0) return null;

          return {
            brand: normalizeText(item.brand),
            name: description,
            qty,
            price,
            kpd: normalizeText(item.kpd),
          };
        })
        .filter(Boolean)
    : [];

  return {
    id: body.reference || `BLAGAJNA-${Date.now()}`,
    name: normalizeText(body.name || body.customerName),
    companyName: normalizeText(body.companyName),
    oib: normalizeText(body.oib),
    address: normalizeText(body.address),
    phone: normalizeText(body.phone),
    email: normalizeText(body.email),
    paymentMethod: normalizeText(body.paymentMethod || 'TRANSAKCIJSKI'),
    note: normalizeText(body.note),
    items: JSON.stringify(normalizedItems),
    total: calcTotals(normalizedItems),
    discount: JSON.stringify({ amount: 0 }),
  };
};

// --- SOLO.HR FISKALIZACIJA ---
const buildSoloInvoiceParams = (orderData, isPaid, isStorno = false, paymentMethodOverride = '') => {
  const token = process.env.SOLO_API_TOKEN;
  if (!token) return null;

  const items = parseJsonSafe(orderData.items, []);
  const { companyName, oib, name, address, isB2B } = getSoloCustomerData(orderData);

  const params = new URLSearchParams();
  params.append('token', token);
  params.append('tip_racuna', isB2B ? '2' : '1');
  params.append('tip_usluge', '1');
  params.append('tip_kupca', isB2B ? '2' : '1');
  params.append('kupac_naziv', isB2B ? companyName : name);
  params.append('kupac_adresa', address);
  if (isB2B) {
    params.append('kupac_oib', oib);
  }
  params.append('nacin_placanja', getSoloPaymentType(paymentMethodOverride || orderData.paymentMethod, isPaid));
  params.append('prikazi_porez', '0');
  params.append('fiskalizacija', '1');

  if (isStorno) {
    const stornoNote = orderData.note
      ? `Storno računa. ${orderData.note}`
      : `Storno računa za narudžbu ${orderData.id}. Povrat sredstava kupcu.`;
    params.append('napomena', stornoNote);
  }

  const popustObj = parseJsonSafe(orderData.discount, { amount: 0 });
  let popustPostotak = '0';

  if (popustObj && popustObj.amount > 0) {
    let ukupnoArtikli = items.reduce(
      (acc, item) => acc + (toNumberSafe(item.price || 0) * toNumberSafe(item.qty || 1)),
      0
    );
    if (ukupnoArtikli > 0) {
      let izracunatiPostotak = (toNumberSafe(popustObj.amount) / ukupnoArtikli) * 100;
      popustPostotak = formatSoloDecimal(izracunatiPostotak, 4);
    }
  }

  items.forEach((item, index) => {
    const i = index + 1;
    let naziv = `${item.brand || ''} ${item.name || ''}`.trim();
    if (!naziv || naziv === 'undefined') naziv = 'Artikl';

    let kolicina = toNumberSafe(item.qty || 1);
    let cijena = toNumberSafe(item.price || 0);

    if (isStorno) {
      cijena = -Math.abs(cijena);
    }

    if (isB2B) {
      const kpd = normalizeText(item.kpd || SOLO_DEFAULT_KPD);
      if (!kpd) {
        throw new Error('R1/B2B račun traži KPD oznaku. Postavi SOLO_DEFAULT_KPD u .env ili pošalji item.kpd.');
      }
      params.append(`kpd_${i}`, kpd);
    }

    params.append('usluga', String(i));
    params.append(`opis_usluge_${i}`, escapeHtml(naziv).substring(0, 990));
    params.append(`kolicina_${i}`, String(kolicina));
    params.append(`cijena_${i}`, formatSoloDecimal(cijena));
    params.append(`porez_stopa_${i}`, '0');
    params.append(`popust_${i}`, popustPostotak);
  });

  return params;
};

const createSoloInvoiceDetailed = async (orderData, isPaid, isStorno = false, paymentMethodOverride = '') => {
  try {
    const params = buildSoloInvoiceParams(orderData, isPaid, isStorno, paymentMethodOverride);
    if (!params) return { invoice: null, rateLimited: false, data: null };

    const res = await axios.post('https://api.solo.com.hr/racun', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (res.data && res.data.racun) {
      console.log(`Solo ${isStorno ? 'STORNO ' : ''}račun uspješno kreiran! PDF: ` + res.data.racun.pdf);
      return { invoice: res.data.racun, rateLimited: false, data: res.data };
    }

    const soloMessage = String(res?.data?.message || '');
    const rateLimited = soloMessage.includes('Pričekaj barem 10 sekundi prije slanja novog zahtjeva.');
    console.error("Solo.hr odbio račun. Detalji:", JSON.stringify(res.data));
    return { invoice: null, rateLimited, data: res.data };
  } catch (err) {
    console.error("Greška pri spajanju sa Solo.hr:", err.message);
    return { invoice: null, rateLimited: false, data: null, error: err };
  }
};

const createSoloInvoice = async (orderData, isPaid, isStorno = false, paymentMethodOverride = '') => {
  const result = await createSoloInvoiceDetailed(orderData, isPaid, isStorno, paymentMethodOverride);
  return result.invoice;
};


// --- UPLOAD (MULTER + CLOUDINARY) ---
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'modaluxe_slike',
    resource_type: 'auto'
  }
});

const fileFilter = (req, file, cb) => {
  if (
    file.mimetype.startsWith('image/') || 
    file.mimetype === 'application/pdf' ||
    file.mimetype === 'application/octet-stream'
  ) {
    cb(null, true);
  } else {
    cb(new Error('Nedopušten format datoteke! Dobio sam: ' + file.mimetype), false);
  }
};

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, 
  fileFilter: fileFilter
});

const uploadBufferToCloudinary = (buffer, filename, resourceType = 'auto') => {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      { 
        folder: 'kisfaluba_ura', 
        public_id: filename, 
        resource_type: resourceType
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    uploadStream.end(buffer);
  });
};


// --- MAIL TRANSPORTER ---
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: { rejectUnauthorized: false }
});

// --- SLANJE NALOGA DOBAVLJAČIMA (DROPSHIPPING) ---
const sendPackingSlipsToSuppliers = async (order, items) => {
  try {
    const supplierGroups = {};
    
    for (const item of items) {
      if (!item.id) continue;
      
      const res = await pool.query('SELECT supplier_email FROM products WHERE id = $1', [item.id]);
      if (res.rows.length === 0 || !res.rows[0].supplier_email) {
        console.log(`[INFO] Artikl '${item.name}' NEMA upisan email dobavljača u bazi, preskačem slanje naloga.`);
        continue; 
      }
      
      const email = res.rows[0].supplier_email.trim();
      if (!supplierGroups[email]) {
        supplierGroups[email] = [];
      }
      supplierGroups[email].push(item);
    }

    if (Object.keys(supplierGroups).length === 0) {
        console.log("[INFO] Niti jedan artikl iz ove narudžbe nema mail dobavljača. Mail NIJE poslan.");
        return;
    }

    for (const [supplierEmail, supplierItems] of Object.entries(supplierGroups)) {
      
      const itemsHtml = supplierItems.map(i => {
        const qty = i.qty || i.quantity || 1;
        const brand = i.brand || '';
        const variant = i.selectedVariantKey ? i.selectedVariantKey.split('|')[0] : 'Standard';
        return `<li style="margin-bottom: 10px; font-size: 16px;">
          <strong>${qty}x</strong> ${brand} ${i.name} 
          <br><span style="color: #d69e2e; font-size: 14px;">Veličina/Boja: <strong>${variant}</strong></span>
        </li>`;
      }).join('');

      const mailOptions = {
        from: `"Kišfaluba Tradicija" <${process.env.EMAIL_USER}>`,
        to: supplierEmail,
        subject: "NOVI RADNI NALOG - Narudžba #" + order.id,
        html: `
          <div style="font-family: Arial, sans-serif; color: #111; max-width: 600px; margin: auto; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;">
            <div style="background-color: #000; color: #D4AF37; padding: 20px; text-align: center;">
              <h2 style="margin: 0; letter-spacing: 2px;">KIŠFALUBA - RADNI NALOG</h2>
              <p style="margin: 5px 0 0 0; font-size: 12px; color: #fff;">Službeni nalog za pakiranje i slanje robe</p>
            </div>
            
            <div style="padding: 20px;">
              <p>Poštovani,</p>
              <p>Zaprimili smo novu narudžbu. Molimo vas da zapakirate sljedeće proizvode u Kisfaluba ambalažu i pošaljete kupcu na ovu adresu:</p>
              
              <div style="background-color: #f7fafc; padding: 15px; border-left: 4px solid #D4AF37; margin: 20px 0;">
                <h3 style="margin-top: 0; color: #2b6cb0;">PODACI KUPCA ZA DOSTAVU:</h3>
                <p style="margin: 0; font-size: 16px;"><strong>Ime i prezime:</strong> ${order.name}</p>
                <p style="margin: 5px 0 0 0; font-size: 16px;"><strong>Adresa:</strong> ${order.address}</p>
                <p style="margin: 5px 0 0 0; font-size: 16px;"><strong>Telefon (za kurira):</strong> ${order.phone}</p>
              </div>

              <h3 style="border-bottom: 2px solid #eee; padding-bottom: 5px;">STAVKE ZA PAKIRANJE:</h3>
              <ul style="list-style-type: none; padding: 0;">
                ${itemsHtml}
              </ul>

              <p style="margin-top: 30px; font-size: 12px; color: #e53e3e; font-weight: bold;">
                NAPOMENA: U paket NE STAVLJATI račune s cijenama. Račun je kupcu već poslan elektronički. U paket obavezno priložiti letak s pravom na povrat.
              </p>
            </div>
            
            <div style="background-color: #f1f1f1; padding: 15px; text-align: center; font-size: 11px; color: #666;">
              Automatski generirano iz Kisfaluba sustava. Narudžba ID: ${order.id}
            </div>
          </div>
        `
      };

      await transporter.sendMail(mailOptions);
      console.log("Radni nalog poslan dobavljaču: " + supplierEmail);
    }
  } catch (error) {
    console.error("Greška pri slanju maila dobavljačima:", error);
  }
};

const soloInvoiceQueue = [];
let soloInvoiceProcessing = false;
const SOLO_INVOICE_DELAY_MS = 12000;
let soloQueueJobCounter = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const createSoloJobId = () => `solo-job-${Date.now()}-${++soloQueueJobCounter}`;

const sendPaidInvoiceEmailToCustomer = async (order, invoiceUrl, invoiceNumber) => {
  if (!order?.email || !invoiceUrl) return;

  await transporter.sendMail({
    from: `"KIŠFALUBA j.d.o.o." <${process.env.EMAIL_USER}>`,
    to: order.email,
    bcc: process.env.EMAIL_USER,
    subject: `Fiskalizirani račun za narudžbu br. ${invoiceNumber}`,
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #D4AF37; text-align: center;">
        <h2>Hvala na kupnji!</h2>
        <p>Vaša uplata je uspješno obrađena.</p>
        <p>Službeni fiskalizirani račun nalazi se u <strong>privitku ovog e-maila</strong>, a možete ga preuzeti i klikom na gumb ispod:</p>
        <a href="${invoiceUrl}" style="background-color: #D4AF37; color: black; padding: 15px 25px; text-decoration: none; font-weight: bold; border-radius: 5px; display: inline-block; margin: 20px 0;">PREUZMI PDF RAČUN</a>
      </div>
    `,
    attachments: [
      {
        filename: `Racun_Kisfaluba_${invoiceNumber.replace(/\//g, '_')}.pdf`,
        path: invoiceUrl
      }
    ]
  });
};

const sendBlagajnaInvoiceEmailToCustomer = async (orderData, invoiceUrl, invoiceNumber, savedOrderId) => {
  if (!orderData?.email || !invoiceUrl) return;

  await transporter.sendMail({
    from: `"KIŠFALUBA j.d.o.o." <${process.env.EMAIL_USER}>`,
    to: orderData.email,
    bcc: process.env.EMAIL_USER,
    subject: `Fiskalizirani račun br. ${invoiceNumber || savedOrderId}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; text-align: center;">
        <h2 style="color: #000;">Vaš račun je uspješno izdan</h2>
        <p>U privitku ovog e-maila nalazi se službeni fiskalizirani račun.</p>
        <div style="margin: 30px 0;">
          <a href="${invoiceUrl}" style="background-color: #D4AF37; color: black; padding: 15px 25px; text-decoration: none; font-weight: bold; border-radius: 5px; display: inline-block;">PREUZMI PDF RAČUN</a>
        </div>
        <p style="font-size: 11px; color: #777;">Račun je izdan automatski kroz Blagajnu i fiskaliziran u Solo.hr.</p>
      </div>
    `,
    attachments: [
      {
        filename: `Racun_Kisfaluba_${String(invoiceNumber || savedOrderId).replace(/\//g, '_')}.pdf`,
        path: invoiceUrl
      }
    ]
  });
};

const normalizeQueuedOrderId = (orderId) => {
  const parsed = parseInt(String(orderId || '').split('-')[0], 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const settleSoloJob = (job, result, error = null) => {
  if (!job || job.settled) return;
  job.settled = true;

  if (error) {
    if (typeof job.reject === 'function') job.reject(error);
    return;
  }

  if (typeof job.resolve === 'function') job.resolve(result);
};

const saveBlagajnaInvoiceOrder = async (orderData, items, invoiceUrl) => {
  const savedOrderResult = await pool.query(
    "INSERT INTO orders (name, address, phone, email, total, items, status, discount, invoice_url, paid_at, company_name, company_oib) VALUES ($1, $2, $3, $4, $5, $6, 'PAID', $7, $8, NOW(), $9, $10) RETURNING *",
    [
      orderData.name || orderData.companyName || 'Blagajna kupac',
      orderData.address || '',
      orderData.phone || '',
      orderData.email || '',
      calcTotals(items),
      JSON.stringify(items),
      orderData.discount || JSON.stringify({ amount: 0 }),
      invoiceUrl,
      orderData.companyName || '',
      orderData.oib || ''
    ]
  );

  return savedOrderResult.rows[0];
};

const processOrderSoloJob = async (job) => {
  const orderResult = await pool.query(
    'SELECT * FROM orders WHERE id = $1 LIMIT 1',
    [job.orderId]
  );
  const order = orderResult.rows[0];

  if (!order) {
    return { status: 'skip' };
  }

  if (order.invoice_url) {
    console.log(`[SOLO QUEUE] Preskačem jer invoice_url već postoji za orderId ${job.orderId}`);
    return { status: 'skip' };
  }

  const soloResult = await createSoloInvoiceDetailed(
    {
      ...order,
      companyName: order.company_name || '',
      oib: order.company_oib || '',
    },
    true
  );

  if (soloResult.invoice && soloResult.invoice.pdf) {
    const invoiceUrl = soloResult.invoice.pdf;
    const invoiceNumber = soloResult.invoice.broj_racuna || invoiceNumberFromOrderId(job.orderId);

    const updatedResult = await pool.query(
      'UPDATE orders SET invoice_url = $1 WHERE id = $2 RETURNING *',
      [invoiceUrl, job.orderId]
    );

    const updatedOrder = updatedResult.rows[0] || { ...order, invoice_url: invoiceUrl };
    await sendPaidInvoiceEmailToCustomer(updatedOrder, invoiceUrl, invoiceNumber).catch((err) => {
      console.error(`[SOLO QUEUE] Greška slanja računa kupcu za orderId ${job.orderId}:`, err);
    });
    await sendPackingSlipsToSuppliers(updatedOrder, parseJsonSafe(updatedOrder.items, []));

    return { status: 'success' };
  }

  if (soloResult.rateLimited) {
    return { status: 'retry' };
  }

  return { status: 'error', error: new Error(`Solo nije izdao račun za orderId ${job.orderId}`) };
};

const processBlagajnaInvoiceJob = async (job) => {
  const orderData = buildBlagajnaOrderData(job.payload);
  const items = parseJsonSafe(orderData.items, []);
  const soloResult = await createSoloInvoiceDetailed(orderData, true, false, orderData.paymentMethod);

  if (soloResult.invoice && soloResult.invoice.pdf) {
    const invoiceUrl = soloResult.invoice.pdf;
    const invoiceNumber = soloResult.invoice.broj_racuna || null;
    const savedOrder = await saveBlagajnaInvoiceOrder(orderData, items, invoiceUrl);

    await sendBlagajnaInvoiceEmailToCustomer(orderData, invoiceUrl, invoiceNumber, savedOrder.id).catch((err) => {
      console.error(`[SOLO QUEUE] Greška slanja blagajna računa kupcu za job ${job.id}:`, err);
    });

    return {
      status: 'success',
      response: {
        success: true,
        documentUrl: invoiceUrl,
        invoiceNumber,
        orderId: savedOrder.id,
      }
    };
  }

  if (soloResult.rateLimited) {
    return { status: 'retry' };
  }

  return { status: 'error', error: new Error('Solo.hr nije vratio PDF računa.') };
};

const processBlagajnaStornoJob = async (job) => {
  const orderData = buildBlagajnaOrderData(job.payload);
  const soloResult = await createSoloInvoiceDetailed(orderData, true, true, orderData.paymentMethod);

  if (soloResult.invoice && soloResult.invoice.pdf) {
    return {
      status: 'success',
      response: {
        success: true,
        documentUrl: soloResult.invoice.pdf,
        invoiceNumber: soloResult.invoice.broj_racuna || null,
      }
    };
  }

  if (soloResult.rateLimited) {
    return { status: 'retry' };
  }

  return { status: 'error', error: new Error('Solo.hr nije vratio PDF storna.') };
};

const enqueueSoloJob = async (jobInput) => {
  if (!jobInput || !jobInput.type) return null;

  if (jobInput.type === 'order') {
    const normalizedOrderId = normalizeQueuedOrderId(jobInput.orderId);
    if (!normalizedOrderId) return null;

    const result = await pool.query(
      'SELECT id, invoice_url FROM orders WHERE id = $1 LIMIT 1',
      [normalizedOrderId]
    );
    const order = result.rows[0];

    if (!order) return null;
    if (order.invoice_url) {
      console.log(`[SOLO QUEUE] Preskačem jer invoice_url već postoji za orderId ${normalizedOrderId}`);
      return { queued: false, skipped: true };
    }
    if (soloInvoiceQueue.some((queuedJob) => queuedJob.type === 'order' && queuedJob.orderId === normalizedOrderId)) {
      return { queued: true, duplicate: true };
    }

    const job = {
      id: createSoloJobId(),
      type: 'order',
      orderId: normalizedOrderId,
      settled: false,
    };

    soloInvoiceQueue.push(job);
    console.log(`[SOLO QUEUE] Dodan job ${job.type} (${normalizedOrderId})`);
    processSoloInvoiceQueue().catch((err) => {
      console.error('[SOLO QUEUE] Neočekivana greška pri pokretanju queue worker-a:', err);
    });
    return { queued: true };
  }

  return await new Promise((resolve, reject) => {
    const job = {
      id: createSoloJobId(),
      type: jobInput.type,
      payload: jobInput.payload,
      resolve,
      reject,
      settled: false,
    };

    soloInvoiceQueue.push(job);
    console.log(`[SOLO QUEUE] Dodan job ${job.type} (${job.id})`);
    processSoloInvoiceQueue().catch((err) => {
      console.error('[SOLO QUEUE] Neočekivana greška pri pokretanju queue worker-a:', err);
      settleSoloJob(job, null, err);
    });
  });
};

const processSoloInvoiceQueue = async () => {
  if (soloInvoiceProcessing) return;
  soloInvoiceProcessing = true;

  try {
    while (soloInvoiceQueue.length > 0) {
      const job = soloInvoiceQueue[0];
      console.log(`[SOLO QUEUE] Obrađujem job ${job.type} (${job.orderId || job.id})`);

      let outcome = { status: 'skip' };

      try {
        if (job.type === 'order') {
          outcome = await processOrderSoloJob(job);
        } else if (job.type === 'blagajna-invoice') {
          outcome = await processBlagajnaInvoiceJob(job);
        } else if (job.type === 'blagajna-storno') {
          outcome = await processBlagajnaStornoJob(job);
        } else {
          outcome = { status: 'error', error: new Error(`Nepoznat Solo job tip: ${job.type}`) };
        }
      } catch (err) {
        outcome = { status: 'error', error: err };
      }

      soloInvoiceQueue.shift();

      if (outcome.status === 'retry') {
        console.log(`[SOLO QUEUE] Rate limit, vraćam job u queue ${job.type} (${job.orderId || job.id})`);
        soloInvoiceQueue.push(job);
      } else if (outcome.status === 'success') {
        console.log(`[SOLO QUEUE] Job uspješan ${job.type} (${job.orderId || job.id})`);
        settleSoloJob(job, outcome.response || { success: true });
      } else if (outcome.status === 'error') {
        console.log(`[SOLO QUEUE] Job hard fail ${job.type} (${job.orderId || job.id})`);
        if (outcome.error) {
          console.error(outcome.error);
        }
        settleSoloJob(job, null, outcome.error || new Error('Solo queue job nije uspio.'));
      } else {
        settleSoloJob(job, outcome.response || { success: true });
      }

      if (soloInvoiceQueue.length > 0) {
        console.log(`[SOLO QUEUE] Čekam ${SOLO_INVOICE_DELAY_MS} ms`);
        await sleep(SOLO_INVOICE_DELAY_MS);
      }
    }
  } finally {
    soloInvoiceProcessing = false;
    if (soloInvoiceQueue.length > 0) {
      processSoloInvoiceQueue().catch((err) => {
        console.error('[SOLO QUEUE] Greška pri nastavku queue worker-a:', err);
      });
    }
  }
};

const recoverPendingSoloInvoices = async () => {
  try {
    const pendingOrdersResult = await pool.query(
      "SELECT id FROM orders WHERE status = 'PAID' AND (invoice_url IS NULL OR TRIM(invoice_url) = '') ORDER BY id ASC"
    );

    for (const row of pendingOrdersResult.rows) {
      console.log(`[SOLO RECOVERY] Vraćam PAID narudžbu bez računa u queue (${row.id})`);
      await enqueueSoloJob({ type: 'order', orderId: row.id });
    }
  } catch (error) {
    console.error('[SOLO RECOVERY] Greška pri recovery-u PAID narudžbi bez računa:', error);
  }
};

// --- SKIDANJE ZALIHE ---
const deductStock = async (items) => {
  try {
    for (const item of items) {
      if (!item.id) continue;
      const res = await pool.query('SELECT variants FROM products WHERE id = $1', [item.id]);
      if (res.rows.length === 0) continue;
      
      let variants = parseJsonSafe(res.rows[0].variants, []);
      const targetKey = (item.selectedVariantKey || item.variantKey || 'ONE|DEFAULT').toUpperCase();
      const qtyToDeduct = toNumberSafe(item.qty || item.quantity || 1);
      
      let updated = false;
      variants = variants.map(v => {
        if (v.key === targetKey) {
          updated = true;
          return { ...v, stock: Math.max(0, v.stock - qtyToDeduct) }; 
        }
        return v;
      });
      
      if (updated) {
        await pool.query('UPDATE products SET variants = $1 WHERE id = $2', [JSON.stringify(variants), item.id]);
      }
    }
  } catch (e) {
    console.error('Greška pri trajnom skidanju zalihe:', e);
  }
};

// --- PAMETNI CITAC MAILOVA SA SKENEROM ---
async function fetchInboundInvoicesFromEmail() {
  const config = {
    imap: {
      user: process.env.INBOUND_EMAIL_USER,
      password: process.env.INBOUND_EMAIL_PASS,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      authTimeout: 10000,
      tlsOptions: { rejectUnauthorized: false }
    }
  };

  try {
    console.log('Provjeravam nove racune dobavljaca...');
    const connection = await imaps.connect(config);
    await connection.openBox('INBOX');

    const searchCriteria = ['UNSEEN'];
    const fetchOptions = { bodies: ['HEADER', 'TEXT', ''], markSeen: true };
    const messages = await connection.search(searchCriteria, fetchOptions);

    for (let item of messages) {
      try {
        const all = item.parts.find(part => part.which === '');
        const id = item.attributes.uid;
        const idHeader = "Imap-Id: " + id + "\r\n";
        const mail = await simpleParser(idHeader + all.body);

        const senderAddress = cleanInboundUtfText(
          mail.from && mail.from.value[0] ? mail.from.value[0].address : 'Nepoznato'
        );
        const supplierName = cleanInboundUtfText(
          (mail.from && mail.from.value[0].name) ? mail.from.value[0].name : senderAddress
        );

        if (senderAddress.toLowerCase() === process.env.EMAIL_USER.toLowerCase()) continue;

        const dateStr = new Date().toLocaleDateString('hr-HR');
        const subject = cleanInboundUtfText(mail.subject || 'Automatski uvoz iz maila');

        let extractedAmount = 0;
        const cleanMailText = cleanInboundUtfText(mail.text || '', { preserveWhitespace: true });
        const cleanMailHtml = cleanInboundUtfText(mail.html || '', { preserveWhitespace: true });
        const textToSearch = cleanMailText + ' ' + cleanMailHtml;
        const amountRegex = /(?:ukupno|iznos|total|za platiti|iznos racuna|iznos računa)[^\d]*([\d]+[.,]\d{2})/i;
        const match = textToSearch.match(amountRegex);

        if (match && match[1]) {
          extractedAmount = parseFloat(match[1].replace(',', '.'));
        } else {
          const eurRegex = /([\d]+[.,]\d{2})\s*(?:eur|€)/gi;
          let eurMatches = [...textToSearch.matchAll(eurRegex)];
          if (eurMatches.length > 0) {
            const lastMatch = eurMatches[eurMatches.length - 1][1];
            extractedAmount = parseFloat(lastMatch.replace(',', '.'));
          }
        }
        if (isNaN(extractedAmount)) extractedAmount = 0;

        const validAttachments = (mail.attachments || []).filter(attr =>
          attr.contentType === 'application/pdf' ||
          attr.contentType?.startsWith('image/') ||
          attr.filename?.toLowerCase().match(/\.(pdf|jpg|jpeg|png)$/)
        );

        let finalFileUrl = null;
        let finalNote = subject;

        if (validAttachments.length > 0) {
          try {
            const attachment = validAttachments[0];
            const fName = `ura_doc_${Date.now()}`;
            const uploadResult = await uploadBufferToCloudinary(attachment.content, fName, 'auto');
            finalFileUrl = uploadResult.secure_url;
          } catch (e) {
            console.error('Cloudinary upload greska:', e);
          }
        } else {
          try {
            console.log('Uslikavam HTML mail...');
            const htmlContent = cleanMailHtml || `<div style="font-family: Arial; padding: 20px; white-space: pre-wrap;">${escapeHtml(cleanMailText || subject)}</div>`;
            const browser = await puppeteer.launch({
              headless: true,
              args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process',
                '--disable-gpu',
                '--no-zygote',
                '--disable-software-rasterizer'
              ]
            });
            const page = await browser.newPage();
            await page.setContent(htmlContent, { waitUntil: 'domcontentloaded', timeout: 20000 });

            const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
            await browser.close();

            const fName = `ura_sken_${Date.now()}`;
            const uploadResult = await uploadBufferToCloudinary(pdfBuffer, fName, 'image');
            finalFileUrl = uploadResult.secure_url;
            finalNote = 'Iz maila (Skenirano)';
          } catch (puppeteerErr) {
            console.error('Puppeteer greska, spasavam kao obican tekst:', puppeteerErr);
            try {
              const fName = `ura_tekst_${Date.now()}`;
              const doc = new PDFDocument({ margin: 40, size: 'A4' });
              let buffers = [];
              doc.on('data', buffers.push.bind(buffers));
              const uploadPromise = new Promise((resolve, reject) => {
                doc.on('end', async () => {
                  try {
                    let pdfData = Buffer.concat(buffers);
                    const result = await uploadBufferToCloudinary(pdfData, fName, 'image');
                    resolve(result.secure_url);
                  } catch (err) { reject(err); }
                });
              });
              doc.fontSize(16).text('Sadrzaj e-maila (Tekstualni format)', { align: 'center' }).moveDown(2);
              doc.fontSize(10).text(fixText(cleanMailText || 'E-mail ne sadrzi HTML ili se slike nisu mogle ucitati.'));
              doc.end();
              finalFileUrl = await uploadPromise;
            } catch (fallbackErr) { console.error(fallbackErr); }
          }
        }

        const cleanInvoiceNumber = cleanInboundUtfText(finalNote === subject ? 'Iz maila' : finalNote);
        const cleanNote = cleanInboundUtfText(subject, { preserveWhitespace: true });

        await pool.query(
          "INSERT INTO inbound_invoices (supplier, supplier_email, invoice_number, amount, file_url, note, date, status, archived) VALUES ($1, $2, $3, $4, $5, $6, $7, 'DOLAZNI', false)",
          [supplierName, senderAddress, cleanInvoiceNumber, extractedAmount, finalFileUrl, cleanNote, dateStr]
        );
        console.log(`Racun od ${supplierName} (${extractedAmount} EUR) uspjesno spremljen.`);

      } catch (singleMailErr) {
        console.error('Greska pri obradi JEDNOG maila:', singleMailErr.message);
      }
    }
    if (connection) connection.end();
  } catch (err) {
    console.error('IMAP Greska:', err.message);
  }
}

const buildInboundStornoNumber = (invoiceNumber, originalId) => {
  const safeNumber = String(invoiceNumber || `URA-${originalId}`).trim();
  return safeNumber.toUpperCase().includes('STORNO') ? safeNumber : `STORNO-${safeNumber}`;
};

const ensureInboundStornoPdf = async (originalInvoice) => {
  const fileName = `ura_storno_${originalInvoice.id}_${Date.now()}.pdf`;
  const filePath = path.join(__dirname, 'uploads', fileName);
  await generateUraStornoPDF(originalInvoice, filePath);

  const uploadResult = await cloudinary.uploader.upload(filePath, {
    folder: 'kisfaluba_ura',
    resource_type: 'image'
  });

  try { fs.unlinkSync(filePath); } catch (e) { console.error(e); }
  return uploadResult.secure_url;
};

const createOrRefreshInboundStornoRecord = async (originalInvoice, stornoUrl, originalAmount) => {
  const cleanSupplier = cleanInboundUtfText(originalInvoice.supplier);
  const cleanSupplierEmail = cleanInboundUtfText(originalInvoice.supplier_email || '');
  const cleanInvoiceNumber = cleanInboundUtfText(originalInvoice.invoice_number || `URA-${originalInvoice.id}`);
  const stornoNumber = buildInboundStornoNumber(cleanInvoiceNumber, originalInvoice.id);
  const stornoAmount = -Math.abs(originalAmount);
  const stornoDate = new Date().toLocaleDateString('hr-HR');
  const stornoNote = cleanInboundUtfText(originalInvoice.note)
    ? `STORNO | ${cleanInboundUtfText(originalInvoice.note)}`
    : `STORNO za račun ${cleanInvoiceNumber}`;

  const existingStorno = await pool.query(
    'SELECT * FROM inbound_invoices WHERE original_invoice_id = $1 ORDER BY id DESC LIMIT 1',
    [originalInvoice.id]
  );

  if (existingStorno.rows.length > 0) {
    const refreshed = await pool.query(
      "UPDATE inbound_invoices SET supplier = $1, supplier_email = $2, invoice_number = $3, amount = $4, file_url = $5, storno_url = $6, note = $7, date = $8, status = 'POVRATI', archived = false WHERE id = $9 RETURNING *",
      [
        cleanSupplier,
        cleanSupplierEmail,
        stornoNumber,
        stornoAmount,
        stornoUrl,
        stornoUrl,
        stornoNote,
        stornoDate,
        existingStorno.rows[0].id
      ]
    );
    return refreshed.rows[0];
  }

  const inserted = await pool.query(
    "INSERT INTO inbound_invoices (supplier, supplier_email, invoice_number, amount, file_url, storno_url, note, date, status, archived, original_invoice_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'POVRATI', false, $9) RETURNING *",
    [
      cleanSupplier,
      cleanSupplierEmail,
      stornoNumber,
      stornoAmount,
      stornoUrl,
      stornoUrl,
      stornoNote,
      stornoDate,
      originalInvoice.id
    ]
  );

  return inserted.rows[0];
};

const renderInboundPdfFromHtml = async (html, filePath) => {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process',
      '--disable-gpu',
      '--no-zygote',
      '--disable-software-rasterizer'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.pdf({
      path: filePath,
      format: 'A4',
      printBackground: true,
      margin: { top: '24px', right: '24px', bottom: '24px', left: '24px' }
    });
  } finally {
    await browser.close();
  }
};

const generateUraStornoPDF = async (inv, filePath) => {
  const validAmount = parseInboundInvoiceAmount(inv.amount);
  if (validAmount === null) {
    throw new Error('Originalni ulazni račun nema ispravan iznos za storno.');
  }

  const d = new Date();
  const dateStr = d.toLocaleDateString('hr-HR');
  const timeStr = d.toLocaleTimeString('hr-HR');
  const supplierName = cleanInboundUtfText(inv.supplier || 'Nepoznato');
  const originalInvoiceNumber = cleanInboundUtfText(inv.invoice_number || 'N/A');
  const stornoInvoiceNumber = buildInboundStornoNumber(originalInvoiceNumber, inv.id);
  const note = cleanInboundUtfText(inv.note || '', { preserveWhitespace: true });
  const price = Math.abs(validAmount).toFixed(2);
  const negativePrice = `-${price}`;

  const html = `<!DOCTYPE html>
  <html lang="hr">
    <head>
      <meta charset="UTF-8" />
      <style>
        body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 12px; }
        .wrap { max-width: 760px; margin: 0 auto; }
        .title { text-align: center; font-size: 24px; font-weight: 700; margin-bottom: 20px; }
        .subtitle { text-align: center; font-size: 18px; font-weight: 700; color: #c53030; margin: 24px 0 12px; }
        .line { border-top: 1px solid #ddd; margin: 12px 0 18px; }
        .meta { display: table; width: 100%; margin-bottom: 18px; }
        .meta-row { display: table-row; }
        .meta-label, .meta-value { display: table-cell; padding: 4px 0; vertical-align: top; }
        .meta-label { width: 170px; font-weight: 700; }
        table { width: 100%; border-collapse: collapse; margin-top: 16px; }
        th, td { border: 1px solid #ddd; padding: 8px; font-size: 12px; }
        th { background: #f7f7f7; text-align: left; }
        .right { text-align: right; }
        .center { text-align: center; }
        .total { margin-top: 18px; text-align: right; font-size: 18px; font-weight: 700; color: #c53030; }
        .note { margin-top: 18px; font-size: 11px; color: #666; }
      </style>
    </head>
    <body>
      <div class="wrap">
        <div class="title">KISFALUBA j.d.o.o.</div>
        <p>Poštovani/a ${escapeHtml(supplierName)},</p>
        <p>Obavještavamo Vas o povratu robe vezano za Vaš račun br. ${escapeHtml(originalInvoiceNumber)}.</p>

        <div class="subtitle">STORNO RAČUN / POVRATNICA</div>
        <div class="line"></div>

        <div class="meta">
          <div class="meta-row"><div class="meta-label">Broj storno računa:</div><div class="meta-value">${escapeHtml(stornoInvoiceNumber)}</div></div>
          <div class="meta-row"><div class="meta-label">Vezano za račun br.:</div><div class="meta-value">${escapeHtml(originalInvoiceNumber)}</div></div>
          <div class="meta-row"><div class="meta-label">Datum storna:</div><div class="meta-value">${escapeHtml(dateStr)}</div></div>
          <div class="meta-row"><div class="meta-label">Vrijeme storna:</div><div class="meta-value">${escapeHtml(timeStr)}</div></div>
          <div class="meta-row"><div class="meta-label">Mjesto izdavanja:</div><div class="meta-value">Branjina, Republika Hrvatska</div></div>
          <div class="meta-row"><div class="meta-label">Dobavljač:</div><div class="meta-value">${escapeHtml(supplierName)}</div></div>
        </div>

        <table>
          <thead>
            <tr>
              <th class="center">Redni broj</th>
              <th>Opis</th>
              <th class="center">Količina</th>
              <th class="right">Jedinična cijena (EUR)</th>
              <th class="right">Ukupno (EUR)</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td class="center">1</td>
              <td>Povrat po računu br. ${escapeHtml(originalInvoiceNumber)}</td>
              <td class="center">1</td>
              <td class="right">${negativePrice}</td>
              <td class="right">${negativePrice}</td>
            </tr>
          </tbody>
        </table>

        <div class="total">Ukupan iznos storna: ${negativePrice} EUR</div>
        ${note ? `<div class="note"><strong>Napomena:</strong> ${escapeHtml(note)}</div>` : ''}
        <div class="note">Ovaj dokument služi isključivo kao dokaz o fizičkom povratu robe dobavljaču.</div>
        <div class="note">Originalni račun ostaje sačuvan, a ovaj storno račun vrijedi bez potpisa i pečata.</div>
      </div>
    </body>
  </html>`;

  await renderInboundPdfFromHtml(html, filePath);
  return filePath;
};

// --- WEBHOOK (STRIPE - KARTICE) ---
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook greška potpisivanja:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.client_reference_id || session.metadata?.orderId || null;
    const sessionId = session.id || null;

    if (orderId || sessionId) {
      try {
        let existingOrderResult;

        if (orderId) {
          existingOrderResult = await pool.query(
            'SELECT * FROM orders WHERE id = $1 LIMIT 1',
            [orderId]
          );
        } else {
          existingOrderResult = await pool.query(
            'SELECT * FROM orders WHERE stripe_session_id = $1 LIMIT 1',
            [sessionId]
          );
        }

        const existingOrder = existingOrderResult.rows[0];
        if (!existingOrder) {
          console.error('Stripe webhook: narudžba nije pronađena.', { orderId, sessionId });
          return res.json({ received: true });
        }

        const updateResult = await pool.query(
          "UPDATE orders SET status = 'PAID', stripe_session_id = COALESCE($2, stripe_session_id), paid_at = COALESCE(paid_at, NOW()) WHERE id = $1 RETURNING *",
          [existingOrder.id, sessionId]
        );
        const updatedOrder = updateResult.rows[0];
        const isFirstPaidTransition = existingOrder.status !== 'PAID';
        const shouldFinalizeOrder = isFirstPaidTransition || !existingOrder.invoice_url;

        if (updatedOrder && isFirstPaidTransition) {
          await deductStock(parseJsonSafe(updatedOrder.items, []));
        }

        if (updatedOrder && shouldFinalizeOrder) {
          await enqueueSoloJob({ type: 'order', orderId: existingOrder.id });
        }

        req.app.get('io').emit('nova_narudzba', { id: existingOrder.id, name: updatedOrder.name });
      } catch (dbErr) {
        console.error('Greška pri ažuriranju baze:', dbErr);
      }
    }
  }
  res.json({ received: true });
});

app.use(express.json());

// --- AUTHENTIKACIJA ---
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 5, 
  message: { error: 'Previše neuspješnih pokušaja prijave. Zbog sigurnosti, pokušajte ponovno za 15 minuta.' }
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const { password } = req.body;
  const isMatch = await bcrypt.compare(password, process.env.ADMIN_HASH);

  if (isMatch) {
    const token = jwt.sign({ role: 'admin' }, process.env.INVOICE_SECRET, { expiresIn: '12h' });
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: 'Pogrešna lozinka!' });
  }
});

const authGuard = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Pristup odbijen. Nema tokena.' });

  jwt.verify(token, process.env.INVOICE_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Vaš token je istekao ili je nevažeći. Prijavite se ponovno.' });
    req.user = user;
    next(); 
  });
};

app.post('/api/blagajna/invoice', authGuard, async (req, res) => {
  try {
    const orderData = buildBlagajnaOrderData(req.body);
    const items = parseJsonSafe(orderData.items, []);
    const isR1Customer = Boolean(orderData.companyName && orderData.oib);

    if (items.length === 0) {
      return res.status(400).json({ error: 'Blagajna mora imati barem jednu stavku.' });
    }

    if (isR1Customer && !SOLO_DEFAULT_KPD && items.some((item) => !normalizeText(item.kpd))) {
      return res.status(400).json({ error: 'Za R1/B2B račun postavi SOLO_DEFAULT_KPD u .env ili pošalji kpd po stavci.' });
    }

    const queueResult = await enqueueSoloJob({
      type: 'blagajna-invoice',
      payload: req.body,
    });

    return res.json(queueResult);
  } catch (err) {
    console.error('Blagajna račun greška:', err.message);
    return res.status(500).json({ error: err.message || 'Greška pri izdavanju računa kroz Blagajnu.' });
  }
});

app.post('/api/blagajna/storno', authGuard, async (req, res) => {
  try {
    const orderData = buildBlagajnaOrderData(req.body);
    const items = parseJsonSafe(orderData.items, []);
    const isR1Customer = Boolean(orderData.companyName && orderData.oib);

    if (items.length === 0) {
      return res.status(400).json({ error: 'Blagajna storno mora imati barem jednu stavku.' });
    }

    if (isR1Customer && !SOLO_DEFAULT_KPD && items.some((item) => !normalizeText(item.kpd))) {
      return res.status(400).json({ error: 'Za R1/B2B storno postavi SOLO_DEFAULT_KPD u .env ili pošalji kpd po stavci.' });
    }

    const queueResult = await enqueueSoloJob({
      type: 'blagajna-storno',
      payload: req.body,
    });

    return res.json(queueResult);
  } catch (err) {
    console.error('Blagajna storno greška:', err.message);
    return res.status(500).json({ error: err.message || 'Greška pri izradi storna kroz Blagajnu.' });
  }
});

// --- STRIPE CHECKOUT ---
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, customer, isApp, discount, shippingPrice } = req.body; 
    const normalizedItems = parseJsonSafe(items, []);

    if (normalizedItems.length === 0) {
      return res.status(400).json({ error: 'Košarica je prazna.' });
    }

    const itemIds = normalizedItems.map(item => String(item.id));
    const dbProductsResult = await pool.query('SELECT id, price FROM products WHERE id = ANY($1)', [itemIds]);
    
    const dbPrices = {};
    dbProductsResult.rows.forEach(row => {
      dbPrices[row.id] = Number(row.price);
    });

    let safeSubtotal = 0;
    const validatedItems = normalizedItems.map(item => {
      const realPrice = dbPrices[item.id] || 0;
      const qty = toNumberSafe(item.qty || item.quantity || 1);
      safeSubtotal += realPrice * qty;
      return { ...item, price: realPrice, qty };
    });

    const safeShipping = toNumberSafe(shippingPrice || 0); 
    const safeDiscount = discount && discount.amount ? toNumberSafe(discount.amount) : 0;

    let totalAmount = safeSubtotal + safeShipping - safeDiscount;
    if (totalAmount < 0) totalAmount = 0;

    const totalInCents = Math.round(totalAmount * 100);

    const address = customer.address || `${customer.street}, ${customer.postalCode} ${customer.city}, ${customer.country}`; 
    const name = `${customer.firstName} ${customer.lastName}`;
    const companyName = normalizeText(customer.companyName);
    const oib = normalizeText(customer.oib);
    const isR1Customer = Boolean(companyName && oib);

    if (isR1Customer && !SOLO_DEFAULT_KPD) {
      return res.status(400).json({ error: 'R1/B2B račun traži SOLO_DEFAULT_KPD u backend .env postavkama.' });
    }
    
    const newOrder = await pool.query(
      'INSERT INTO orders (name, address, phone, email, total, items, status, discount, company_name, company_oib) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
      [name, address, customer.phone || '', customer.email || '', totalAmount, JSON.stringify(validatedItems), 'NEW', JSON.stringify(discount || { amount: 0 }), companyName || '', oib || '']
    );
    const orderId = newOrder.rows[0].id;
    const successUrl = isApp ? `${req.protocol}://${req.get('host')}/payment-success?app=true` : `${req.protocol}://${req.get('host')}/payment-success`;
    const cancelUrl = isApp ? `${req.protocol}://${req.get('host')}/payment-cancel?app=true` : `${req.protocol}://${req.get('host')}/payment-cancel`;
    const successUrlObj = new URL(req.body.returnUrl ? req.body.returnUrl : successUrl);
    successUrlObj.searchParams.set('orderId', String(orderId));
    const successRedirectUrl = successUrlObj.toString();
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      client_reference_id: String(orderId),
      metadata: {
        orderId: String(orderId),
        companyName,
        oib,
      },
      customer_email: customer.email || undefined,
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: 'Kišfaluba narudžba', description: `Kupac: ${name}` },
          unit_amount: totalInCents,
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: successRedirectUrl,
      cancel_url: req.body.returnUrl ? req.body.returnUrl.replace('payment-success', 'payment-cancel') : cancelUrl,
    });

    await pool.query(
      'UPDATE orders SET stripe_session_id = $1 WHERE id = $2',
      [session.id, orderId]
    );
    
    res.json({ url: session.url, orderId: String(orderId) });
  } catch (err) {
    console.error('Stripe greška:', err.message);
    res.status(500).json({ error: 'Greška pri povezivanju sa Stripeom.' });
  }
});

// --- RUTE ZA ULAZNE RAČUNE (URA) ---
app.post('/inbound-invoices/fetch-email', authGuard, async (req, res) => {
  console.log("Ručno pokrenuta provjera mailova...");
  await fetchInboundInvoicesFromEmail();
  res.json({ success: true, message: 'Provjera pošte završena.' });
});

app.get('/inbound-invoices', authGuard, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM inbound_invoices ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: "Greška servera" }); }
});

app.post('/inbound-invoices', async (req, res) => {
  const { supplier, supplier_email, invoice_number, amount, file_url, note, date } = req.body;
  try {
    const cleanSupplier = cleanInboundUtfText(supplier);
    const cleanSupplierEmail = cleanInboundUtfText(supplier_email || '');
    const cleanInvoiceNumber = cleanInboundUtfText(invoice_number);
    const cleanNote = cleanInboundUtfText(note, { preserveWhitespace: true });
    const normalizedAmount = toNumberSafe(amount);

    const result = await pool.query(
      "INSERT INTO inbound_invoices (supplier, supplier_email, invoice_number, amount, file_url, note, date, status, archived) VALUES ($1, $2, $3, $4, $5, $6, $7, 'DOLAZNI', false) RETURNING *",
      [cleanSupplier, cleanSupplierEmail, cleanInvoiceNumber, normalizedAmount, file_url, cleanNote, date]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: "Greška u bazi." }); }
});

app.patch('/inbound-invoices/:id/status', authGuard, async (req, res) => {
  try {
    const { status } = req.body;
    const id = String(req.params.id).split('-')[0];
    const targetStatus = (status === 'POVRATI' || status === 'STORNO' || status === 'POVRAT ROBE') ? 'POVRATI' : status;
    const currentResult = await pool.query('SELECT * FROM inbound_invoices WHERE id = $1', [id]);

    if (currentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Račun nije pronađen.' });
    }

    const currentInvoice = currentResult.rows[0];

    if (targetStatus === 'POVRATI') {
      if (currentInvoice.original_invoice_id) {
        const stornoResult = await pool.query(
          "UPDATE inbound_invoices SET status = 'POVRATI', archived = false WHERE id = $1 RETURNING *",
          [id]
        );
        return res.json({ success: true, invoice: stornoResult.rows[0] });
      }

      const originalAmount = parseInboundInvoiceAmount(currentInvoice.amount);
      if (originalAmount === null) {
        return res.status(400).json({ error: 'Originalni ulazni račun nema ispravan iznos za storno. Provjeri amount prije povrata.' });
      }

      const originalInvoice = { ...currentInvoice, amount: originalAmount };
      const stornoUrl = await ensureInboundStornoPdf(originalInvoice);
      const archivedOriginalResult = await pool.query(
        "UPDATE inbound_invoices SET storno_url = $1, status = 'ARHIVIRANI', archived = true WHERE id = $2 RETURNING *",
        [stornoUrl, id]
      );
      const archivedOriginal = { ...archivedOriginalResult.rows[0], amount: originalAmount };
      const stornoInvoice = await createOrRefreshInboundStornoRecord(archivedOriginal, stornoUrl, originalAmount);

      return res.json({
        success: true,
        invoice: archivedOriginal,
        stornoInvoice
      });
    }

    let query = 'UPDATE inbound_invoices SET status = $1 WHERE id = $2 RETURNING *';

    if (targetStatus === 'ARHIVIRANI' || targetStatus === 'STORNO ARHIVA') {
      query = 'UPDATE inbound_invoices SET status = $1, archived = true WHERE id = $2 RETURNING *';
    }

    const result = await pool.query(query, [targetStatus, id]);
    res.json({ success: true, invoice: result.rows[0] });
  } catch (err) {
    console.error("Greška pri ažuriranju statusa:", err);
    res.status(500).json({ error: err.message || 'Greška u bazi.' });
  }
});

app.post('/inbound-invoices/archive', authGuard, async (req, res) => {
  try {
    const { invoiceIds } = req.body;
    if (!invoiceIds || !Array.isArray(invoiceIds) || invoiceIds.length === 0) {
      return res.json({ success: true, message: 'Nema računa za arhiviranje.' });
    }
    
    const cleanIds = invoiceIds.map(id => parseInt(String(id).split('-')[0], 10)).filter(id => !isNaN(id));
    if (cleanIds.length === 0) return res.json({ success: true });

    await pool.query('UPDATE inbound_invoices SET archived = true WHERE id = ANY($1::int[])', [cleanIds]);
    res.json({ success: true, message: 'Računi su uspješno arhivirani.' });
  } catch (err) { 
    console.error("Greška pri arhiviranju URA:", err);
    res.status(500).json({ error: 'Greška u bazi.' }); 
  }
});

app.delete('/inbound-invoices/:id', authGuard, async (req, res) => {
  try {
    const id = String(req.params.id).split('-')[0];
    await pool.query('DELETE FROM inbound_invoices WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Greška pri brisanju' }); }
});

app.patch('/inbound-invoices/:id/file', authGuard, async (req, res) => {
  try {
    const id = String(req.params.id).split('-')[0];
    const { fileUrl } = req.body;
    await pool.query('UPDATE inbound_invoices SET file_url = $1 WHERE id = $2', [fileUrl, id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Greška u bazi.' }); }
});

app.post('/api/send-ura-storno', authGuard, async (req, res) => {
  const { id, supplierEmail } = req.body;
  try {
    const cleanId = String(id).split('-')[0];
    const result = await pool.query('SELECT * FROM inbound_invoices WHERE id = $1', [cleanId]);
    if (result.rows.length === 0) return res.status(404).json({error: 'Nema računa'});
    const currentInvoice = result.rows[0];

    let inv = currentInvoice;
    if (!currentInvoice.original_invoice_id) {
      const stornoResult = await pool.query(
        'SELECT * FROM inbound_invoices WHERE original_invoice_id = $1 ORDER BY id DESC LIMIT 1',
        [currentInvoice.id]
      );
      if (stornoResult.rows.length > 0) {
        inv = stornoResult.rows[0];
      }
    }

    const originalInvoice = inv.original_invoice_id
      ? (await pool.query('SELECT * FROM inbound_invoices WHERE id = $1', [inv.original_invoice_id])).rows[0] || currentInvoice
      : currentInvoice;

    const pdfLink = inv.file_url || inv.storno_url || originalInvoice.storno_url || originalInvoice.file_url;
    if (!pdfLink) return res.status(400).json({ error: 'Nema PDF dokumenta. Prvo storniraj račun!' });

    const finalEmail = (originalInvoice.supplier_email && originalInvoice.supplier_email.includes('@'))
      ? originalInvoice.supplier_email
      : ((inv.supplier_email && inv.supplier_email.includes('@')) ? inv.supplier_email : supplierEmail);

    if (finalEmail && finalEmail.includes('@')) {
      let siguranBroj = inv.invoice_number ? String(inv.invoice_number).trim() : `URA-${inv.id}`;
      const stornoNumber = siguranBroj.toUpperCase().includes('STORNO') ? siguranBroj : `STORNO-${siguranBroj}`;

      await transporter.sendMail({
        from: `"KIŠFALUBA j.d.o.o." <${process.env.EMAIL_USER}>`,
        to: finalEmail,
        subject: `Storno / Povratnica - ${stornoNumber}`,
        html: `<div style="font-family: Arial; padding: 20px;"><h2>OBAVIJEST O POVRATU</h2><p>Poštovani,</p><p>U privitku Vam dostavljamo službeni storno dokument za povrat robe.</p></div>`,
        attachments: [
          {
            filename: `${stornoNumber}.pdf`,
            path: pdfLink
          }
        ]
      });
    }
    res.json({ success: true, message: 'Storno mail je uspješno poslan dobavljaču s privitkom!', fileUrl: pdfLink });
  } catch (error) { 
    console.error("Greška pri slanju storno maila dobavljaču:", error);
    res.status(500).json({ error: 'Greška servera pri slanju e-maila.' }); 
  }
});

// --- RUTE ZA PROIZVODE ---
app.get('/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY id DESC');
    res.json(result.rows.map(p => ({
      ...p,
      images: parseJsonSafe(p.images, []),
      variants: parseJsonSafe(p.variants, [])
    })));
  } catch (err) { res.status(500).json({ error: 'Greška servera' }); }
});

app.post('/products', authGuard, async (req, res) => {
  try {
    const { brand, name, description, price, cost_price, category, images, variants, fit_info, material_info, manufacturer_info, sustainability_info, supplier_email } = req.body;
    const result = await pool.query(
      'INSERT INTO products (brand, name, description, price, cost_price, category, images, variants, fit_info, material_info, manufacturer_info, sustainability_info, supplier_email) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *',
      [brand || '', name || '', description || '', toNumberSafe(price), toNumberSafe(cost_price || 0), category || '', JSON.stringify(images || []), JSON.stringify(variants || []), fit_info || '', material_info || '', manufacturer_info || '', sustainability_info || '', supplier_email || '']
    );
    const saved = result.rows[0];
    saved.images = parseJsonSafe(saved.images, []);
    saved.variants = parseJsonSafe(saved.variants, []);
    res.json(saved);
  } catch (err) { res.status(500).json({ error: 'Greška servera' }); }
});

app.put('/products/:id', authGuard, async (req, res) => {
  try {
    const { id } = req.params;
    const { brand, name, description, price, cost_price, category, images, variants, fit_info, material_info, manufacturer_info, sustainability_info, supplier_email } = req.body;
    const result = await pool.query(
      'UPDATE products SET brand = $1, name = $2, description = $3, price = $4, cost_price = $5, category = $6, images = $7, variants = $8, fit_info = $9, material_info = $10, manufacturer_info = $11, sustainability_info = $12, supplier_email = $13 WHERE id = $14 RETURNING *',
      [brand || '', name || '', description || '', toNumberSafe(price), toNumberSafe(cost_price || 0), category || '', JSON.stringify(images || []), JSON.stringify(variants || []), fit_info || '', material_info || '', manufacturer_info || '', sustainability_info || '', supplier_email || '', id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Proizvod nije pronađen' });
    const saved = result.rows[0];
    saved.images = parseJsonSafe(saved.images, []);
    saved.variants = parseJsonSafe(saved.variants, []);
    res.json(saved);
  } catch (err) { res.status(500).json({ error: 'Greška servera' }); }
});

app.delete('/products/:id', authGuard, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM products WHERE id = $1', [id]);
    res.json({ success: true, message: 'Proizvod uspješno obrisan' });
  } catch (err) {
    console.error('Greška pri brisanju:', err);
    res.status(500).json({ error: 'Greška servera pri brisanju' });
  }
});

app.post('/upload', authGuard, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nema fajla za upload' });
  res.json({ imageUrl: req.file.path });
});

// --- UPLOAD PDF RAČUNA ZA NARUDŽBE (RUČNO DODAVANJE) ---
app.post('/upload-invoice', authGuard, upload.single('invoice'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nema datoteke za upload' });
  }
  
  const orderId = req.body.orderId;
  if (!orderId) {
    return res.status(400).json({ error: 'Nedostaje ID narudžbe' });
  }

  try {
    // req.file.path sadrži sigurni Cloudinary link nakon uploada
    const pdfUrl = req.file.path;
    
    // Spremi link u bazu pod tu narudžbu
    await pool.query('UPDATE orders SET invoice_url = $1 WHERE id = $2', [pdfUrl, orderId]);
    
    res.json({ success: true, invoiceUrl: pdfUrl });
  } catch (err) {
    console.error('Greška pri spremanju računa u bazu:', err);
    res.status(500).json({ error: 'Greška baze podataka' });
  }
});
// --- RUTE ZA NARUDŽBE ---
app.get('/all-orders', authGuard, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY id DESC');
    res.json(result.rows.map(o => ({ 
      ...o, 
      items: parseJsonSafe(o.items, []), 
      invoiceUrl: o.invoice_url,
      storno_url: o.storno_url,
      createdAt: o.created_at, 
      archived: o.archived 
    })));
  } catch (err) { res.status(500).json({ error: 'Greška servera' }); }
});

app.get('/orders', authGuard, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY id DESC');
    res.json(result.rows.map(o => ({ ...o, items: parseJsonSafe(o.items, []), })));
  } catch (err) { res.status(500).json({ error: 'Greška' }); }
});

app.get('/orders/:id/payment-status', async (req, res) => {
  try {
    const orderId = String(req.params.id).split('-')[0];
    const result = await pool.query(
      'SELECT id, status, invoice_url, paid_at FROM orders WHERE id = $1 LIMIT 1',
      [orderId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Narudžba nije pronađena.' });
    }

    const order = result.rows[0];
    res.json({
      id: order.id,
      status: order.status,
      invoiceUrl: order.invoice_url,
      paidAt: order.paid_at,
      isPaid: order.status === 'PAID'
    });
  } catch (err) {
    res.status(500).json({ error: 'Greška servera' });
  }
});

// --- POUZEĆE ---
app.post('/orders', async (req, res) => {
  try {
    const { name, address, phone, total, items, email, discount, companyName, oib } = req.body; 
    const normalizedItems = parseJsonSafe(items, []);
    const totalAmount = Number((Number.isFinite(Number(total)) ? Number(total) : calcTotals(normalizedItems)).toFixed(2));

    if (companyName && oib && !SOLO_DEFAULT_KPD) {
      return res.status(400).json({ error: 'R1/B2B račun traži SOLO_DEFAULT_KPD u backend .env postavkama.' });
    }
    
    const newOrder = await pool.query(
      'INSERT INTO orders (name, address, phone, email, total, items, status, discount, company_name, company_oib) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
      [name || 'Nepoznat', address || '', phone || '', email || '', totalAmount, JSON.stringify(normalizedItems), 'NEW', JSON.stringify(discount || { amount: 0 }), companyName || '', oib || '']
    );
    
    const orderData = newOrder.rows[0];
    const orderId = orderData.id;
    await deductStock(normalizedItems);
    
    const soloRacun = await createSoloInvoice({ ...orderData, companyName, oib }, false);
    const invoiceUrl = soloRacun ? soloRacun.pdf : null;
    const invoiceNumber = soloRacun ? soloRacun.broj_racuna : invoiceNumberFromOrderId(orderId);
    
    await pool.query('UPDATE orders SET invoice_url = $1 WHERE id = $2', [invoiceUrl, orderId]);
    
if (email && invoiceUrl) {
      await transporter.sendMail({
        from: `"KIŠFALUBA j.d.o.o." <${process.env.EMAIL_USER}>`,
        to: email,
        bcc: process.env.EMAIL_USER, // <-- TEBI STIŽE SKRIVENA KOPIJA!
        subject: `Potvrda narudžbe i račun br. ${invoiceNumber}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eee; text-align: center;">
            <h2 style="color: #000;">Vaša narudžba je zaprimljena!</h2>
            <p>Odabrali ste plaćanje <strong>pouzećem</strong>.</p>
            <p>Vaš službeni fiskalizirani račun nalazi se u <strong>privitku ovog e-maila</strong>, a možete ga preuzeti i na linku ispod:</p>
            <div style="margin: 30px 0;">
              <a href="${invoiceUrl}" style="background-color: #D4AF37; color: black; padding: 15px 25px; text-decoration: none; font-weight: bold; border-radius: 5px; display: inline-block;">PREUZMI PDF RAČUN</a>
            </div>
            <p style="font-size: 11px; color: #777;">Račun je izdan automatski i fiskaliziran.</p>
          </div>
        `,
        attachments: [
          {
            filename: `Racun_Kisfaluba_${invoiceNumber.replace(/\//g, '_')}.pdf`,
            path: invoiceUrl
          }
        ]
      }).catch(e => console.error('X Greška slanja računa:', e));
    }
    
   sendPackingSlipsToSuppliers(orderData, normalizedItems).catch(e => console.error("X Greška dobavljači:", e));
    
    req.app.get('io').emit('nova_narudzba', { id: orderId, name: orderData.name });
    
    res.json({ message: 'Narudžba uspješna!', order: orderData });
  } catch (err) { 
    console.error('Greška u orders ruti:', err);
    res.status(500).json({ error: 'Greška pri spremanju narudžbe.' }); 
  }
});

app.post('/orders/archive', authGuard, async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) return res.json({ success: true, message: 'Nema narudžbi.' });
    
    const cleanIds = orderIds.map(id => parseInt(String(id).split('-')[0], 10)).filter(id => !isNaN(id));
    if(cleanIds.length === 0) return res.json({ success: true });

    await pool.query('UPDATE orders SET archived = true WHERE id = ANY($1::int[])', [cleanIds]);
    res.json({ success: true, message: 'Arhivirano.' });
  } catch (err) { res.status(500).json({ error: 'Greška u bazi.' }); }
});

app.delete('/orders/:id', authGuard, async (req, res) => {
  try {
    const id = String(req.params.id).split('-')[0];
    await pool.query('DELETE FROM orders WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Greška u bazi.' }); }
});

app.patch('/orders/:id/status', authGuard, async (req, res) => {
  try {
    const { status } = req.body;
    const orderId = String(req.params.id).split('-')[0];

    let query = 'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *';
    
    if (status === 'COMPLETED') {
        query = 'UPDATE orders SET status = $1, archived = true WHERE id = $2 RETURNING *';
    } else if (status === 'REFUND') {
        query = 'UPDATE orders SET status = $1, archived = false WHERE id = $2 RETURNING *';
    }

    const result = await pool.query(query, [status, orderId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Narudžba nije pronađena.' });
    }
    
    const orderData = result.rows[0];

if (status === 'REFUND') {
      const soloStorno = await createSoloInvoice(orderData, true, true);
      
      if (soloStorno && soloStorno.pdf) {
        const stornoUrl = soloStorno.pdf;
        await pool.query('UPDATE orders SET storno_url = $1, archived = false WHERE id = $2', [stornoUrl, orderId]);
        orderData.storno_url = stornoUrl;
        orderData.archived = false;
      } else {
        console.error(`Solo.hr je odbio storno za narudžbu ${orderId}. Nećemo kreirati krivi link.`);
        return res.status(500).json({ error: 'Solo.hr je odbio kreirati storno. Provjerite u Render Logovima zašto.' });
      }
    }

    res.json({ success: true, order: orderData });
  } catch (err) {
    console.error("Greška pri ažuriranju statusa narudžbe:", err);
    res.status(500).json({ error: 'Greška u bazi.' });
  }
});

app.post('/orders/:id/send-storno', authGuard, async (req, res) => {
  try {
    const orderId = String(req.params.id).split('-')[0];
    const result = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Narudžba nije pronađena.' });
    }
    
    const orderData = result.rows[0];
    if (!orderData.email) return res.status(400).json({ error: 'Kupac nema unesenu email adresu.' });

    const pdfLinkZaKupca = orderData.storno_url; // BEZ FALLBACKA NA ORIGINALNI RAČUN!
    if (!pdfLinkZaKupca) return res.status(400).json({ error: 'Storno račun još nije generiran! Solo.hr ga je odbio ili niste stisnuli Povrat.' });

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; color: #333; line-height: 1.5; border: 1px solid #eee; border-radius: 5px;">
        <h2 style="text-align: center; color: #e53e3e; margin-bottom: 20px;">STORNO RAČUN - KISFALUBA</h2>
        <p>Poštovani/a <b>${escapeHtml(orderData.name)}</b>,</p>
        <p>Obavještavamo Vas da smo uspješno obradili Vaš povrat robe/sredstava.</p>
        <p>U nastavku se nalazi poveznica na Vaš službeni Storno račun.</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${pdfLinkZaKupca}" style="background-color: #e53e3e; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px; font-weight: bold;">PREUZMI STORNO RAČUN</a>
        </div>
        <p style="font-size: 12px; color: #666; margin-top: 30px;">Srdačan pozdrav,<br>Vaš Kišfaluba tim</p>
      </div>
    `;

await transporter.sendMail({
      from: `"KIŠFALUBA j.d.o.o." <${process.env.EMAIL_USER}>`,
      to: orderData.email,
      bcc: process.env.EMAIL_USER, // <-- TEBI STIŽE SKRIVENA KOPIJA STORNA!
      subject: `Storno račun i obavijest o povratu - KISFALUBA`,
      html: emailHtml,
      attachments: [
        {
          filename: `Storno_Racun_Kisfaluba_${orderId}.pdf`,
          path: pdfLinkZaKupca
        }
      ]
    });

    res.json({ success: true, message: 'Storno mail uspješno poslan kupcu!' });
  } catch (err) {
    console.error("Greška pri slanju storno maila:", err);
    res.status(500).json({ error: 'Greška pri slanju maila.' });
  }
});

app.patch('/orders/:id/invoice', authGuard, async (req, res) => {
  try {
    const id = String(req.params.id).split('-')[0];
    await pool.query('UPDATE orders SET invoice_url = $1 WHERE id = $2', [req.body.invoiceUrl, id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Greška.' }); }
});

app.get('/orders/:id/invoice', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).send('Nije pronađeno.');
    const orderData = result.rows[0];
    
    if (orderData.invoice_url && orderData.invoice_url.startsWith('http')) {
        return res.redirect(orderData.invoice_url);
    }
    
    res.send('<h1 style="text-align:center; margin-top:50px;">Račun se generira...</h1><p style="text-align:center;">Molimo osvježite stranicu za nekoliko trenutaka.</p>');
  } catch (err) { res.status(500).send('Greška.'); }
});

// --- RUTE ZA POSTAVKE I KATEGORIJE ---
app.get('/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM shop_settings LIMIT 1');
    const settings = result.rows[0] || { cod_enabled: true };
    let heroSlides = [];

    try {
      const parsedHero = JSON.parse(settings.hero_img || '[]');
      heroSlides = normalizeHeroSlides(parsedHero);
    } catch (err) {
      heroSlides = buildLegacyHeroSlides(settings);
    }

    res.json({
      ...settings,
      hero_slides: heroSlides,
    });
  } catch (err) { res.status(500).json({ error: 'Greška postavki' }); }
});

app.post('/settings/cod', authGuard, async (req, res) => {
  try {
    const result = await pool.query('UPDATE shop_settings SET cod_enabled = $1 RETURNING *', [req.body.cod_enabled]);
    res.json({ message: 'Postavke ažurirane!', settings: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Greška ažuriranja' }); }
});

app.post('/settings/hero', authGuard, async (req, res) => {
  try {
    const heroSlides = normalizeHeroSlides(req.body?.slides);
    const heroImg = JSON.stringify(heroSlides);
    const primarySlide = heroSlides[0] || null;
    const check = await pool.query('SELECT * FROM shop_settings LIMIT 1');
    if (check.rows.length === 0) {
      await pool.query('INSERT INTO shop_settings (cod_enabled, hero_title, hero_sub, hero_img) VALUES (true, $1, $2, $3)', [primarySlide?.title || '', primarySlide?.sub || '', heroImg]);
    } else {
      await pool.query('UPDATE shop_settings SET hero_title = $1, hero_sub = $2, hero_img = $3', [primarySlide?.title || '', primarySlide?.sub || '', heroImg]);
    }
    res.json({ message: 'Ažurirano!', hero_slides: heroSlides });
  } catch (err) { res.status(500).json({ error: 'Greška.' }); }
});

app.post('/settings/coupons', authGuard, async (req, res) => {
  try {
    const { coupons } = req.body;
    const check = await pool.query('SELECT * FROM shop_settings LIMIT 1');
    if (check.rows.length === 0) {
      await pool.query('INSERT INTO shop_settings (cod_enabled, coupons) VALUES (true, $1)', [JSON.stringify(coupons || [])]);
    } else {
      await pool.query('UPDATE shop_settings SET coupons = $1', [JSON.stringify(coupons || [])]);
    }
    res.json({ message: 'Kuponi ažurirani!' });
  } catch (err) {
    console.error('Greška pri spremanju kupona:', err);
    res.status(500).json({ error: 'Greška.' });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM categories ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Greška pri dohvaćanju kategorija:', err);
    res.status(500).json({ error: 'Greška na serveru' });
  }
});

app.post('/api/categories', authGuard, async (req, res) => {
  const { id, name } = req.body;
  try {
    await pool.query('INSERT INTO categories (id, name) VALUES ($1, $2)', [id, name]);
    res.json({ success: true, message: 'Kategorija dodana' });
  } catch (err) {
    console.error('Greška pri spremanju kategorije:', err);
    res.status(500).json({ error: 'Greška na serveru' });
  }
});

app.delete('/api/categories/:id', authGuard, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM categories WHERE id = $1', [id]);
    res.json({ success: true, message: 'Kategorija obrisana' });
  } catch (err) {
    console.error('Greška pri brisanju kategorije:', err);
    res.status(500).json({ error: 'Greška na serveru' });
  }
});

// --- STATIC I PAYMENT RUTE ---
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/racun/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, 'uploads', filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('Račun nije pronaden.');
    res.sendFile(filePath);
  } catch (error) { res.status(500).send('Greška na serveru.'); }
});

app.get('/payment-success', (req, res) => {
  const isApp = req.query.app === 'true';
  res.send(`<!DOCTYPE html><html lang="hr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Uspješna kupnja KISFALUBA</title><style>body { margin: 0; padding: 0; background-color: #050505; background-image: url('https://images.unsplash.com/photo-1490481651871-ab68de25d43d?q=80&w=2070&auto=format&fit=crop'); background-size: cover; background-position: center; background-attachment: fixed; height: 100vh; display: flex; justify-content: center; align-items: center; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; text-align: center; }.overlay {position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.80); z-index: 1;} .content { position: relative; z-index: 2; background: rgba(15, 15, 15, 0.65); padding: 50px 40px; border-radius: 12px; border: 1px solid #D4AF37; box-shadow: 0 15px 40px rgba(0,0,0,0.8); max-width: 480px; width: 85%; backdrop-filter: blur(8px); } h1 { color: #D4AF37; font-size: 26px; margin-bottom: 15px; text-transform: uppercase; letter-spacing: 2px; text-shadow: 0 2px 4px rgba(0,0,0,0.8); } p { color: #e0e0e0; font-size: 15px; line-height: 1.6; margin-bottom: 35px; } .gold-line { width: 60px; height: 2px; background: #D4AF37; margin: 0 auto 20px auto; border-radius: 2px; } .btn { display: inline-block; background: linear-gradient(135deg, #E5C058 0%, #B8860B 100%); color: #000; text-decoration: none; padding: 16px 35px; font-size: 15px; font-weight: bold; border-radius: 4px; text-transform: uppercase; border: none; cursor: pointer; transition: all 0.3s ease; box-shadow: 0 4px 15px rgba(212, 175, 55, 0.2); } .btn:hover { transform: translateY(-3px); box-shadow: 0 6px 20px rgba(212, 175, 55, 0.4); } .icon { font-size: 45px; margin-bottom: 10px; text-shadow: 0 0 15px rgba(212, 175, 55, 0.5); }</style></head><body><div class="overlay"></div><div class="content"><div class="icon"></div><h1>Uspješna kupnja</h1><div class="gold-line"></div><p>Zahvaljujemo Vam na povjerenju.<br>Vaša transakcija je provedena stručno i profesionalno.<br><br>Svi detalji narudžbe te elektronički račun uspješno su poslani na Vašu e-mail adresu.</p><button class="btn" onclick="goBack()">POVRATAK U TRGOVINU</button></div><script>if (${isApp}) { setTimeout(function() { window.location.replace(${JSON.stringify(PAYMENT_SUCCESS_APP_URL)}); setTimeout(function(){ window.close(); }, 300); }, 3000); } function goBack() { if (${isApp}) { window.location.replace(${JSON.stringify(PAYMENT_SUCCESS_APP_URL)}); setTimeout(function(){ window.close(); }, 300); } else { window.location.href = ${JSON.stringify(PAYMENT_SUCCESS_WEB_URL)}; } }</script></body></html>`);
});

app.get('/payment-cancel', (req, res) => {
  const isApp = req.query.app === 'true';
  res.send(`<!DOCTYPE html><html lang="hr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Kupnja prekinuta KISFALUBA</title><style>body { margin: 0; background-color: #0a0a0a; height: 100vh; display: flex; justify-content: center; align-items: center; font-family: 'Helvetica Neue', sans-serif; text-align: center; color: #fff;} .content { background: #151515; padding: 40px; border-radius: 8px; border: 1px solid #333; max-width: 400px; width: 85%; } h1 { color: #aaa; font-size: 20px; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 1px;} p { color: #777; font-size: 15px; margin-bottom: 25px; line-height: 1.5;} .btn { background: #2a2a2a; color: #fff; padding: 14px 30px; border-radius: 4px; text-transform: uppercase; font-size: 13px; font-weight: bold; border: none; cursor: pointer; transition: 0.3s; } .btn:hover { background: #444; }</style></head><body><div class="content"><h1>Kupnja prekinuta</h1><p>Postupak plaćanja je otkazan. Bez brige, Vaša košarica je ostala sačuvana.</p><button class="btn" onclick="goBack()">NAZAD U TRGOVINU</button></div><script>function goBack() { if (${isApp}) { window.location.replace(${JSON.stringify(PAYMENT_CANCEL_APP_URL)}); setTimeout(function(){ window.close(); }, 300); } else { window.location.href = ${JSON.stringify(PAYMENT_CANCEL_WEB_URL)}; } }</script></body></html>`);
});

app.get('/', (req, res) => res.send('KISFALUBA Backend Online!'));

// --- RUTE ZA PRIGOVORE ---

app.get('/api/complaints', authGuard, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM complaints ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error('Greška prigovori GET:', err);
    res.status(500).json({ error: 'Greška servera' });
  }
});

app.post('/api/complaints', async (req, res) => {
  const { id, fullName, email, phone, orderId, message } = req.body;
  try {
    await pool.query(
      'INSERT INTO complaints (id, full_name, email, phone, order_id, message, status) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [id, fullName, email || '', phone || '', orderId || '', message, 'NEW']
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Greška prigovori POST:', err);
    res.status(500).json({ error: 'Greška pri spremanju prigovora' });
  }
});

app.patch('/api/complaints/:id', authGuard, async (req, res) => {
  const { id } = req.params;
  const { status, adminNote } = req.body;
  try {
    if (status !== undefined) {
      await pool.query('UPDATE complaints SET status = $1 WHERE id = $2', [status, id]);
    }
    if (adminNote !== undefined) {
      await pool.query('UPDATE complaints SET admin_note = $1 WHERE id = $2', [adminNote, id]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Greška prigovori PATCH:', err);
    res.status(500).json({ error: 'Greška pri ažuriranju prigovora' });
  }
});

app.delete('/api/complaints/:id', authGuard, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM complaints WHERE id = $1', [id]);
    res.json({ success: true, message: 'Prigovor obrisan' });
  } catch (err) {
    console.error('Greška pri brisanju prigovora:', err);
    res.status(500).json({ error: 'Greška na serveru' });
  }
});


// FORSIRANJE BAZE DA PRIHVATI DECIMALE (CENTE)
pool.query('ALTER TABLE products ALTER COLUMN price TYPE NUMERIC(10,2)').catch(e => console.log('Price update:', e.message));
pool.query('ALTER TABLE products ALTER COLUMN cost_price TYPE NUMERIC(10,2)').catch(e => console.log('Cost update:', e.message));

server.listen(PORT, '0.0.0.0', () => { 
  console.log(`KISFALUBA SERVER RADI NA PORTU ${PORT}`);
  recoverPendingSoloInvoices().catch((error) => {
    console.error('[SOLO RECOVERY] Neuspješan startup recovery:', error);
  });
});
// PRIVREMENA METLA ZA BRISANJE SVEGA
app.get('/brisanje-baze', async (req, res) => {
  try {
    await pool.query('DELETE FROM orders');
    await pool.query('DELETE FROM inbound_invoices');
    res.send('<h1>Sve narudžbe i ulazni računi su uspješno obrisani! 🧹</h1><p>Sada se vrati u VS Code, OBRISI ovaj kod i ponovno stisni Sync Changes kako ti nitko drugi ne bi mogao obrisati bazu.</p>');
  } catch (err) { 
    res.status(500).send('Greška pri brisanju: ' + err.message); 
  }
});










