const express = require('express');
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
app.use(cors());

// --- KONFIGURACIJA ---
const PORT = process.env.PORT || 10000;
const INVOICE_SECRET = process.env.INVOICE_SECRET;

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
    await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT false");
    await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS storno_url VARCHAR(255)");
    await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount JSONB DEFAULT '{\"amount\": 0}'::jsonb");
    await pool.query("ALTER TABLE shop_settings ADD COLUMN IF NOT EXISTS coupons JSONB DEFAULT '[]'::jsonb");
    await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS fit_info TEXT");
    await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS material_info TEXT");
    await pool.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS manufacturer_info TEXT");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id VARCHAR(255) PRIMARY KEY,
        name VARCHAR(255) NOT NULL
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

const toNumberSafe = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

const fixText = (text) => {
  if (!text) return '';
  return String(text)
    .replace(/č/g, 'c').replace(/Č/g, 'C')
    .replace(/ć/g, 'c').replace(/Ć/g, 'C')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/š/g, 's').replace(/Š/g, 'S')
    .replace(/ž/g, 'z').replace(/Ž/g, 'Z');
};

const invoiceNumberFromOrderId = (orderId) => `${orderId}/${new Date().getFullYear()}/KF`;

const calcTotals = (items) => {
  const sum = parseJsonSafe(items, []).reduce((acc, it) => {
    return acc + toNumberSafe(it.price) * toNumberSafe(it.qty || it.quantity || 1);
  }, 0);
  return Number(sum.toFixed(2));
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

// --- PAMETNI ČITAČ MAILOVA SA SKENEROM ---
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
    console.log('Provjeravam nove račune dobavljača...');
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

        const senderAddress = mail.from && mail.from.value[0] ? mail.from.value[0].address : 'Nepoznato';
        const supplierName = (mail.from && mail.from.value[0].name) ? mail.from.value[0].name : senderAddress;
        
        if (senderAddress.toLowerCase() === process.env.EMAIL_USER.toLowerCase()) continue; 

        const dateStr = new Date().toLocaleDateString('hr-HR');
        const subject = mail.subject || 'Automatski uvoz iz maila';
        
        let extractedAmount = 0;
        const textToSearch = (mail.text || '') + ' ' + (mail.html || '');
        const amountRegex = /(?:ukupno|iznos|total|za platiti|iznos računa)[^\d]*([\d]+[.,]\d{2})/i;
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
          // --- IMA PRILOG (Originalni PDF) ---
          try {
            const attachment = validAttachments[0];
            const fName = `ura_doc_${Date.now()}`;
            const uploadResult = await uploadBufferToCloudinary(attachment.content, fName, 'auto');
            finalFileUrl = uploadResult.secure_url;
          } catch(e) {
            console.error("Cloudinary upload greška:", e);
          }
        } else {
          // --- NEMA PRILOGA: PALIMO PUPPETEER DA SLIKA HTML ---
          try {
            console.log("Uslikavam HTML mail...");
            const htmlContent = mail.html || `<div style="font-family: Arial; padding: 20px; white-space: pre-wrap;">${mail.text || subject}</div>`;
            const browser = await puppeteer.launch({
              headless: true,
              args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--single-process']
            });
            const page = await browser.newPage();
            await page.setContent(htmlContent, { waitUntil: 'networkidle0', timeout: 15000 });
            const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
            await browser.close();

            const fName = `ura_sken_${Date.now()}`;
            const uploadResult = await uploadBufferToCloudinary(pdfBuffer, fName, 'image');
            finalFileUrl = uploadResult.secure_url;
            finalNote = 'Iz maila (Skenirano)';
          } catch (puppeteerErr) {
            console.error("Puppeteer greška, spašavam kao običan tekst:", puppeteerErr);
            // Osigurač ako skener ipak zapne - snimit će ga tekstualno da ne izgubiš račun!
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
                      } catch(err) { reject(err); }
                  });
              });
              doc.fontSize(16).text('Sadržaj e-maila (Greška u skeniranju formata)', { align: 'center' }).moveDown(2);
              doc.fontSize(10).text(fixText(mail.text || 'E-mail ne sadrži čitljiv tekst.'));
              doc.end();
              finalFileUrl = await uploadPromise;
            } catch(fallbackErr) { console.error(fallbackErr); }
          }
        }

        // --- PROVJERA DUPLIKATA I ZAPIS ---
        const duplicateCheck = await pool.query(
          "SELECT id FROM inbound_invoices WHERE supplier = $1 AND invoice_number = $2 AND amount = $3",
          [supplierName, finalNote === subject ? 'Iz maila' : finalNote, extractedAmount]
        );

        if (duplicateCheck.rows.length === 0) {
          // Ako račun NE postoji, upiši ga
          await pool.query(
            "INSERT INTO inbound_invoices (supplier, supplier_email, invoice_number, amount, file_url, note, date, status, archived) VALUES ($1, $2, $3, $4, $5, $6, $7, 'DOLAZNI', false)",
            [supplierName, senderAddress, finalNote === subject ? 'Iz maila' : finalNote, extractedAmount, finalFileUrl, subject, dateStr]
          );
          console.log(`✅ Račun od ${supplierName} (${extractedAmount} EUR) uspješno spremljen.`);
        } else {
          // Ako račun već POSTOJI, samo ga preskoči
          console.log(`⚠️ Preskačem duplikat računa od ${supplierName}.`);
        }

      } catch (singleMailErr) {
        console.error('Greška pri obradi JEDNOG maila:', singleMailErr.message);
      }
    }
    if (connection) connection.end();
  } catch (err) {
    console.error('IMAP Greška:', err.message);
  }
}

cron.schedule('*/15 * * * *', () => { fetchInboundInvoicesFromEmail(); });

