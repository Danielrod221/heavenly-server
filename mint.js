const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
  user: 'melissamunoz', 
  database: 'heavenly_terminal',
  host: 'localhost',
  port: 5433 
});

async function mintAccounts() {
  const hash = await bcrypt.hash('12345', 10);
  
  try {
    // 1. Mint the Master Admin
    await pool.query(`INSERT INTO users (email, password_hash, role, company_name) VALUES ('admin@ht.com', $1, 'admin', 'HT Command')`, [hash]);
    
    // 2. Mint a Verified Grower
    await pool.query(`INSERT INTO users (email, password_hash, role, company_name) VALUES ('grower@ht.com', $1, 'grower', 'Sunview Farms')`, [hash]);
    
    console.log('✅ SUCCESS! Accounts minted.');
    console.log('--------------------------------');
    console.log('👑 ADMIN LOGIN: admin@ht.com (Role: Admin)');
    console.log('🚜 GROWER LOGIN: grower@ht.com (Role: Grower)');
    console.log('🔑 PASSWORD FOR BOTH: 12345');
    console.log('--------------------------------');
  } catch (err) {
    console.log('Oops, something went wrong:', err);
  }
  process.exit();
}

mintAccounts();