const pg = require('pg');
const dotenv = require('dotenv');
dotenv.config({ path: '../.env' });

const pool = new pg.Pool({ 
  connectionString: process.env.DATABASE_URL, 
  ssl: { rejectUnauthorized: false } 
});

async function check() {
  try {
    const res = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'credentials'");
    console.log("COLUMNS:", res.rows.map(r => r.column_name));
    
    const countRes = await pool.query("SELECT count(*) FROM credentials");
    console.log("COUNT:", countRes.rows[0].count);
  } catch (err) {
    console.error("DB ERROR:", err.message);
  } finally {
    await pool.end();
  }
}

check();