// --- GENERIRANJE HTML MAILA ZA KUPCE ---
const buildInvoiceEmailHtml = ({ orderId, customerName, customerAddress, customerPhone, customerEmail, paymentMethod, items, totalAmount, dateObj, discount }) => {
  const invoiceNumber = invoiceNumberFromOrderId(orderId);
  const normalizedItems = parseJsonSafe(items, []);
  const d = dateObj ? new Date(dateObj) : new Date();
  const dateStr = d.toLocaleDateString('hr-HR');
  const timeStr = d.toLocaleTimeString('hr-HR');
  
  const itemsTotal = normalizedItems.reduce((acc, item) => acc + (toNumberSafe(item.price) * toNumberSafe(item.qty || item.quantity || 1)), 0);
  const disc = parseJsonSafe(discount, { amount: 0 });
  let shippingPrice = Number(totalAmount) - itemsTotal + Number(disc.amount);
  if (shippingPrice < 0) shippingPrice = 0;

  let table1Rows = '';
  let table2Rows = '';
  
  normalizedItems.forEach((item, index) => {
    const name = escapeHtml(`${item.brand ? item.brand + ' ' : ''}${item.name} (${(item.variantKey && item.variantKey.split('|')[0]) || 'Std'})`);
    const qty = toNumberSafe(item.qty || item.quantity || 1);
    const price = toNumberSafe(item.price);
    const rowTotal = (price * qty).toFixed(2);
    table1Rows += `<tr><td style="padding: 10px; border: 1px solid #ddd; text-align: left;">${name}</td><td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${qty}</td><td style="padding: 10px; border: 1px solid #ddd; text-align: right;">${price.toFixed(2)} EUR</td></tr>`;
    table2Rows += `<tr><td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${index + 1}</td><td style="padding: 10px; border: 1px solid #ddd; text-align: left;">${name}</td><td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${qty}</td><td style="padding: 10px; border: 1px solid #ddd; text-align: right;">${price.toFixed(2)}</td><td style="padding: 10px; border: 1px solid #ddd; text-align: right;">${rowTotal}</td></tr>`;
  });

  if (shippingPrice > 0) {
    table1Rows += `<tr><td style="padding: 10px; border: 1px solid #ddd; text-align: left;">Dostava</td><td style="padding: 10px; border: 1px solid #ddd; text-align: center;">1</td><td style="padding: 10px; border: 1px solid #ddd; text-align: right;">${shippingPrice.toFixed(2)} EUR</td></tr>`;
    table2Rows += `<tr><td style="padding: 10px; border: 1px solid #ddd; text-align: center;">${normalizedItems.length + 1}</td><td style="padding: 10px; border: 1px solid #ddd; text-align: left;">Dostava</td><td style="padding: 10px; border: 1px solid #ddd; text-align: center;">1</td><td style="padding: 10px; border: 1px solid #ddd; text-align: right;">${shippingPrice.toFixed(2)}</td><td style="padding: 10px; border: 1px solid #ddd; text-align: right;">${shippingPrice.toFixed(2)}</td></tr>`;
  }
  
  const discountHtml = disc && disc.amount > 0 ? `<div style="text-align: right; margin-top: 10px; color: #e53e3e;"><span style="font-size: 14px;">Popust (${escapeHtml(disc.code || 'Promo')}): <b>-${Number(disc.amount).toFixed(2)} EUR</b></span></div>` : '';

  return `<div style="font-family: Arial, sans-serif; max-width: 750px; margin: auto; padding: 20px; color: #333; line-height: 1.5; border: 1px solid #eee; border-radius: 5px;"><h2 style="text-align: center; color: #000; margin-bottom: 20px; font-size: 22px;">KISFALUBA</h2><p style="font-size: 13px;">Poštovani/a <b>${escapeHtml(customerName)}</b>,</p><p style="font-size: 13px;">Hvala Vam na kupnji! Vaša narudžba je uspješno zaprimljena i u pripremi je za slanje.</p><h3 style="border-bottom: 2px solid #000; padding-bottom: 5px; margin-top: 30px; font-size: 15px;">Detalji narudžbe</h3><table style="width: 100%; border-collapse: collapse; margin-bottom: 10px; font-size: 13px;"><thead><tr style="background-color: #fafafa;"><th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Artikl</th><th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Količina</th><th style="padding: 10px; border: 1px solid #ddd; text-align: right;">Cijena (EUR)</th></tr></thead><tbody>${table1Rows}</tbody></table>${discountHtml}<div style="text-align: right; margin-top: 15px;"><span style="font-size: 15px;">UKUPNO ZA PLATITI: <b>${Number(totalAmount).toFixed(2)} EUR</b></span><br><span style="font-size: 11px; color: #666;">Društvo nije u sustavu PDV-a. PDV nije obračunan.</span></div><h3 style="border-bottom: 2px solid #000; padding-bottom: 5px; margin-top: 30px; font-size: 15px;">Podaci za dostavu</h3><p style="font-size: 13px; margin: 0; line-height: 1.6;">${escapeHtml(customerName)}<br>${escapeHtml(customerAddress)}<br>Telefon: ${escapeHtml(customerPhone)}<br>E-mail: ${escapeHtml(customerEmail)}</p><h3 style="text-align: center; margin-top: 50px; margin-bottom: 20px; font-size: 16px;">RAČUN</h3><p style="font-size: 13px; margin: 0 0 25px 0; line-height: 1.6;"><b>KIŠFALUBA j.d.o.o.</b><br>Zagorska ulica 40, 31300 Branjina, Republika Hrvatska<br>OIB: 82125639708 | MBS: 5990572<br>Trgovački sud u Osijeku<br>Temeljni kapital: 10,00 EUR, uplaćen u cijelosti</p><table style="font-size: 13px; margin-bottom: 25px; width: 100%; border: none; line-height: 1.8;"><tr><td style="width: 140px; font-weight: bold;">Broj računa:</td><td>${invoiceNumber}</td></tr><tr><td style="font-weight: bold;">Datum izdavanja:</td><td>${dateStr}</td></tr><tr><td style="font-weight: bold;">Vrijeme izdavanja:</td><td>${timeStr}</td></tr><tr><td style="font-weight: bold;">Mjesto izdavanja:</td><td>Branjina, Republika Hrvatska</td></tr><tr><td style="font-weight: bold;">Kupac:</td><td>${escapeHtml(customerName)}</td></tr><tr><td style="font-weight: bold;">Adresa kupca:</td><td>${escapeHtml(customerAddress)}</td></tr><tr><td style="font-weight: bold;">Način plaćanja:</td><td>${paymentMethod}</td></tr></table><table style="width: 100%; border-collapse: collapse; margin-bottom: 10px; font-size: 13px;"><thead><tr style="background-color: #fafafa;"><th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Redni broj</th><th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Opis proizvoda</th><th style="padding: 10px; border: 1px solid #ddd; text-align: center;">Količina</th><th style="padding: 10px; border: 1px solid #ddd; text-align: right;">Jedinična cijena (EUR)</th><th style="padding: 10px; border: 1px solid #ddd; text-align: right;">Ukupno (EUR)</th></tr></thead><tbody>${table2Rows}</tbody></table>${discountHtml}<div style="text-align: right; margin-top: 20px; margin-bottom: 40px;"><span style="font-size: 15px;">Ukupan iznos za plaćanje: <b>${Number(totalAmount).toFixed(2)} EUR</b></span></div><div style="text-align: center; font-size: 11px; color: #555; border-top: 1px dotted #ccc; padding-top: 20px; line-height: 1.6;"><p style="margin: 2px 0;">Društvo nije u sustavu poreza na dodanu vrijednost (PDV).</p><p style="margin: 2px 0;">Sukladno važećim poreznim propisima, PDV nije obračunan.</p><br><p style="margin: 2px 0;">Ovaj račun izdan je u elektroničkom obliku i vrijedi bez potpisa i pečata.</p><p style="margin: 2px 0;">Za sva pitanja ili reklamacije obratite se na naš kontakt e-mail: info@kisfaluba.hr</p></div></div>`;
};

