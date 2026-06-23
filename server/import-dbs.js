import dotenv from 'dotenv';
dotenv.config();
import pg from 'pg';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const { Pool } = pg;

const DB_URL = process.env.DATABASE_URL_6;
if (!DB_URL) { console.error('❌ DATABASE_URL_6 not set'); process.exit(1); }

const BASE_DIR = path.resolve(process.env.DBSOURCE_DIR || 'C:\\Users\\slowx86\\Downloads\\DBSearcher\\DBSearcher\\DBSearcher\\base');
const pool = new Pool({ connectionString: DB_URL, max: 5, idleTimeoutMillis: 60000, connectionTimeoutMillis: 30000, ssl: { rejectUnauthorized: false } });

const BATCH_SIZE = 500;

async function createTable() {
  const client = await pool.connect();
  try {
    await client.query('DROP TABLE IF EXISTS dbs_lines');
    await client.query('CREATE TABLE dbs_lines (id BIGSERIAL PRIMARY KEY, content TEXT NOT NULL, source_file TEXT NOT NULL)');
    console.log('✅ Table dbs_lines created (clean)');
  } finally {
    client.release();
  }
}

async function flushBatch(lines, fileName) {
  if (lines.length === 0) return;
  let attempt = 0;
  while (attempt < 3) {
    try {
      const client = await pool.connect();
      try {
        const placeholders = lines.map((_, i) => `($${i*2+1}, $${i*2+2})`).join(',');
        const values = [];
        for (const line of lines) { values.push(line, fileName); }
        await client.query(`INSERT INTO dbs_lines (content, source_file) VALUES ${placeholders}`, values);
        return;
      } finally {
        client.release();
      }
    } catch (err) {
      attempt++;
      if (attempt >= 3) throw err;
      console.log(`    ⚠ Retry ${attempt}/3 batch (${err.message})`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

async function importFile(filePath, fileName) {
  const fileSize = fs.statSync(filePath).size;
  console.log(`  📄 ${fileName} (${(fileSize/1024/1024).toFixed(1)} MB)`);

  let batch = [];
  let total = 0;
  let isFirstLine = true;

  const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });

  for await (const rawLine of rl) {
    // Skip header on first line for CSVs
    if (isFirstLine && fileName.endsWith('.csv')) {
      isFirstLine = false;
      // Only skip if line looks like a header
      if (rawLine.includes('ID') || rawLine.includes('Username') || rawLine.includes('Telegram') || rawLine.includes('LOGIN') || rawLine.includes('EMAIL')) {
        continue;
      }
    }
    isFirstLine = false;

    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    batch.push(trimmed);
    total++;
    if (batch.length >= BATCH_SIZE) {
      await flushBatch(batch, fileName);
      batch = [];
      if (total % 10000 === 0) process.stdout.write(`    → ${total.toLocaleString()} linhas\r`);
    }
  }

  if (batch.length > 0) await flushBatch(batch, fileName);
  console.log(`    → ${total.toLocaleString()} linhas importadas`);
}

async function main() {
  console.log('🚀 DBSearcher Import Tool\n');
  await createTable();

  const files = fs.readdirSync(BASE_DIR).filter(f => f.endsWith('.csv') || f.endsWith('.txt') || f.endsWith('.sql'));
  console.log(`📁 Found ${files.length} files\n`);

  for (const fileName of files) {
    try {
      await importFile(path.join(BASE_DIR, fileName), fileName);
    } catch (err) {
      console.error(`    ❌ Error on ${fileName}: ${err.message}`);
      // Continue with next file
    }
  }

  console.log('\n✅ Import complete!');
  await pool.end();
}

main().catch(err => { console.error('❌ Fatal:', err); process.exit(1); });
