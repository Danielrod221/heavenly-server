require('dotenv').config(); // This pulls your Cloud URL from your .env file!
const { Pool } = require('pg');
const bcrypt = require('bcrypt');

// ☁️ CONNECT TO THE CLOUD DATABASE
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Required for secure cloud databases
});

async function runSeed() {
  try {
    console.log('☁️ Reaching into the Cloud Database...');
    
    // 1. Wipe old data
    await pool.query('DROP TABLE IF EXISTS offers, purchase_orders, pallets, users CASCADE;');

    // 2. Build Users Table (Upgraded for Compliance Docs)
    console.log('🏗️ Building Users Table...');
    await pool.query(`CREATE TABLE users (
      id SERIAL PRIMARY KEY, 
      email VARCHAR(255) UNIQUE NOT NULL, 
      password_hash VARCHAR(255) NOT NULL, 
      role VARCHAR(50) NOT NULL, 
      company_name VARCHAR(255),
      paca_number VARCHAR(255),
      w9_url TEXT,
      cert_url TEXT,
      cert_type VARCHAR(100)
    );`);

    // 3. Build Pallets Table (Upgraded for Live Map & Specs)
    console.log('🏗️ Building Pallets Table...');
    await pool.query(`CREATE TABLE pallets (
      id SERIAL PRIMARY KEY, 
      grower_id INTEGER REFERENCES users(id), 
      commodity_type VARCHAR(255), 
      variety VARCHAR(255),
      brand VARCHAR(255),
      pack_style VARCHAR(255),
      weight VARCHAR(255),
      size VARCHAR(255),
      pallets_available INTEGER,
      boxes_per_pallet INTEGER,
      quantity_boxes INTEGER,
      asking_price DECIMAL(10,2), 
      grade VARCHAR(100),
      payment_terms VARCHAR(100),
      location VARCHAR(255),
      lat DECIMAL(10,6),
      lon DECIMAL(10,6),
      loading_window VARCHAR(255),
      storage_temp VARCHAR(100),
      status VARCHAR(50) DEFAULT 'available', 
      photo_url TEXT, 
      photo_url_2 TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`);

    // 4. Build Purchase Orders Table
    console.log('🏗️ Building Purchase Orders Table...');
    await pool.query(`CREATE TABLE purchase_orders (
      id SERIAL PRIMARY KEY, 
      buyer_id INTEGER REFERENCES users(id), 
      pallet_id INTEGER REFERENCES pallets(id), 
      po_number VARCHAR(255), 
      total_cost DECIMAL(10,2), 
      purchased_pallets INTEGER,
      purchased_boxes INTEGER,
      payment_status VARCHAR(50) DEFAULT 'unpaid',
      appointment_time TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`);

    // 5. Build Offers Table (For negotiations)
    console.log('🏗️ Building Offers Table...');
    await pool.query(`CREATE TABLE offers (
      id SERIAL PRIMARY KEY,
      pallet_id INTEGER REFERENCES pallets(id),
      buyer_id INTEGER REFERENCES users(id),
      grower_id INTEGER REFERENCES users(id),
      asking_price DECIMAL(10,2),
      current_offer DECIMAL(10,2),
      requested_pallets INTEGER,
      appointment_time TIMESTAMP,
      status VARCHAR(50) DEFAULT 'pending',
      last_actor VARCHAR(50),
      grower_counter_count INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`);

    // 6. Create Default Accounts
    console.log('🔐 Creating Master Admin Account...');
    const hashedPassword = await bcrypt.hash('password123', 10);
    await pool.query(`INSERT INTO users (email, password_hash, role, company_name) VALUES ('admin@heavenly.com', $1, 'admin', 'Heavy Terminal HQ');`, [hashedPassword]);
    
    console.log('👨‍🌾 Creating Demo Users...');
    await pool.query(`INSERT INTO users (email, password_hash, role, company_name) VALUES ('buyer@test.com', $1, 'buyer', 'Fresh Markets Inc.');`, [hashedPassword]);
    const growerRes = await pool.query(`INSERT INTO users (email, password_hash, role, company_name) VALUES ('grower@test.com', $1, 'grower', 'Heavenly Farms') RETURNING id;`, [hashedPassword]);

    // 7. Insert a Test Pallet
    await pool.query(`INSERT INTO pallets (grower_id, commodity_type, variety, pallets_available, boxes_per_pallet, asking_price, location, lat, lon, photo_url) VALUES ($1, 'Peaches', 'Yellow', 2, 60, 24.50, 'Terra Bella, CA', 35.9622, -119.0415, 'https://images.unsplash.com/photo-1629828874514-c1e5103f2150?w=500&q=80');`, [growerRes.rows[0].id]);

    console.log('✅ SUCCESS! Cloud Vault is fully built and ready!');
    process.exit(0);
  } catch (err) { 
    console.error('❌ Error building database:', err); 
    process.exit(1); 
  }
}

runSeed();