// --- PDF GENERATORI ---
const generatePDFInvoice = (orderData, invoiceNumber, filePath) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    
    const d = orderData.created_at ? new Date(orderData.created_at) : new Date();
    const dateStr = d.toLocaleDateString('hr-HR');
    const timeStr = d.toLocaleTimeString('hr-HR');
    
    const items = parseJsonSafe(orderData.items, []);
    let itemsTotal = 0;
    items.forEach(item => { itemsTotal += Number(item.price) * (item.qty || item.quantity || 1); });
    const disc = parseJsonSafe(orderData.discount, { amount: 0 });
    let shippingPrice = Number(orderData.total) - itemsTotal + Number(disc.amount);
    if (shippingPrice < 0) shippingPrice = 0;
    
    doc.fontSize(16).font('Helvetica-Bold').fillColor('#000000').text('KISFALUBA', { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(10).font('Helvetica');
    doc.text(fixText(`Postovani/a ${orderData.name},`));
    doc.moveDown(0.5);
    doc.text(fixText('Hvala Vam na kupnji! Vasa narudzba je uspjesno zaprimljena i u pripremi je za slanje.'));
    doc.moveDown(1.5);
    doc.font('Helvetica-Bold').fontSize(11).text(fixText('Detalji narudzbe'));
    doc.moveDown(0.5);
    
    let startY = doc.y;

    const drawTable1Row = (y, col1, col2, col3, isHeader = false) => {
      const rowHeight = 25;
      doc.rect(40, y, 510, rowHeight).fillAndStroke(isHeader ? '#fafafa' : '#ffffff', '#dddddd');
      doc.moveTo(350, y).lineTo(350, y + rowHeight).stroke('#dddddd');
      doc.moveTo(430, y).lineTo(430, y + rowHeight).stroke('#dddddd');
      
      doc.fillColor('#000000').font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      doc.text(col1, 50, y + 8, { width: 290 });
      doc.text(col2, 350, y + 8, { width: 80, align: 'center' });
      doc.text(col3, 430, y + 8, { width: 110, align: 'right', lineBreak: false }); 
      return y + rowHeight;
    };

    startY = drawTable1Row(startY, 'Artikl', fixText('Kolicina'), 'Cijena (EUR)', true);
    
    items.forEach((item) => {
      const name = fixText(`${item.brand ? item.brand + ' ' : ''}${item.name} (${(item.variantKey && item.variantKey.split('|')[0]) || 'Std'})`);
      const qty = item.qty || item.quantity || 1;
      const price = Number(item.price).toFixed(2) + ' EUR';
      startY = drawTable1Row(startY, name, qty.toString(), price, false);
    });

    if (shippingPrice > 0) {
      startY = drawTable1Row(startY, 'Dostava', '1', shippingPrice.toFixed(2) + ' EUR', false);
    }
    
    doc.y = startY + 10;
    if (disc && disc.amount > 0) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#e53e3e').text(`Popust (${disc.code || 'Promo'}): -${Number(disc.amount).toFixed(2)} EUR`, 300, doc.y, { width: 250, align: 'right' });
        doc.y += 5;
    }
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000').text(`UKUPNO ZA PLATITI: ${Number(orderData.total).toFixed(2)} EUR`, 300, doc.y, { width: 250, align: 'right' });
    doc.font('Helvetica').fontSize(8).fillColor('#666666').text(fixText('Drustvo nije u sustavu PDV-a. PDV nije obracunan.'), 300, doc.y, { width: 250, align: 'right' });
    doc.fillColor('#000000');
    doc.moveDown(2);
    
    doc.font('Helvetica-Bold').fontSize(11).text(fixText('Podaci za dostavu'), 40, doc.y);
    doc.moveTo(40, doc.y + 2).lineTo(550, doc.y + 2).strokeColor('#dddddd').stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(9);
    doc.text(fixText(orderData.name || ''));
    doc.text(fixText(orderData.address || ''));
    doc.text(`Telefon: ${fixText(orderData.phone || '')}`);
    doc.text(`E-mail: ${fixText(orderData.email || '')}`);
    doc.moveDown(3);
    
    doc.font('Helvetica-Bold').fontSize(12).text(fixText('RACUN'), { align: 'center' });
    doc.moveDown(1.5);
    let currentY = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).text('KISFALUBA j.d.o.o.', 40, currentY);
    doc.font('Helvetica').text('Zagorska ulica 40, 31300 Branjina, Republika Hrvatska');
    doc.text('OIB: 82125639708 | MBS: 5990572');
    doc.text('Trgovacki sud u Osijeku');
    doc.text('Temeljni kapital: 10,00 EUR, uplacen u cijelosti');
    doc.moveDown(1.5);
    
    currentY = doc.y;
    doc.font('Helvetica-Bold').text(fixText('Broj racuna:'), 40, currentY);
    doc.font('Helvetica').text(invoiceNumber, 150, currentY);
    currentY += 15;
    doc.font('Helvetica-Bold').text('Datum izdavanja:', 40, currentY);
    doc.font('Helvetica').text(dateStr, 150, currentY);
    currentY += 15;
    doc.font('Helvetica-Bold').text('Vrijeme izdavanja:', 40, currentY);
    doc.font('Helvetica').text(timeStr, 150, currentY);
    currentY += 15;
    doc.font('Helvetica-Bold').text('Mjesto izdavanja:', 40, currentY);
    doc.font('Helvetica').text('Branjina, Republika Hrvatska', 150, currentY);
    currentY += 15;
    doc.font('Helvetica-Bold').text('Kupac:', 40, currentY);
    doc.font('Helvetica').text(fixText(orderData.name), 150, currentY);
    currentY += 15;
    doc.font('Helvetica-Bold').text('Adresa kupca:', 40, currentY);
    doc.font('Helvetica').text(fixText(orderData.address), 150, currentY);
    currentY += 15;
    doc.font('Helvetica-Bold').text(fixText('Nacin placanja:'), 40, currentY);
    const paymentMethod = orderData.status === 'PAID' ? 'Karticno placanje (Stripe)' : 'Pouzece';
    doc.font('Helvetica').text(paymentMethod, 150, currentY);
    doc.moveDown(2);
    
    let t2Y = doc.y;
    
    const drawTable2Row = (y, col1, col2, col3, col4, col5, isHeader = false) => {
      const h = 25;
      doc.rect(40, y, 510, h).fillAndStroke(isHeader ? '#fafafa' : '#ffffff', '#dddddd');
      doc.moveTo(100, y).lineTo(100, y + h).stroke('#dddddd');
      doc.moveTo(310, y).lineTo(310, y + h).stroke('#dddddd');
      doc.moveTo(370, y).lineTo(370, y + h).stroke('#dddddd');
      doc.moveTo(460, y).lineTo(460, y + h).stroke('#dddddd');
      
      doc.fillColor('#000000').font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      doc.text(col1, 40, y + 8, { width: 60, align: 'center' });
      doc.text(col2, 110, y + 8, { width: 190 });
      doc.text(col3, 310, y + 8, { width: 60, align: 'center' });
      doc.text(col4, 370, y + 8, { width: 80, align: 'right' }); 
      doc.text(col5, 460, y + 8, { width: 80, align: 'right' }); 
      return y + h;
    };

    t2Y = drawTable2Row(t2Y, 'Redni broj', 'Opis proizvoda', fixText('Kolicina'), 'Jedinicna cijena (EUR)', 'Ukupno (EUR)', true);
    
    items.forEach((item, index) => {
      const name = fixText(`${item.brand ? item.brand + ' ' : ''}${item.name} (${(item.variantKey && item.variantKey.split('|')[0]) || 'Std'})`);
      const qty = item.qty || item.quantity || 1;
      const price = Number(item.price);
      const total = price * qty;
      t2Y = drawTable2Row(t2Y, (index + 1).toString(), name, qty.toString(), price.toFixed(2), total.toFixed(2), false);
    });

    if (shippingPrice > 0) {
      t2Y = drawTable2Row(t2Y, (items.length + 1).toString(), 'Dostava', '1', shippingPrice.toFixed(2), shippingPrice.toFixed(2), false);
    }

    doc.y = t2Y + 10;
    if (disc && disc.amount > 0) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#e53e3e').text(`Popust (${disc.code || 'Promo'}): -${Number(disc.amount).toFixed(2)} EUR`, 300, doc.y, { width: 250, align: 'right' });
        doc.y += 5;
    }
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000').text(`Ukupan iznos za placanje: ${Number(orderData.total).toFixed(2)} EUR`, 300, doc.y, { width: 250, align: 'right' });
    doc.moveDown(3);
    doc.font('Helvetica').fontSize(8).fillColor('#666666');
    doc.text(fixText('Drustvo nije u sustavu poreza na dodanu vrijednost (PDV).'), { align: 'center' });
    doc.text(fixText('Ovaj racun izdan je u elektronickom obliku i vrijedi bez potpisa i pecata.'), { align: 'center' });
    doc.end();
    
    stream.on('finish', () => resolve(filePath));
    stream.on('error', reject);
  });
};

