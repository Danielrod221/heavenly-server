const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
  user: 'melissamunoz', 
  database: 'heavenly_terminal', 
  host: 'localhost', 
  port: 5433
});

async function runSeed() {
  try {
    console.log('🏗️ Rebuilding the Vault with Admin access...');
    await pool.query('DROP TABLE IF EXISTS purchase_orders, pallets, users CASCADE;');

    await pool.query(`CREATE TABLE users (id SERIAL PRIMARY KEY, email VARCHAR(255) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL, role VARCHAR(50) NOT NULL, company_name VARCHAR(255));`);
    await pool.query(`CREATE TABLE pallets (id SERIAL PRIMARY KEY, grower_id INTEGER REFERENCES users(id), commodity_type VARCHAR(255), quantity_boxes INTEGER, asking_price DECIMAL(10,2), status VARCHAR(50) DEFAULT 'available', photo_url TEXT, packed_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
    await pool.query(`CREATE TABLE purchase_orders (id SERIAL PRIMARY KEY, buyer_id INTEGER REFERENCES users(id), pallet_id INTEGER REFERENCES pallets(id), po_number VARCHAR(255), sold_price DECIMAL(10,2), toll_fee DECIMAL(10,2), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);

    const hashedPassword = await bcrypt.hash('password123', 10);
    
    // THE SECRET ADMIN ACCOUNT
    await pool.query(`INSERT INTO users (email, password_hash, role, company_name) VALUES ('admin@heavenly.com', $1, 'admin', 'Heavenly Terminal HQ');`, [hashedPassword]);
    
    // Regular users
    const buyerRes = await pool.query(`INSERT INTO users (email, password_hash, role, company_name) VALUES ('buyer@test.com', $1, 'buyer', 'Fresh Markets Inc.') RETURNING id;`, [hashedPassword]);
    const growerRes = await pool.query(`INSERT INTO users (email, password_hash, role, company_name) VALUES ('grower@test.com', $1, 'grower', 'Heavenly Farms') RETURNING id;`, [hashedPassword]);

    await pool.query(`INSERT INTO pallets (grower_id, commodity_type, quantity_boxes, asking_price, status, photo_url) VALUES ($1, 'Yellow Peaches (Size 40)', 60, 1800.00, 'available', 'https://images.unsplash.com/photo-1629828874514-c1e5103f2150?w=500&q=80');`, [growerRes.rows[0].id]);

    console.log('✅ Success! The Admin account is created.');
    process.exit(0);
  } catch (err) { console.error('❌ Error:', err); process.exit(1); }
}

runSeed();