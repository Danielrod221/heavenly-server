require('dotenv').config(); 
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken'); 
const nodemailer = require('nodemailer'); 

// 1. IMPORT AMAZON WEB SERVICES
const { S3Client } = require('@aws-sdk/client-s3');
const multerS3 = require('multer-s3');

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) { fs.mkdirSync(uploadDir); }

const app = express();
app.use(cors());

// 🔒 STRIPE INITIALIZATION
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ==========================================
// 🔒 THE FORT KNOX WEBHOOK 
// (Must sit exactly here, ABOVE express.json so Stripe can read the raw encrypted body)
// ==========================================
app.post('/api/webhook', express.raw({type: 'application/json'}), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    // Verify the encrypted signature from Stripe using your Webhook Secret
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log(`⚠️ Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error`);
  }

  // If the payment is 100% successful, verified, and money has moved:
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.metadata.order_id; // Grab the secret PO ID we attached

    try {
      // Safely update the database (Bypassing the user entirely)
      await pool.query(`UPDATE purchase_orders SET payment_status = 'paid' WHERE id = $1`, [orderId]);
      console.log(`✅ Webhook verified: Order ${orderId} officially paid in full.`);
    } catch (dbErr) {
      console.log('Database error during webhook:', dbErr);
    }
  }
  res.json({received: true});
});

app.use(express.json());
app.use('/uploads', express.static(uploadDir));

// ☁️ UPDATED: Smart Cloud Connection (Uses DATABASE_URL if available, falls back to local if not)
const pool = new Pool(
  process.env.DATABASE_URL 
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : { user: process.env.DB_USER, database: process.env.DB_DATABASE, host: process.env.DB_HOST, port: process.env.DB_PORT }
);

pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS w9_url TEXT, ADD COLUMN IF NOT EXISTS cert_url TEXT, ADD COLUMN IF NOT EXISTS cert_type TEXT, ADD COLUMN IF NOT EXISTS paca_number TEXT, ADD COLUMN IF NOT EXISTS phone_number TEXT;`).catch(err => {});
pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;`).catch(err => {});
pool.query(`ALTER TABLE pallets ADD COLUMN IF NOT EXISTS pack_style TEXT, ADD COLUMN IF NOT EXISTS weight TEXT, ADD COLUMN IF NOT EXISTS variety TEXT, ADD COLUMN IF NOT EXISTS location TEXT, ADD COLUMN IF NOT EXISTS loading_window TEXT, ADD COLUMN IF NOT EXISTS grade TEXT, ADD COLUMN IF NOT EXISTS photo_url_2 TEXT, ADD COLUMN IF NOT EXISTS size TEXT, ADD COLUMN IF NOT EXISTS payment_terms TEXT, ADD COLUMN IF NOT EXISTS storage_temp TEXT, ADD COLUMN IF NOT EXISTS brand TEXT, ADD COLUMN IF NOT EXISTS lat DECIMAL(10,6), ADD COLUMN IF NOT EXISTS lon DECIMAL(10,6), ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'available', ADD COLUMN IF NOT EXISTS pallets_available INT DEFAULT 1, ADD COLUMN IF NOT EXISTS boxes_per_pallet INT DEFAULT 54;`).catch(err => {});
pool.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'unpaid', ADD COLUMN IF NOT EXISTS appointment_time TEXT, ADD COLUMN IF NOT EXISTS purchased_boxes INT DEFAULT 1, ADD COLUMN IF NOT EXISTS purchased_pallets INT DEFAULT 1;`).catch(err => {});
pool.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS payout_status TEXT DEFAULT 'pending';`).catch(err => {});
pool.query(`CREATE TABLE IF NOT EXISTS offers (id SERIAL PRIMARY KEY, pallet_id INT, buyer_id INT, grower_id INT, current_offer DECIMAL(10,2), last_actor TEXT, grower_counter_count INT DEFAULT 0, status TEXT DEFAULT 'pending', appointment_time TEXT, requested_pallets INT DEFAULT 1);`).catch(err => {});
pool.query(`CREATE TABLE IF NOT EXISTS invite_requests (id SERIAL PRIMARY KEY, company_name VARCHAR(255), contact_name VARCHAR(255), email VARCHAR(255), paca_number VARCHAR(255), status VARCHAR(50) DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`).catch(err => console.error(err));

// ==========================================
// ☁️ THE AUTO-TOGGLE CLOUD VAULT
// ==========================================
let storage;