const generateStornoPDFInvoice = (orderData, originalInvoiceNumber, stornoInvoiceNumber, filePath) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);
    
    const d = new Date();
    const dateStr = d.toLocaleDateString('hr-HR');
    const timeStr = d.toLocaleTimeString('hr-HR');
    
    const items = parseJsonSafe(orderData.items, []);
    const disc = parseJsonSafe(orderData.discount, { amount: 0 });
    
    let itemsTotal = 0;
    items.forEach(item => { 
        itemsTotal += Number(item.price) * (item.qty || item.quantity || 1); 
    });
    const finalRefund = itemsTotal - Number(disc.amount);
    
    doc.fontSize(16).font('Helvetica-Bold').fillColor('#000000').text('KISFALUBA', { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(10).font('Helvetica');
    doc.text(fixText(`Postovani/a ${orderData.name},`));
    doc.moveDown(0.5);
    doc.text(fixText(`Obavjestavamo Vas da je Vas racun br. ${originalInvoiceNumber} storniran (povrat robe/sredstava).`));
    doc.moveDown(1.5);
    doc.font('Helvetica-Bold').fontSize(11).text(fixText('Detalji stornirane narudzbe'));
    doc.moveDown(0.5);
    
    let startY = doc.y;
    const drawTable1Row = (y, col1, col2, col3, isHeader = false) => {
      const rowHeight = 25;
      doc.rect(40, y, 510, rowHeight).fillAndStroke(isHeader ? '#fafafa' : '#ffffff', '#dddddd');
      doc.moveTo(350, y).lineTo(350, y + rowHeight).stroke('#dddddd');
      doc.moveTo(430, y).lineTo(430, y + rowHeight).stroke('#dddddd');
      doc.fillColor('#000000').font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      doc.text(col1, 50, y + 8, { width: 290 });
      doc.text(col2, 350, y + 8, { width: 80, align: 'center' });
      doc.text(col3, 430, y + 8, { width: 110, align: 'right', lineBreak: false }); 
      return y + rowHeight;
    };

    startY = drawTable1Row(startY, 'Artikl', fixText('Kolicina'), 'Cijena (EUR)', true);
    
    items.forEach((item) => {
      const name = fixText(`${item.brand ? item.brand + ' ' : ''}${item.name} (${(item.variantKey && item.variantKey.split('|')[0]) || 'Std'})`);
      const qty = item.qty || item.quantity || 1;
      const price = Number(item.price).toFixed(2);
      startY = drawTable1Row(startY, name, `-${qty}`, `-${price} EUR`, false);
    });

    doc.y = startY + 10;
    if (disc && disc.amount > 0) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#e53e3e').text(`Storniran popust: +${Number(disc.amount).toFixed(2)} EUR`, 300, doc.y, { width: 250, align: 'right' });
        doc.y += 5;
    }
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#e53e3e').text(`UKUPNI STORNO: -${finalRefund.toFixed(2)} EUR`, 300, doc.y, { width: 250, align: 'right' });
    doc.font('Helvetica').fontSize(8).fillColor('#666666').text(fixText('Napomena: Usluga dostave se ne stornira.'), 300, doc.y, { width: 250, align: 'right' });
    doc.fillColor('#000000');
    doc.moveDown(2);
    
    doc.font('Helvetica-Bold').fontSize(11).text(fixText('Podaci kupca'), 40, doc.y);
    doc.moveTo(40, doc.y + 2).lineTo(550, doc.y + 2).strokeColor('#dddddd').stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(9);
    doc.text(fixText(orderData.name || ''));
    doc.text(fixText(orderData.address || ''));
    doc.text(`Telefon: ${fixText(orderData.phone || '')}`);
    doc.text(`E-mail: ${fixText(orderData.email || '')}`);
    doc.moveDown(3);
    
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#e53e3e').text(fixText('STORNO RACUN'), { align: 'center' });
    doc.fillColor('#000000');
    doc.moveDown(1.5);
    
    let currentY = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).text('KISFALUBA j.d.o.o.', 40, currentY);
    doc.font('Helvetica').text('Zagorska ulica 40, 31300 Branjina, Republika Hrvatska');
    doc.text('OIB: 82125639708 | MBS: 5990572');
    doc.text('Trgovacki sud u Osijeku');
    doc.text('Temeljni kapital: 10,00 EUR, uplacen u cijelosti');
    doc.moveDown(1.5);
    
    currentY = doc.y;
    doc.font('Helvetica-Bold').text(fixText('Broj storno racuna:'), 40, currentY);
    doc.font('Helvetica').text(stornoInvoiceNumber, 150, currentY);
    currentY += 15;
    doc.font('Helvetica-Bold').text('Vezano za racun br:', 40, currentY);
    doc.font('Helvetica').text(originalInvoiceNumber, 150, currentY);
    currentY += 15;
    doc.font('Helvetica-Bold').text('Datum storna:', 40, currentY);
    doc.font('Helvetica').text(dateStr, 150, currentY);
    currentY += 15;
    doc.font('Helvetica-Bold').text('Vrijeme storna:', 40, currentY);
    doc.font('Helvetica').text(timeStr, 150, currentY);
    currentY += 15;
    doc.font('Helvetica-Bold').text('Mjesto izdavanja:', 40, currentY);
    doc.font('Helvetica').text('Branjina, Republika Hrvatska', 150, currentY);
    currentY += 15;
    doc.font('Helvetica-Bold').text('Dobavljac:', 40, currentY);
    doc.font('Helvetica').text(fixText(orderData.name), 150, currentY);
    currentY += 15;
    doc.font('Helvetica-Bold').text('Adresa kupca:', 40, currentY);
    doc.font('Helvetica').text(fixText(orderData.address), 150, currentY);
    doc.moveDown(2);
    
    let t2Y = doc.y;
    const drawTable2Row = (y, col1, col2, col3, col4, col5, isHeader = false) => {
      const h = 25;
      doc.rect(40, y, 510, h).fillAndStroke(isHeader ? '#fafafa' : '#ffffff', '#dddddd');
      doc.moveTo(100, y).lineTo(100, y + h).stroke('#dddddd');
      doc.moveTo(310, y).lineTo(310, y + h).stroke('#dddddd');
      doc.moveTo(370, y).lineTo(370, y + h).stroke('#dddddd');
      doc.moveTo(460, y).lineTo(460, y + h).stroke('#dddddd');
      
      doc.fillColor('#000000').font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      doc.text(col1, 40, y + 8, { width: 60, align: 'center' });
      doc.text(col2, 110, y + 8, { width: 190 });
      doc.text(col3, 310, y + 8, { width: 60, align: 'center' });
      doc.text(col4, 370, y + 8, { width: 80, align: 'right' }); 
      doc.text(col5, 460, y + 8, { width: 80, align: 'right' }); 
      return y + h;
    };

    t2Y = drawTable2Row(t2Y, 'Redni broj', 'Opis proizvoda', fixText('Kolicina'), 'Jedinicna cijena (EUR)', 'Ukupno (EUR)', true);
    
    items.forEach((item, index) => {
      const name = fixText(`${item.brand ? item.brand + ' ' : ''}${item.name} (${(item.variantKey && item.variantKey.split('|')[0]) || 'Std'})`);
      const qty = item.qty || item.quantity || 1;
      const price = Number(item.price);
      const total = price * qty;
      t2Y = drawTable2Row(t2Y, (index + 1).toString(), name, `-${qty}`, `-${price.toFixed(2)}`, `-${total.toFixed(2)}`, false);
    });

    doc.y = t2Y + 10;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#e53e3e').text(`Ukupan iznos storna: -${finalRefund.toFixed(2)} EUR`, 300, doc.y, { width: 250, align: 'right' });
    doc.moveDown(3);
    
    doc.font('Helvetica').fontSize(8).fillColor('#666666');
    doc.text(fixText('Drustvo nije u sustavu poreza na dodanu vrijednost (PDV).'), { align: 'center' });
    doc.text(fixText('Ovaj storno racun izdan je u elektronickom obliku i vrijedi bez potpisa i pecata.'), { align: 'center' });
    doc.end();
    
    stream.on('finish', () => resolve(filePath));
    stream.on('error', reject);
  });
};

