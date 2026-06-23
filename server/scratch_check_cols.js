require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
async function run() {
  const res = await pool.query('SELECT * FROM credentials LIMIT 1;');
  console.log(res.rows[0]);
  pool.end();
}
run();