if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  console.log("☁️  AWS S3 Cloud Vault is ACTIVE.");
  const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
  });

  storage = multerS3({
    s3: s3,
    bucket: process.env.AWS_S3_BUCKET_NAME,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: function (req, file, cb) {
      const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-]/g, '_');
      cb(null, `ht-vault/${Date.now()}-${safeName}`);
    }
  });
} else {
  console.log("💻 Local Fallback Vault is ACTIVE. (Add AWS keys to .env to switch to cloud)");
  storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, 'uploads/'); },
    filename: function (req, file, cb) { 
      const safeName = file.originalname.replace(/[^a-zA-Z0-9.\-]/g, '_');
      cb(null, Date.now() + '-' + safeName); 
    }
  });
}

const upload = multer({ storage: storage });
// ==========================================

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true, // Forces SSL secure connection
  auth: { 
    user: process.env.EMAIL_USER, 
    pass: process.env.EMAIL_PASS 
  },
  tls: {
    // Do not fail on invalid certs (helps bypass strict cloud firewalls)
    rejectUnauthorized: false
  }
});

const dispatchTransactionEmails = async (buyer, grower, pallet, poNumber, appointmentTime, purchasedPallets, purchasedBoxes) => {
  const apptText = appointmentTime ? `\n⏰ Requested Appt: ${new Date(appointmentTime).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : '';
  const growerSubject = `💰 HT Alert: New Purchase Order (${poNumber})`;
  const growerBody = `
GREAT NEWS! Inventory has been sold on The Heavy Terminal.

--- ORDER DETAILS ---
PO Number: ${poNumber}
Commodity: ${purchasedPallets} Pallets (${purchasedBoxes} boxes) of ${pallet.commodity_type} ${pallet.variety ? `(${pallet.variety})` : ''}
Sale Price: $${pallet.asking_price} / box

--- BUYER INFORMATION ---
Company: ${buyer.company_name}
PACA License: ${buyer.paca_number || 'N/A'}
Contact Email: ${buyer.email}${apptText}

Please prepare the load. The buyer will reach out to coordinate pickup.`;

  const buyerSubject = `🧾 HT Loading Instructions (PO: ${poNumber})`;
  const buyerBody = `
Thank you for your purchase on The Heavy Terminal!

--- PURCHASE RECORD ---
PO Number: ${poNumber}
Commodity: ${purchasedPallets} Pallets (${purchasedBoxes} boxes) of ${pallet.commodity_type} ${pallet.variety ? `(${pallet.variety})` : ''}
Price: $${pallet.asking_price} / box
HT Platform Fee: $0.35 / box

--- 🚛 STRICT LOADING INSTRUCTIONS ---
Facility / Grower: ${grower.company_name}
📍 Location: ${pallet.location}
🕒 Loading Hours: ${pallet.loading_window}
❄️ Storage Temp: ${pallet.storage_temp}

--- GROWER CONTACT ---
Email: ${grower.email}
Phone: ${grower.phone_number || 'Contact via email above'}${apptText}

(If this load is 'By Appointment Only', please email the grower immediately to confirm your truck's ETA).`;

  if (!process.env.EMAIL_USER) {
    console.log('\n\x1b[36m%s\x1b[0m', '================================================');
    console.log('\x1b[36m%s\x1b[0m', '🚀 [EMAIL SIMULATOR] TRANSACTION LOCKED');
    console.log('\x1b[36m%s\x1b[0m', '================================================');
    console.log(`\x1b[33m➡️ TO GROWER: ${grower.email}\x1b[0m`);
    console.log(`Subject: ${growerSubject}`);
    console.log(growerBody);
    console.log('------------------------------------------------');
    console.log(`\x1b[32m➡️ TO BUYER: ${buyer.email}\x1b[0m`);
    console.log(`Subject: ${buyerSubject}`);
    console.log(buyerBody);
    console.log('\x1b[36m%s\x1b[0m', '================================================\n');
    return;
  }
  // 1. Try to email the Grower (if it fails, just log it and move on!)
  await transporter.sendMail({ 
    from: process.env.EMAIL_USER, 
    to: grower.email, 
    subject: growerSubject, 
    text: growerBody 
  }).catch(err => console.log('Grower email skipped/failed:', err.message));

  // 2. Try to email the Buyer (completely independent of the Grower!)
  await transporter.sendMail({ 
    from: process.env.EMAIL_USER, 
    to: buyer.email, 
    subject: buyerSubject, 
    text: buyerBody 
  }).catch(err => console.log('Buyer email skipped/failed:', err.message));
};

app.post('/api/login', async (req, res) => {
  const { email, password, role } = req.body;
  try {
    const userQuery = await pool.query('SELECT * FROM users WHERE email = $1 AND role = $2', [email, role]);
    if (userQuery.rows.length === 0) return res.status(401).json({ success: false, message: 'Invalid credentials' });
    const user = userQuery.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ success: false, message: 'Invalid password' });
    const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token: token, userId: user.id, role: user.role });
  } catch (err) { res.status(500).json({ success: false, message: 'Server error' }); }
});