const generateUraStornoPDF = (inv, filePath) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    const d = new Date();
    const dateStr = d.toLocaleDateString('hr-HR');
    const timeStr = d.toLocaleTimeString('hr-HR');

    const finalRefund = Number(inv.amount) || 0; 
    const supplierName = inv.supplier || 'Nepoznato';
    const originalInvoiceNumber = inv.invoice_number || 'N/A';
    const stornoInvoiceNumber = originalInvoiceNumber.toUpperCase().includes('STORNO') ? originalInvoiceNumber : `STORNO-${originalInvoiceNumber}`;

    doc.fontSize(16).font('Helvetica-Bold').fillColor('#000000').text('KISFALUBA', { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(10).font('Helvetica');
    doc.text(fixText(`Postovani/a ${supplierName},`));
    doc.moveDown(0.5);
    doc.text(fixText(`Obavjestavamo Vas o povratu robe vezano za Vas racun br. ${originalInvoiceNumber}.`));
    doc.moveDown(1.5);
    doc.font('Helvetica-Bold').fontSize(11).text(fixText('Detalji povrata'));
    doc.moveDown(0.5);

    let startY = doc.y;
    const drawTable1Row = (y, col1, col2, col3, isHeader = false) => {
      const rowHeight = 25;
      doc.rect(40, y, 510, rowHeight).fillAndStroke(isHeader ? '#fafafa' : '#ffffff', '#dddddd');
      doc.moveTo(350, y).lineTo(350, y + rowHeight).stroke('#dddddd');
      doc.moveTo(430, y).lineTo(430, y + rowHeight).stroke('#dddddd');
      doc.fillColor('#000000').font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      doc.text(col1, 50, y + 8, { width: 290 });
      doc.text(col2, 350, y + 8, { width: 80, align: 'center' });
      doc.text(col3, 430, y + 8, { width: 110, align: 'right', lineBreak: false }); 
      return y + rowHeight;
    };

    startY = drawTable1Row(startY, 'Opis povrata', fixText('Kolicina'), 'Vrijednost (EUR)', true);

    const itemName = fixText(`Povrat po racunu br. ${originalInvoiceNumber}`);
    const price = Number(Math.abs(finalRefund)).toFixed(2);
    startY = drawTable1Row(startY, itemName, `1`, `-${price} EUR`, false);

    doc.y = startY + 10;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#e53e3e').text(`UKUPNI STORNO: -${Math.abs(finalRefund).toFixed(2)} EUR`, 300, doc.y, { width: 250, align: 'right' });
    if (inv.note) {
        doc.y += 5;
        doc.font('Helvetica').fontSize(8).fillColor('#666666').text(fixText(`Napomena: ${inv.note}`), 300, doc.y, { width: 250, align: 'right' });
    }
    doc.fillColor('#000000');
    doc.moveDown(2);

    doc.font('Helvetica-Bold').fontSize(11).text(fixText('Podaci dobavljaca'), 40, doc.y);
    doc.moveTo(40, doc.y + 2).lineTo(550, doc.y + 2).strokeColor('#dddddd').stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(9);
    doc.text(fixText(supplierName));
    doc.moveDown(3);

    doc.font('Helvetica-Bold').fontSize(14).fillColor('#e53e3e').text(fixText('STORNO RACUN / POVRATNICA'), { align: 'center' });
    doc.fillColor('#000000');
    doc.moveDown(1.5);

    let currentY = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).text('KISFALUBA j.d.o.o.', 40, currentY);
    doc.font('Helvetica').text('Zagorska ulica 40, 31300 Branjina, Republika Hrvatska');
    doc.text('OIB: 82125639708 | MBS: 5990572');
    doc.text('Trgovacki sud u Osijeku');
    doc.text('Temeljni kapital: 10,00 EUR, uplacen u cijelosti');
    doc.moveDown(1.5);

    currentY = doc.y;
    doc.font('Helvetica-Bold').text(fixText('Broj storno racuna:'), 40, currentY);
    doc.font('Helvetica').text(stornoInvoiceNumber, 150, currentY);
    currentY += 15;
    doc.font('Helvetica-Bold').text('Vezano za racun br:', 40, currentY);
    doc.font('Helvetica').text(originalInvoiceNumber, 150, currentY);
    currentY += 15;
    doc.font('Helvetica-Bold').text('Datum storna:', 40, currentY);
    doc.font('Helvetica').text(dateStr, 150, currentY);
    currentY += 15;
    doc.font('Helvetica-Bold').text('Vrijeme storna:', 40, currentY);
    doc.font('Helvetica').text(timeStr, 150, currentY);
    currentY += 15;
    doc.font('Helvetica-Bold').text('Mjesto izdavanja:', 40, currentY);
    doc.font('Helvetica').text('Branjina, Republika Hrvatska', 150, currentY);
    currentY += 15;
    doc.font('Helvetica-Bold').text('Dobavljac:', 40, currentY);
    doc.font('Helvetica').text(fixText(supplierName), 150, currentY);
    doc.moveDown(2);

    let t2Y = doc.y;
    const drawTable2Row = (y, col1, col2, col3, col4, col5, isHeader = false) => {
      const h = 25;
      doc.rect(40, y, 510, h).fillAndStroke(isHeader ? '#fafafa' : '#ffffff', '#dddddd');
      doc.moveTo(100, y).lineTo(100, y + h).stroke('#dddddd');
      doc.moveTo(310, y).lineTo(310, y + h).stroke('#dddddd');
      doc.moveTo(370, y).lineTo(370, y + h).stroke('#dddddd');
      doc.moveTo(460, y).lineTo(460, y + h).stroke('#dddddd');
      
      doc.fillColor('#000000').font(isHeader ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
      doc.text(col1, 40, y + 8, { width: 60, align: 'center' });
      doc.text(col2, 110, y + 8, { width: 190 });
      doc.text(col3, 310, y + 8, { width: 60, align: 'center' });
      doc.text(col4, 370, y + 8, { width: 80, align: 'right' }); 
      doc.text(col5, 460, y + 8, { width: 80, align: 'right' }); 
      return y + h;
    };

    t2Y = drawTable2Row(t2Y, 'Redni broj', 'Opis', fixText('Kolicina'), 'Jedinicna cijena (EUR)', 'Ukupno (EUR)', true);
    t2Y = drawTable2Row(t2Y, '1', itemName, '1', `-${price}`, `-${price}`, false);

    doc.y = t2Y + 10;
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#e53e3e').text(`Ukupan iznos storna: -${Math.abs(finalRefund).toFixed(2)} EUR`, 300, doc.y, { width: 250, align: 'right' });
    doc.moveDown(3);
    
    doc.font('Helvetica').fontSize(8).fillColor('#666666');
    doc.text(fixText('Napomena: Ovaj dokument sluzi iskljucivo kao dokaz o fizickom povratu robe dobavljacu.'), { align: 'center' });
    doc.text(fixText('Ovaj storno racun izdan je u elektronickom obliku i vrijedi bez potpisa i pecata.'), { align: 'center' });
    doc.end();
    
    stream.on('finish', () => resolve(filePath));
    stream.on('error', reject);
  });
};

// --- WEBHOOK ---
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
    const orderId = session.client_reference_id;
    if (orderId) {
      try {
        const updateResult = await pool.query(
          "UPDATE orders SET status = 'PAID' WHERE id = $1 RETURNING *",
          [orderId]
        );
        const updatedOrder = updateResult.rows[0];
        
        if (updatedOrder) {
          const invoiceNumber = invoiceNumberFromOrderId(orderId);
          const fileName = `racun_${orderId}_${Date.now()}.pdf`;
          const filePath = path.join(__dirname, 'uploads', fileName);
          
          await generatePDFInvoice(updatedOrder, invoiceNumber, filePath);
          
          const uploadResult = await cloudinary.uploader.upload(filePath, {
            folder: 'kisfaluba_racuni',
            resource_type: 'image'
          });
          const invoiceUrl = uploadResult.secure_url;
          
          try { fs.unlinkSync(filePath); } catch (e) { console.error('Brisanje lokalnog fajla propalo:', e); }
          
          await pool.query(
            "UPDATE orders SET invoice_url = $1 WHERE id = $2",
            [invoiceUrl, orderId]
          );
          
          console.log(`Narudžba ID ${orderId} je PLAĆENA i PDF račun je generiran!`);
          
          if (updatedOrder.email) {
            await transporter.sendMail({
              from: `"KIŠFALUBA j.d.o.o." <${process.env.EMAIL_USER}>`,
              to: updatedOrder.email,
              subject: `Račun i potvrda narudžbe KISFALUBA (${invoiceNumber})`,
              html: buildInvoiceEmailHtml({
                orderId: updatedOrder.id,
                customerName: updatedOrder.name,
                customerAddress: updatedOrder.address,
                customerPhone: updatedOrder.phone,
                customerEmail: updatedOrder.email,
                paymentMethod: 'Kartično plaćanje',
                items: parseJsonSafe(updatedOrder.items, []),
                totalAmount: updatedOrder.total,
                dateObj: updatedOrder.created_at,
                discount: parseJsonSafe(updatedOrder.discount, null)
              })
            });
            console.log(`Račun poslan na: ${updatedOrder.email}`);
          }
        }
      } catch (dbErr) {
        console.error('Greška pri ažuriranju baze:', dbErr);
      }
    }
  }
  res.json({ received: true });
});

app.use(express.json());

// --- AUTHENTIKACIJA ---
app.post('/api/login', async (req, res) => {
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

// --- STRIPE CHECKOUT ---
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, customer, total, isApp, discount } = req.body; 
    const normalizedItems = parseJsonSafe(items, []);
    const totalAmount = Number((Number.isFinite(Number(total)) ? Number(total) : calcTotals(normalizedItems)).toFixed(2));
    
    const address = customer.address; 
    const name = `${customer.firstName} ${customer.lastName}`;
    
    const newOrder = await pool.query(
      'INSERT INTO orders (name, address, phone, email, total, items, status, discount) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
      [name, address, customer.phone || '', customer.email || '', totalAmount, JSON.stringify(normalizedItems), 'NEW', JSON.stringify(discount || { amount: 0 })]
    );
    const orderId = newOrder.rows[0].id;
    await deductStock(normalizedItems);
    
    const totalInCents = Math.round(totalAmount * 100);
    const successUrl = isApp ? `${req.protocol}://${req.get('host')}/payment-success?app=true` : `${req.protocol}://${req.get('host')}/payment-success`;
    const cancelUrl = isApp ? `${req.protocol}://${req.get('host')}/payment-cancel?app=true` : `${req.protocol}://${req.get('host')}/payment-cancel`;
    
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      client_reference_id: String(orderId),
      customer_email: customer.email || undefined,
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: 'KISFALUBA Vaša narudžba', description: `Kupac: ${name}` },
          unit_amount: totalInCents,
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: req.body.returnUrl ? req.body.returnUrl : successUrl,
      cancel_url: req.body.returnUrl ? req.body.returnUrl.replace('payment-success', 'payment-cancel') : cancelUrl,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe greška:', err.message);
    res.status(500).json({ error: 'Greška pri povezivanju sa Stripeom.' });
  }
});

// --- RUTE ZA ULAZNE RAČUNE (URA) ---

app.post('/inbound-invoices/fetch-email', async (req, res) => {
  console.log("Ručno pokrenuta provjera mailova...");
  await fetchInboundInvoicesFromEmail();
  res.json({ success: true, message: 'Provjera pošte završena.' });
});

app.get('/inbound-invoices', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM inbound_invoices ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: "Greška servera" }); }
});

app.post('/inbound-invoices', async (req, res) => {
  const { supplier, supplier_email, invoice_number, amount, file_url, note, date } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO inbound_invoices (supplier, supplier_email, invoice_number, amount, file_url, note, date, status, archived) VALUES ($1, $2, $3, $4, $5, $6, $7, 'DOLAZNI', false) RETURNING *",
      [supplier, supplier_email || '', invoice_number, amount, file_url, note, date]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: "Greška u bazi." }); }
});

app.patch('/inbound-invoices/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const id = String(req.params.id).split('-')[0];
    const targetStatus = (status === 'POVRATI' || status === 'STORNO' || status === 'POVRAT ROBE') ? 'POVRATI' : status;

    if (targetStatus === 'POVRATI') {
       const origRes = await pool.query('SELECT * FROM inbound_invoices WHERE id = $1', [id]);
       if (origRes.rows.length === 0) return res.status(404).json({ error: 'Račun nije pronađen.' });
       const orig = origRes.rows[0];

       // --- BRAVA PROTIV DUPLANJA ---
       if (orig.storno_url) {
           return res.json({ success: true, invoice: orig });
       }

       let siguranBroj = orig.invoice_number ? String(orig.invoice_number).trim() : `URA-${orig.id}`;
       const stornoNumber = siguranBroj.toUpperCase().includes('STORNO') ? siguranBroj : `STORNO-${siguranBroj}`;

       // 1. KREIRAMO NOVI RAČUN (Minus iznos za knjigovođu)
       const stornoInsert = await pool.query(`
         INSERT INTO inbound_invoices (supplier, supplier_email, invoice_number, amount, file_url, note, date, status, archived)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'POVRATI', false) RETURNING *
       `, [
         orig.supplier,
         orig.supplier_email,
         stornoNumber,
         -Math.abs(Number(orig.amount)),
         orig.file_url, 
         `Storno za račun br. ${siguranBroj}`,
         new Date().toLocaleDateString('hr-HR')
       ]);

       let newStorno = stornoInsert.rows[0];

       // 2. GENERIRAMO PDF
       const fileName = `ura_storno_${newStorno.id}_${Date.now()}.pdf`;
       const filePath = path.join(__dirname, 'uploads', fileName);
       await generateUraStornoPDF(orig, filePath); 
       const uploadResult = await cloudinary.uploader.upload(filePath, { folder: 'kisfaluba_ura', resource_type: 'image' });
       const stornoUrl = uploadResult.secure_url;
       try { fs.unlinkSync(filePath); } catch (e) {}

       // 3. KLJUČNO: Originalni račun ostavljamo NETAKNUT. Nema mijenjanja statusa, NEMA arhiviranja.
       // Dodajemo mu samo storno link kako bi ostao u izvještaju zajedno s novim negativnim računom.
       await pool.query('UPDATE inbound_invoices SET storno_url = $1 WHERE id = $2', [stornoUrl, orig.id]);
       await pool.query('UPDATE inbound_invoices SET storno_url = $1, file_url = $2 WHERE id = $3', [stornoUrl, stornoUrl, newStorno.id]);

       orig.storno_url = stornoUrl;
       return res.json({ success: true, invoice: orig });
    }

    // Za ostale statuse (Plaćeno, Arhivirano)
    let query = 'UPDATE inbound_invoices SET status = $1 WHERE id = $2 RETURNING *';
    if (targetStatus === 'ARHIVIRANI' || targetStatus === 'STORNO ARHIVA') {
        query = 'UPDATE inbound_invoices SET status = $1, archived = true WHERE id = $2 RETURNING *';
    }
    const result = await pool.query(query, [targetStatus, id]);
    res.json({ success: true, invoice: result.rows[0] });
  } catch (err) {
    console.error("Greška:", err);
    res.status(500).json({ error: 'Greška u bazi.' });
  }
});