app.get('/api/live-cooler', async (req, res) => {
  try {
    const pallets = await pool.query(`SELECT p.*, u.company_name AS grower_company, u.cert_type FROM pallets p JOIN users u ON p.grower_id = u.id WHERE p.status = 'available' AND p.pallets_available > 0 ORDER BY p.id DESC`);
    res.json({ success: true, data: pallets.rows });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/cancel-order', async (req, res) => {
  const { order_id } = req.body;
  try {
    const poRes = await pool.query("SELECT * FROM purchase_orders WHERE id = $1", [order_id]);
    if (poRes.rows.length === 0) return res.status(400).json({ success: false });
    const po = poRes.rows[0];
    const diffMins = (new Date() - new Date(po.created_at)) / 60000;
    if (diffMins > 10) return res.status(400).json({ success: false, message: 'The 10-minute cancellation window has expired.' });
    await pool.query("UPDATE pallets SET pallets_available = pallets_available + $1, status = 'available' WHERE id = $2", [po.purchased_pallets, po.pallet_id]);
    await pool.query("DELETE FROM purchase_orders WHERE id = $1", [order_id]);
    res.json({ success: true, message: 'Order voided. Pallets returned to Cooler.' });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/buy-now', async (req, res) => {
  const { buyer_id, pallet_id, appointment_time, buy_pallets } = req.body;
  try {
    // 🔒 EXTREME SECURITY: Backend Compliance Check
    const buyerCheck = await pool.query("SELECT w9_url FROM users WHERE id = $1", [buyer_id]);
    if (!buyerCheck.rows[0] || !buyerCheck.rows[0].w9_url) {
      return res.status(403).json({ success: false, message: '🛑 COMPLIANCE HOLD: Server rejected transaction. W-9 missing.' });
    }

    const palletQuery = await pool.query("SELECT * FROM pallets WHERE id = $1 AND status = 'available'", [pallet_id]);
    if (palletQuery.rows.length === 0) return res.status(400).json({ success: false, message: 'Pallet no longer available.' });
    const pallet = palletQuery.rows[0];
    const requestedPallets = parseInt(buy_pallets) || 1;
    if (pallet.pallets_available < requestedPallets) return res.status(400).json({ success: false, message: 'Not enough pallets remaining.' });
    const purchasedBoxes = requestedPallets * pallet.boxes_per_pallet;
    const poNumber = 'HT-' + Math.floor(Math.random() * 100000);
    const tollFee = (0.35 * purchasedBoxes).toFixed(2); 
    const newAvailable = pallet.pallets_available - requestedPallets;
    const newStatus = newAvailable <= 0 ? 'sold' : 'available';
    await pool.query("UPDATE pallets SET pallets_available = $1, status = $2 WHERE id = $3", [newAvailable, newStatus, pallet.id]);
    await pool.query('INSERT INTO purchase_orders (buyer_id, pallet_id, po_number, sold_price, toll_fee, payment_status, appointment_time, purchased_boxes, purchased_pallets) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [buyer_id, pallet_id, poNumber, pallet.asking_price, tollFee, 'unpaid', appointment_time, purchasedBoxes, requestedPallets]);
    if (newStatus === 'sold') { await pool.query("UPDATE offers SET status = 'rejected' WHERE pallet_id = $1", [pallet.id]); }
    const buyerRes = await pool.query("SELECT * FROM users WHERE id = $1", [buyer_id]);
    const growerRes = await pool.query("SELECT * FROM users WHERE id = $1", [pallet.grower_id]);
    dispatchTransactionEmails(buyerRes.rows[0], growerRes.rows[0], pallet, poNumber, appointment_time, requestedPallets, purchasedBoxes);
    res.json({ success: true, po_number: poNumber });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/offers/make', async (req, res) => {
  const { pallet_id, buyer_id, grower_id, offer_amount, appointment_time, buy_pallets } = req.body;
  const requested_pallets = parseInt(buy_pallets) || 1;
  try {
    // 🔒 EXTREME SECURITY: Backend Compliance Check
    const buyerCheck = await pool.query("SELECT w9_url FROM users WHERE id = $1", [buyer_id]);
    if (!buyerCheck.rows[0] || !buyerCheck.rows[0].w9_url) {
      return res.status(403).json({ success: false, message: '🛑 COMPLIANCE HOLD: Server rejected offer. W-9 missing.' });
    }

    await pool.query("INSERT INTO offers (pallet_id, buyer_id, grower_id, current_offer, last_actor, appointment_time, requested_pallets) VALUES ($1, $2, $3, $4, 'buyer', $5, $6)", [pallet_id, buyer_id, grower_id, offer_amount, appointment_time, requested_pallets]);
    res.json({ success: true, message: 'Offer submitted to grower!' });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/offers/counter', async (req, res) => {
  const { offer_id, new_amount, actor } = req.body;
  try {
    let query = "UPDATE offers SET current_offer = $1, last_actor = $2 WHERE id = $3";
    if (actor === 'grower') { query = "UPDATE offers SET current_offer = $1, last_actor = $2, grower_counter_count = grower_counter_count + 1 WHERE id = $3"; }
    await pool.query(query, [new_amount, actor, offer_id]);
    res.json({ success: true, message: 'Counteroffer sent!' });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/offers/accept', async (req, res) => {
  const { offer_id } = req.body;
  try {
    const offerRes = await pool.query("SELECT * FROM offers WHERE id = $1", [offer_id]);
    const offer = offerRes.rows[0];
    const palletRes = await pool.query("SELECT * FROM pallets WHERE id = $1 AND status = 'available'", [offer.pallet_id]);
    if (palletRes.rows.length === 0) return res.status(400).json({ success: false, message: 'Inventory is no longer available.' });
    const pallet = palletRes.rows[0];
    if (pallet.pallets_available < offer.requested_pallets) return res.status(400).json({ success: false, message: 'Not enough pallets remaining for this offer.'});
    const purchasedBoxes = offer.requested_pallets * pallet.boxes_per_pallet;
    const poNumber = 'HT-' + Math.floor(Math.random() * 100000);
    const tollFee = (0.35 * purchasedBoxes).toFixed(2);
    const newAvailable = pallet.pallets_available - offer.requested_pallets;
    const newStatus = newAvailable <= 0 ? 'sold' : 'available';
    await pool.query("UPDATE pallets SET pallets_available = $1, status = $2 WHERE id = $3", [newAvailable, newStatus, pallet.id]);
    await pool.query('INSERT INTO purchase_orders (buyer_id, pallet_id, po_number, sold_price, toll_fee, payment_status, appointment_time, purchased_boxes, purchased_pallets) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)', [offer.buyer_id, pallet.id, poNumber, offer.current_offer, tollFee, 'unpaid', offer.appointment_time, purchasedBoxes, offer.requested_pallets]);
    await pool.query("UPDATE offers SET status = 'accepted' WHERE id = $1", [offer_id]);
    if (newStatus === 'sold') { await pool.query("UPDATE offers SET status = 'rejected' WHERE pallet_id = $1 AND id != $2", [pallet.id, offer_id]); }
    const buyerRes = await pool.query("SELECT * FROM users WHERE id = $1", [offer.buyer_id]);
    const growerRes = await pool.query("SELECT * FROM users WHERE id = $1", [offer.grower_id]);
    dispatchTransactionEmails(buyerRes.rows[0], growerRes.rows[0], pallet, poNumber, offer.appointment_time, offer.requested_pallets, purchasedBoxes);
    res.json({ success: true, po_number: poNumber });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/offers/reject', async (req, res) => {
  try { await pool.query("UPDATE offers SET status = 'rejected' WHERE id = $1", [req.body.offer_id]); res.json({ success: true, message: 'Offer rejected.' }); } catch (err) { res.status(500).json({ success: false }); }
});

app.get('/api/offers/grower/:id', async (req, res) => {
  try {
    const offers = await pool.query(`SELECT o.*, p.commodity_type, p.variety, p.boxes_per_pallet, p.asking_price, p.payment_terms, u.company_name as buyer_company, u.paca_number FROM offers o JOIN pallets p ON o.pallet_id = p.id JOIN users u ON o.buyer_id = u.id WHERE o.grower_id = $1 AND o.status = 'pending' ORDER BY o.id DESC`, [req.params.id]);
    res.json({ success: true, offers: offers.rows });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.get('/api/offers/buyer/:id', async (req, res) => {
  try {
    const offers = await pool.query(`SELECT o.*, p.commodity_type, p.variety, p.boxes_per_pallet, p.asking_price, p.payment_terms, p.photo_url FROM offers o JOIN pallets p ON o.pallet_id = p.id WHERE o.buyer_id = $1 AND o.status = 'pending' ORDER BY o.id DESC`, [req.params.id]);
    res.json({ success: true, offers: offers.rows });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/create-checkout-session', async (req, res) => {
  const { order_id, total_cost, po_number } = req.body;
  const origin = req.get('origin') || 'http://localhost:5174'; 
  try {
    if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY === 'sk_test_placeholder') {
      return res.json({ success: true, url: `${origin}/?checkout_success=true&order_id=${order_id}` });
    }
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'us_bank_account'], // 🔒 FORT KNOX: Allows secure ACH & Credit Cards
      line_items: [{ price_data: { currency: 'usd', product_data: { name: `PO: ${po_number}`, description: 'The Heavy Terminal Wholesale Inventory' }, unit_amount: Math.round(total_cost * 100) }, quantity: 1 }],
      mode: 'payment',
      metadata: { order_id: order_id }, // 🔒 FORT KNOX: Attaches the Order ID invisibly to the transaction for the Webhook to read
      success_url: `${origin}/?checkout_success=true&order_id=${order_id}`,
      cancel_url: `${origin}/?checkout_cancel=true`,
    });
    res.json({ success: true, url: session.url });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// We completely disable the old "Frontend" confirm route so hackers can't use it.
app.post('/api/confirm-payment', async (req, res) => {
  // Now, this route simply returns success so the frontend stops loading, 
  // but the ACTUAL database update is handled exclusively by the secure Webhook above.
  res.json({ success: true }); 
});

app.post('/api/create-user', async (req, res) => {
  const { email, password, role, company_name, paca_number } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO users (email, password_hash, role, company_name, paca_number) VALUES ($1, $2, $3, $4, $5)', [email, hashedPassword, role, company_name, paca_number]);
    res.json({ success: true, message: 'Account created successfully!' });
  } catch (err) { res.status(500).json({ success: false, message: 'Failed.' }); }
});

app.post('/api/public-signup', async (req, res) => {
  const { email, password, company_name, paca_number } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query("INSERT INTO users (email, password_hash, role, company_name, paca_number) VALUES ($1, $2, 'buyer', $3, $4)", [email, hashedPassword, company_name, paca_number]);
    res.json({ success: true, message: 'Buyer account created!' });
  } catch (err) { res.status(500).json({ success: false, message: 'Failed.' }); }
});

// CLOUD ROUTING: Determines if it gives a Local URL or an AWS Cloud URL
app.post('/api/add-pallet', upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'photo2', maxCount: 1 }]), async (req, res) => {
  const { grower_id, commodity_type, pallets_available, boxes_per_pallet, asking_price, pack_style, weight, variety, location, lat, lon, loading_window, grade, size, payment_terms, storage_temp, brand } = req.body;
  
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  
  // Magic routing: If AWS is active, MulterS3 puts the cloud URL in `req.files['photo'][0].location`. 
  // If Local is active, it puts the filename in `req.files['photo'][0].filename`.
  const photoUrl = (req.files && req.files['photo']) ? (req.files['photo'][0].location || `${baseUrl}/uploads/${req.files['photo'][0].filename}`) : 'https://via.placeholder.com/500?text=No+Box+Photo';
  const photoUrl2 = (req.files && req.files['photo2']) ? (req.files['photo2'][0].location || `${baseUrl}/uploads/${req.files['photo2'][0].filename}`) : null;
  
  const totalBoxes = parseInt(pallets_available) * parseInt(boxes_per_pallet);
  try {
    await pool.query(
      "INSERT INTO pallets (grower_id, commodity_type, quantity_boxes, pallets_available, boxes_per_pallet, asking_price, photo_url, pack_style, weight, variety, location, lat, lon, loading_window, grade, photo_url_2, size, payment_terms, storage_temp, brand, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, 'available')", 
      [grower_id, commodity_type, totalBoxes, pallets_available, boxes_per_pallet, asking_price, photoUrl, pack_style, weight, variety, location, lat || null, lon || null, loading_window, grade, photoUrl2, size, payment_terms, storage_temp, brand]
    );
    res.json({ success: true, message: 'Pallet added to the cooler!' });
  } catch (err) { res.status(500).json({ success: false, message: 'Failed to add pallet.' }); }
});

app.post('/api/upload-doc', upload.single('document'), async (req, res) => {
  const { user_id, doc_type, cert_type } = req.body;
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });
  
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const docUrl = req.file.location || `${baseUrl}/uploads/${req.file.filename}`;
  
  try {
    if (doc_type === 'w9') { await pool.query(`UPDATE users SET w9_url = $1 WHERE id = $2`, [docUrl, user_id]); } 
    else { await pool.query(`UPDATE users SET cert_url = $1, cert_type = $2 WHERE id = $3`, [docUrl, cert_type, user_id]); }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false }); }
});

app.get('/api/admin-listings', async (req, res) => {
  try {
    const listings = await pool.query(`SELECT p.*, u.company_name as grower_company FROM pallets p JOIN users u ON p.grower_id = u.id WHERE p.status = 'available' ORDER BY p.id DESC`);
    res.json({ success: true, listings: listings.rows });
  } catch (err) { res.status(500).json({ success: false }); }
});
app.delete('/api/admin-delete-pallet/:id', async (req, res) => {
  try { await pool.query("DELETE FROM pallets WHERE id = $1", [req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ success: false }); }
});
app.get('/api/grower-dashboard/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // Check if the grower has linked their bank
    const userRes = await pool.query('SELECT stripe_account_id FROM users WHERE id = $1', [id]);
    const stripeAccountId = userRes.rows[0]?.stripe_account_id;

    const pos = await pool.query(`SELECT po.*, p.commodity_type, po.purchased_boxes, po.purchased_pallets FROM purchase_orders po JOIN pallets p ON po.pallet_id = p.id WHERE p.grower_id = $1`, [id]);
    let totalProfit = 0;
    let availableBalance = 0;
    const breakdown = pos.rows.map(po => {
      const fruitRevenue = parseFloat(po.sold_price) * parseInt(po.purchased_boxes);
      totalProfit += fruitRevenue;
      // If the buyer paid, and the grower hasn't cashed it out yet, it goes into the Available Balance!
      if (po.payment_status === 'paid' && po.payout_status !== 'cashed_out') {
         availableBalance += fruitRevenue;
      }
      return { ...po, net_profit: fruitRevenue.toFixed(2) };
    });
    
    // We now send the stripe_account_id back to the frontend!
    res.json({ success: true, stripe_account_id: stripeAccountId, total_net_profit: totalProfit.toFixed(2), available_balance: availableBalance.toFixed(2), pallet_breakdown: breakdown });
  } catch (err) { res.status(500).json({ success: false }); }
});