app.post('/inbound-invoices/archive', async (req, res) => {
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

app.delete('/inbound-invoices/:id', async (req, res) => {
  try {
    const id = String(req.params.id).split('-')[0];
    await pool.query('DELETE FROM inbound_invoices WHERE id = $1', [id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Greška pri brisanju' }); }
});

app.patch('/inbound-invoices/:id/file', async (req, res) => {
  try {
    const id = String(req.params.id).split('-')[0];
    const { fileUrl } = req.body;
    await pool.query('UPDATE inbound_invoices SET file_url = $1 WHERE id = $2', [fileUrl, id]);
    res.json({ success: true, message: 'Dokument uspješno spremljen u bazu!' });
  } catch (err) { 
    console.error("Greška pri spremanju PDF linka u bazu:", err);
    res.status(500).json({ error: 'Greška u bazi.' }); 
  }
});

app.post('/api/send-ura-storno', async (req, res) => {
  const { id, supplierEmail } = req.body;
  try {
    const cleanId = String(id).split('-')[0];
    const result = await pool.query('SELECT * FROM inbound_invoices WHERE id = $1', [cleanId]);
    if (result.rows.length === 0) return res.status(404).json({error: 'Nema računa'});
    const inv = result.rows[0];

    const pdfLink = inv.storno_url || inv.file_url;
    if (!pdfLink) return res.status(400).json({ error: 'Nema PDF dokumenta.' });

    const finalEmail = (inv.supplier_email && inv.supplier_email.includes('@')) ? inv.supplier_email : supplierEmail;

    if (finalEmail && finalEmail.includes('@')) {
      await transporter.sendMail({
        from: `"KIŠFALUBA j.d.o.o." <${process.env.EMAIL_USER}>`,
        to: finalEmail,
        subject: `Storno / Povratnica - ${inv.invoice_number}`,
        html: `<p>Poštovani, u privitku je dokument: <a href="${pdfLink}">PREUZMI</a></p>`
      });
    }
    res.json({ success: true, message: 'Mail poslan!' });
  } catch (error) { res.status(500).json({ error: 'Greška servera.' }); }
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
    const { brand, name, description, price, cost_price, category, images, variants, fit_info, material_info, manufacturer_info } = req.body;
    const result = await pool.query(
      'INSERT INTO products (brand, name, description, price, cost_price, category, images, variants, fit_info, material_info, manufacturer_info) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *',
      [brand || '', name || '', description || '', toNumberSafe(price), toNumberSafe(cost_price || 0), category || '', JSON.stringify(images || []), JSON.stringify(variants || []), fit_info || '', material_info || '', manufacturer_info || '']
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
    const { brand, name, description, price, cost_price, category, images, variants, fit_info, material_info, manufacturer_info } = req.body;
    const result = await pool.query(
      'UPDATE products SET brand = $1, name = $2, description = $3, price = $4, cost_price = $5, category = $6, images = $7, variants = $8, fit_info = $9, material_info = $10, manufacturer_info = $11 WHERE id = $12 RETURNING *',
      [brand || '', name || '', description || '', toNumberSafe(price), toNumberSafe(cost_price || 0), category || '', JSON.stringify(images || []), JSON.stringify(variants || []), fit_info || '', material_info || '', manufacturer_info || '', id]
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

// --- RUTE ZA NARUDŽBE ---
app.get('/all-orders', async (req, res) => {
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

app.get('/orders', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY id DESC');
    res.json(result.rows.map(o => ({ ...o, items: parseJsonSafe(o.items, []), })));
  } catch (err) { res.status(500).json({ error: 'Greška' }); }
});

app.post('/orders', async (req, res) => {
  try {
    const { name, address, phone, total, items, email, discount } = req.body; 
    const normalizedItems = parseJsonSafe(items, []);
    const totalAmount = Number((Number.isFinite(Number(total)) ? Number(total) : calcTotals(normalizedItems)).toFixed(2));
    const newOrder = await pool.query(
      'INSERT INTO orders (name, address, phone, email, total, items, status, discount) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [name || 'Nepoznat', address || '', phone || '', email || '', totalAmount, JSON.stringify(normalizedItems), 'NEW', JSON.stringify(discount || { amount: 0 })]
    );
    const orderData = newOrder.rows[0];
    const orderId = orderData.id;
    await deductStock(normalizedItems);
    
    const invoiceNumber = invoiceNumberFromOrderId(orderId);
    const fileName = `racun_${orderId}_${Date.now()}.pdf`;
    const filePath = path.join(__dirname, 'uploads', fileName);
    
    await generatePDFInvoice(orderData, invoiceNumber, filePath);
    
    const uploadResult = await cloudinary.uploader.upload(filePath, {
      folder: 'kisfaluba_racuni',
      resource_type: 'image'
    });
    const invoiceUrl = uploadResult.secure_url;
    try { fs.unlinkSync(filePath); } catch (e) { console.error(e); }
    
    await pool.query('UPDATE orders SET invoice_url = $1 WHERE id = $2', [invoiceUrl, orderId]);
    orderData.invoice_url = invoiceUrl;
    
    if (email) {
      transporter.sendMail({
        from: `"KIŠFALUBA j.d.o.o." <${process.env.EMAIL_USER}>`,
        to: email,
        subject: `Račun i potvrda narudžbe KISFALUBA (${invoiceNumber})`,
        html: buildInvoiceEmailHtml({
          orderId: orderId, customerName: name, customerAddress: address,
          customerPhone: phone, customerEmail: email, paymentMethod: 'Pouzeće',
          items: normalizedItems, totalAmount: totalAmount, dateObj: orderData.created_at,
          discount: discount 
        })
      }).catch(e => console.error('X Greška slanja računa:', e));
    }
    res.json({ message: 'Narudžba uspješna!', order: orderData });
  } catch (err) { res.status(500).json({ error: 'Greška pri spremanju.' }); }
});

app.post('/orders/archive', async (req, res) => {
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

app.patch('/orders/:id/status', async (req, res) => {
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
      const originalInvoiceNumber = invoiceNumberFromOrderId(orderId);
      const stornoInvoiceNumber = `${originalInvoiceNumber}-STORNO`;
      const fileName = `storno_${orderId}_${Date.now()}.pdf`;
      const filePath = path.join(__dirname, 'uploads', fileName);
      
      await generateStornoPDFInvoice(orderData, originalInvoiceNumber, stornoInvoiceNumber, filePath);
      
      const uploadResult = await cloudinary.uploader.upload(filePath, {
        folder: 'kisfaluba_storno',
        resource_type: 'image'
      });
      const stornoUrl = uploadResult.secure_url;
      try { fs.unlinkSync(filePath); } catch (e) { console.error(e); }
      
      await pool.query('UPDATE orders SET storno_url = $1, archived = false WHERE id = $2', [stornoUrl, orderId]);
      
      orderData.storno_url = stornoUrl;
      orderData.archived = false;
    }

    res.json({ success: true, order: orderData });
  } catch (err) {
    console.error("Greška pri ažuriranju statusa narudžbe:", err);
    res.status(500).json({ error: 'Greška u bazi.' });
  }
});

app.post('/orders/:id/send-storno', async (req, res) => {
  try {
    const orderId = String(req.params.id).split('-')[0];
    const result = await pool.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Narudžba nije pronađena.' });
    }
    
    const orderData = result.rows[0];
    if (!orderData.email) return res.status(400).json({ error: 'Kupac nema unesenu email adresu.' });

    const pdfLinkZaKupca = orderData.storno_url || orderData.invoice_url;
    if (!pdfLinkZaKupca) return res.status(400).json({ error: 'Storno račun još nije generiran.' });

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
      subject: `Storno račun i obavijest o povratu - KISFALUBA`,
      html: emailHtml
    });

    res.json({ success: true, message: 'Storno mail uspješno poslan kupcu!' });
  } catch (err) {
    console.error("Greška pri slanju storno maila:", err);
    res.status(500).json({ error: 'Greška pri slanju maila.' });
  }
});

app.patch('/orders/:id/invoice', async (req, res) => {
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
    const paymentMethod = orderData.status === 'PAID' ? 'Kartično plaćanje' : 'Pouzeće';
    const html = buildInvoiceEmailHtml({
      orderId: orderData.id, customerName: orderData.name, customerAddress: orderData.address,
      customerPhone: orderData.phone, customerEmail: orderData.email, paymentMethod: paymentMethod,
      items: parseJsonSafe(orderData.items, []), totalAmount: orderData.total, dateObj: orderData.created_at,
      discount: parseJsonSafe(orderData.discount, null) 
    });
    res.send(html);
  } catch (err) { res.status(500).send('Greška.'); }
});

// --- RUTE ZA POSTAVKE I KATEGORIJE ---
app.get('/settings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM shop_settings LIMIT 1');
    res.json(result.rows[0] || { cod_enabled: true });
  } catch (err) { res.status(500).json({ error: 'Greška postavki' }); }
});

app.post('/settings/cod', async (req, res) => {
  try {
    const result = await pool.query('UPDATE shop_settings SET cod_enabled = $1 RETURNING *', [req.body.cod_enabled]);
    res.json({ message: 'Postavke ažurirane!', settings: result.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Greška ažuriranja' }); }
});

app.post('/settings/hero', async (req, res) => {
  try {
    const { title, sub, img } = req.body;
    const check = await pool.query('SELECT * FROM shop_settings LIMIT 1');
    if (check.rows.length === 0) {
      await pool.query('INSERT INTO shop_settings (cod_enabled, hero_title, hero_sub, hero_img) VALUES (true, $1, $2, $3)', [title, sub, img]);
    } else {
      await pool.query('UPDATE shop_settings SET hero_title = $1, hero_sub = $2, hero_img = $3', [title, sub, img]);
    }
    res.json({ message: 'Ažurirano!' });
  } catch (err) { res.status(500).json({ error: 'Greška.' }); }
});

app.post('/settings/coupons', async (req, res) => {
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

app.post('/api/categories', async (req, res) => {
  const { id, name } = req.body;
  try {
    await pool.query('INSERT INTO categories (id, name) VALUES ($1, $2)', [id, name]);
    res.json({ success: true, message: 'Kategorija dodana' });
  } catch (err) {
    console.error('Greška pri spremanju kategorije:', err);
    res.status(500).json({ error: 'Greška na serveru' });
  }
});

app.delete('/api/categories/:id', async (req, res) => {
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
  res.send(`<!DOCTYPE html><html lang="hr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Uspješna kupnja KISFALUBA</title><style>body { margin: 0; padding: 0; background-color: #050505; background-image: url('https://images.unsplash.com/photo-1490481651871-ab68de25d43d?q=80&w=2070&auto=format&fit=crop'); background-size: cover; background-position: center; background-attachment: fixed; height: 100vh; display: flex; justify-content: center; align-items: center; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; text-align: center; }.overlay {position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0, 0, 0, 0.80); z-index: 1;} .content { position: relative; z-index: 2; background: rgba(15, 15, 15, 0.65); padding: 50px 40px; border-radius: 12px; border: 1px solid #D4AF37; box-shadow: 0 15px 40px rgba(0,0,0,0.8); max-width: 480px; width: 85%; backdrop-filter: blur(8px); } h1 { color: #D4AF37; font-size: 26px; margin-bottom: 15px; text-transform: uppercase; letter-spacing: 2px; text-shadow: 0 2px 4px rgba(0,0,0,0.8); } p { color: #e0e0e0; font-size: 15px; line-height: 1.6; margin-bottom: 35px; } .gold-line { width: 60px; height: 2px; background: #D4AF37; margin: 0 auto 20px auto; border-radius: 2px; } .btn { display: inline-block; background: linear-gradient(135deg, #E5C058 0%, #B8860B 100%); color: #000; text-decoration: none; padding: 16px 35px; font-size: 15px; font-weight: bold; border-radius: 4px; text-transform: uppercase; border: none; cursor: pointer; transition: all 0.3s ease; box-shadow: 0 4px 15px rgba(212, 175, 55, 0.2); } .btn:hover { transform: translateY(-3px); box-shadow: 0 6px 20px rgba(212, 175, 55, 0.4); } .icon { font-size: 45px; margin-bottom: 10px; text-shadow: 0 0 15px rgba(212, 175, 55, 0.5); }</style></head><body><div class="overlay"></div><div class="content"><div class="icon"></div><h1>Uspješna kupnja</h1><div class="gold-line"></div><p>Zahvaljujemo Vam na povjerenju.<br>Vaša transakcija je provedena stručno i profesionalno.<br><br>Svi detalji narudžbe te elektronički račun uspješno su poslani na Vašu e-mail adresu.</p><button class="btn" onclick="goBack()">POVRATAK U TRGOVINU</button></div><script>if (${isApp}) { setTimeout(function() { window.location.replace("exp://192.168.0.14:8081/--"); setTimeout(function(){ window.close(); }, 300); }, 3000); } function goBack() { if (${isApp}) { window.location.replace("exp://192.168.0.14:8081/--"); setTimeout(function(){ window.close(); }, 300); } else { window.location.href = "http://localhost:8081?clearCart=true"; } }</script></body></html>`);
});

app.get('/payment-cancel', (req, res) => {
  const isApp = req.query.app === 'true';
  res.send(`<!DOCTYPE html><html lang="hr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Kupnja prekinuta KISFALUBA</title><style>body { margin: 0; background-color: #0a0a0a; height: 100vh; display: flex; justify-content: center; align-items: center; font-family: 'Helvetica Neue', sans-serif; text-align: center; color: #fff;} .content { background: #151515; padding: 40px; border-radius: 8px; border: 1px solid #333; max-width: 400px; width: 85%; } h1 { color: #aaa; font-size: 20px; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 1px;} p { color: #777; font-size: 15px; margin-bottom: 25px; line-height: 1.5;} .btn { background: #2a2a2a; color: #fff; padding: 14px 30px; border-radius: 4px; text-transform: uppercase; font-size: 13px; font-weight: bold; border: none; cursor: pointer; transition: 0.3s; } .btn:hover { background: #444; }</style></head><body><div class="content"><h1>Kupnja prekinuta</h1><p>Postupak plaćanja je otkazan. Bez brige, Vaša košarica je ostala sačuvana.</p><button class="btn" onclick="goBack()">NAZAD U TRGOVINU</button></div><script>function goBack() { if (${isApp}) { window.location.replace("exp://192.168.0.14:8081/--"); setTimeout(function(){ window.close(); }, 300); } else { window.location.href = "http://localhost:8081"; } }</script></body></html>`);
});

app.get('/', (req, res) => res.send('KISFALUBA Backend Online!'));

// --- PRIVREMENA METLA ZA BRISANJE SVEGA ---
app.get('/brisanje-baze', async (req, res) => {
  try {
    await pool.query('DELETE FROM orders');
    await pool.query('DELETE FROM inbound_invoices');
    res.send('<h1>Sve narudžbe i ulazni računi su uspješno obrisani! 🧹</h1><p>Sada se vrati u VS Code, OBRISI ovaj kod i napravi novi Deploy kako ti nitko na internetu ne bi mogao obrisati bazu.</p>');
  } catch (err) { 
    res.status(500).send('Greška pri brisanju: ' + err.message); 
  }
});

app.listen(PORT, '0.0.0.0', () => { 
  console.log(`KISFALUBA SERVER RADI NA PORTU ${PORT}`); 
});