// NEW: The Stripe Connect Onboarding Route
app.post('/api/stripe/onboard', async (req, res) => {
  const { grower_id } = req.body;
  const origin = req.get('origin') || 'http://localhost:5174'; 
  try {
    const userRes = await pool.query('SELECT * FROM users WHERE id = $1', [grower_id]);
    const user = userRes.rows[0];
    let accountId = user.stripe_account_id;

    // If they don't have a Stripe account yet, create a blank one for them
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        email: user.email,
        capabilities: { transfers: { requested: true } },
        business_type: 'company',
        company: { name: user.company_name }
      });
      accountId = account.id;
      await pool.query('UPDATE users SET stripe_account_id = $1 WHERE id = $2', [accountId, grower_id]);
    }

    // Generate the highly secure, one-time-use setup link
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${origin}/`,
      return_url: `${origin}/`,
      type: 'account_onboarding',
    });

    res.json({ success: true, url: accountLink.url });
  } catch (err) {
    console.error("Stripe Connect Error:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// NEW: The Cash Out Endpoint
app.post('/api/cash-out', async (req, res) => {
  const { grower_id } = req.body;
  try {
    // Mark all available paid funds as cashed out
    await pool.query(`UPDATE purchase_orders SET payout_status = 'cashed_out' WHERE payment_status = 'paid' AND payout_status != 'cashed_out' AND pallet_id IN (SELECT id FROM pallets WHERE grower_id = $1)`, [grower_id]);
    res.json({ success: true, message: 'Funds are on the way to your linked bank account!' });
  } catch (err) { res.status(500).json({ success: false }); }
});
app.get('/api/buyer-orders/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const orders = await pool.query(`
      SELECT po.id, po.po_number, po.sold_price, po.toll_fee, po.payment_status, po.created_at, po.appointment_time, po.purchased_boxes, po.purchased_pallets,
             p.commodity_type, p.brand, p.photo_url, p.photo_url_2, p.location, p.loading_window, p.grade, p.size,
             u.w9_url AS grower_w9, u.cert_url AS grower_cert, u.cert_type
      FROM purchase_orders po 
      JOIN pallets p ON po.pallet_id = p.id 
      JOIN users u ON p.grower_id = u.id
      WHERE po.buyer_id = $1 ORDER BY po.created_at DESC
    `, [id]);
    let totalOwed = 0;
    const formattedOrders = orders.rows.map(o => {
      const fruitCost = parseFloat(o.sold_price) * parseInt(o.purchased_boxes);
      const total = fruitCost + parseFloat(o.toll_fee);
      if (o.payment_status === 'unpaid') { totalOwed += total; }
      return { ...o, total_cost: total.toFixed(2) };
    });
    res.json({ success: true, total_owed: totalOwed.toFixed(2), orders: formattedOrders });
  } catch (err) { res.status(500).json({ success: false }); }
});
app.get('/api/admin-dashboard', async (req, res) => {
  try {
    const result = await pool.query(`SELECT COUNT(*) as total_pallets, COALESCE(SUM(toll_fee), 0) as total_revenue FROM purchase_orders`);
    res.json({ success: true, total_pallets: result.rows[0].total_pallets, total_revenue: parseFloat(result.rows[0].total_revenue).toFixed(2) });
  } catch (err) { res.status(500).json({ success: false }); }
});
app.get('/api/my-docs/:id', async (req, res) => {
  try {
    const user = await pool.query("SELECT w9_url, cert_url, cert_type FROM users WHERE id = $1", [req.params.id]);
    res.json({ success: true, docs: user.rows[0] });
  } catch(err) { res.status(500).json({ success: false }); }
});
app.get('/api/admin-users', async (req, res) => {
  try {
    const users = await pool.query("SELECT id, email, role, company_name, paca_number, w9_url, cert_url, cert_type FROM users ORDER BY id DESC");
    res.json({ success: true, users: users.rows });
  } catch(err) { res.status(500).json({ success: false }); }
});
app.get('/api/my-listings/:id', async (req, res) => {
  try {
    const listings = await pool.query("SELECT * FROM pallets WHERE grower_id = $1 AND status = 'available' AND pallets_available > 0 ORDER BY id DESC", [req.params.id]);
    res.json({ success: true, listings: listings.rows });
  } catch (err) { res.status(500).json({ success: false }); }
});
app.get('/api/admin-orders', async (req, res) => {
  try {
    const orders = await pool.query(`SELECT po.id, po.po_number, po.sold_price, po.toll_fee, po.payment_status, po.created_at, u.company_name as buyer_company, po.purchased_boxes FROM purchase_orders po JOIN users u ON po.buyer_id = u.id JOIN pallets p ON po.pallet_id = p.id WHERE po.payment_status = 'unpaid' ORDER BY po.created_at ASC`);
    const formattedOrders = orders.rows.map(o => {
      const fruitCost = parseFloat(o.sold_price) * parseInt(o.purchased_boxes);
      const total = fruitCost + parseFloat(o.toll_fee);
      return { ...o, total_cost: total.toFixed(2) };
    });
    res.json({ success: true, orders: formattedOrders });
  } catch (err) { res.status(500).json({ success: false }); }
});
app.post('/api/mark-paid', async (req, res) => {
  try { await pool.query(`UPDATE purchase_orders SET payment_status = 'paid' WHERE id = $1`, [req.body.order_id]); res.json({ success: true }); } catch (err) { res.status(500).json({ success: false }); }
});
app.delete('/api/delete-pallet/:id', async (req, res) => {
  try { await pool.query("DELETE FROM pallets WHERE id = $1", [req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ success: false }); }
});
app.put('/api/edit-pallet/:id', async (req, res) => {
  const { pallets_available, asking_price } = req.body;
  try { await pool.query("UPDATE pallets SET pallets_available = $1, asking_price = $2 WHERE id = $3", [pallets_available, asking_price, req.params.id]); res.json({ success: true }); } catch (err) { res.status(500).json({ success: false }); }
});

// ==========================================
// 🛠️ MAGIC DATABASE BUILDER ROUTE (TROJAN HORSE)
// ==========================================
app.get('/api/seed', async (req, res) => {
    try {
        console.log('Dropping old tables...');
        await pool.query('DROP TABLE IF EXISTS offers, purchase_orders, pallets, users CASCADE;');
        
        console.log('Creating users table...');
        await pool.query(`CREATE TABLE users (id SERIAL PRIMARY KEY, email VARCHAR(255) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL, role VARCHAR(50) NOT NULL, company_name VARCHAR(255), paca_number VARCHAR(255), w9_url TEXT, cert_url TEXT, cert_type VARCHAR(100), phone_number TEXT);`);
        
        console.log('Creating pallets table...');
        await pool.query(`CREATE TABLE pallets (id SERIAL PRIMARY KEY, grower_id INTEGER REFERENCES users(id), commodity_type VARCHAR(255), variety VARCHAR(255), brand VARCHAR(255), pack_style VARCHAR(255), weight VARCHAR(255), size VARCHAR(255), pallets_available INTEGER DEFAULT 1, boxes_per_pallet INTEGER DEFAULT 54, quantity_boxes INTEGER, asking_price DECIMAL(10,2), grade VARCHAR(100), payment_terms VARCHAR(100), location VARCHAR(255), lat DECIMAL(10,6), lon DECIMAL(10,6), loading_window VARCHAR(255), storage_temp VARCHAR(100), status VARCHAR(50) DEFAULT 'available', photo_url TEXT, photo_url_2 TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        
        console.log('Creating orders table...');
        await pool.query(`CREATE TABLE purchase_orders (id SERIAL PRIMARY KEY, buyer_id INTEGER REFERENCES users(id), pallet_id INTEGER REFERENCES pallets(id), po_number VARCHAR(255), sold_price DECIMAL(10,2), toll_fee DECIMAL(10,2), total_cost DECIMAL(10,2), purchased_pallets INTEGER DEFAULT 1, purchased_boxes INTEGER DEFAULT 1, payment_status VARCHAR(50) DEFAULT 'unpaid', appointment_time TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        
        console.log('Creating offers table...');
        console.log('Creating invite_requests table...');
        await pool.query(`CREATE TABLE invite_requests (id SERIAL PRIMARY KEY, company_name VARCHAR(255), contact_name VARCHAR(255), email VARCHAR(255), paca_number VARCHAR(255), status VARCHAR(50) DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        await pool.query(`CREATE TABLE offers (id SERIAL PRIMARY KEY, pallet_id INTEGER REFERENCES pallets(id), buyer_id INTEGER REFERENCES users(id), grower_id INTEGER REFERENCES users(id), asking_price DECIMAL(10,2), current_offer DECIMAL(10,2), requested_pallets INTEGER DEFAULT 1, appointment_time TIMESTAMP, status VARCHAR(50) DEFAULT 'pending', last_actor VARCHAR(50), grower_counter_count INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        
        console.log('Creating demo accounts...');
        const hashedPassword = await bcrypt.hash('password123', 10);
        await pool.query(`INSERT INTO users (email, password_hash, role, company_name) VALUES ('admin@heavenly.com', $1, 'admin', 'Heavy Terminal HQ');`, [hashedPassword]);
        await pool.query(`INSERT INTO users (email, password_hash, role, company_name) VALUES ('buyer@test.com', $1, 'buyer', 'Fresh Markets Inc.');`, [hashedPassword]);
        await pool.query(`INSERT INTO users (email, password_hash, role, company_name) VALUES ('grower@test.com', $1, 'grower', 'Heavenly Farms');`, [hashedPassword]);

        res.send('<h1 style="color: green; font-family: sans-serif; text-align: center; margin-top: 50px;">✅ SUCCESS! The Cloud Database is built! Go to your iPhone and log in!</h1>');
    } catch (error) {
        console.error(error);
        res.send(`<h1 style="color: red; font-family: sans-serif; text-align: center; margin-top: 50px;">❌ Error building DB: ${error.message}</h1>`);
    }
});
// ==========================================

const PORT = process.env.PORT || 3000;
// --- GROWER INVITE REQUEST APIS ---
app.post('/api/request-invite', async (req, res) => {
    const { company_name, contact_name, email, paca_number } = req.body;
    try {
        await pool.query(
            `INSERT INTO invite_requests (company_name, contact_name, email, paca_number) VALUES ($1, $2, $3, $4)`,
            [company_name, contact_name, email, paca_number]
        );
        res.json({ success: true });
    } catch (err) {
        console.error("Invite Error:", err);
        res.status(500).json({ success: false, message: 'Database error' });
    }
});

app.get('/api/admin-requests', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM invite_requests WHERE status = 'pending' ORDER BY created_at DESC`);
        res.json({ success: true, requests: result.rows });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin-requests/dismiss', async (req, res) => {
    try {
        await pool.query(`UPDATE invite_requests SET status = 'dismissed' WHERE id = $1`, [req.body.request_id]);
        res.json({ success: true });
    } catch (err) {
        res.json({ success: false });
    }
});
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Heavy Terminal server is running on port ${PORT}`);
});