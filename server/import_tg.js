import fs from 'fs';
import { Transform, pipeline } from 'stream';
import { createRequire } from 'module';
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();
const { Pool } = pg;
const require = createRequire(import.meta.url);
const copyFrom = require('pg-copy-streams').from;

const dbUrl = process.env.DATABASE_URL_1 || process.env.DATABASE_URL;
if (!dbUrl) { console.error('❌ DATABASE_URL_1 não definida'); process.exit(1); }

const pool = new Pool({ connectionString: dbUrl, max: 1 });
const filePath = process.argv[2] || 'C:\\Users\\slowx86\\Downloads\\telegram.json';

let total = 0;
const start = Date.now();

const transform = new Transform({
  readableObjectMode: false,
  writableObjectMode: false,
  transform(chunk, encoding, callback) {
    const lines = (this._buffer || '') + chunk.toString('utf8');
    const parts = lines.split('\n');
    this._buffer = parts.pop();
    let out = '';
    for (const line of parts) {
      const t = line.trim();
      if (!t) continue;
      total++;
      try {
        const r = JSON.parse(t);
        const esc = (v) => { if (v == null) return '\\N'; const s = String(v).replace(/\\/g,'\\\\').replace(/\t/g,'\\t').replace(/\n/g,'\\n'); return s; };
        const ts = (v) => v ? new Date(v * 1000).toISOString() : '\\N';
        out += `${esc(r.id)}\\t${esc(r.nick)}\\t${esc(r.adapterUserId)}\\t${esc(r.name)}\\t${esc(r.firstName)}\\t${esc(r.lastName)}\\t${esc(r.email)}\\t${esc(r.phone)}\\t${esc(r.unsubscribed)}\\t${esc(r.notes)}\\t${esc(r.ref)}\\t${esc(r.customerId)}\\t${esc(r.spider_type)}\\t${esc(r.spider_operator_id)}\\t${ts(r.spider_last_message_at)}\\t${ts(r.spider_created_at)}\\t${esc(r.nick_userid_md5)}\\n`;
      } catch(e) { /* pula linha inválida */ }
    }
    callback(null, out);
  }
});

console.log('🚀 Importando telegram.json via COPY...');
console.log('📁', filePath);
console.log('🗄️', dbUrl.replace(/\/\/[^:]+:([^@]+)@/, '//****:****@'));

const client = await pool.connect();
try {
  const ingest = client.query(copyFrom(`COPY telegram_contacts (internal_id,nick,adapter_user_id,name,first_name,last_name,email,phone,unsubscribed,notes,ref,customer_id,spider_type,spider_operator_id,spider_last_message_at,spider_created_at,nick_userid_md5) FROM STDIN WITH (FORMAT text, NULL '\\N')`));
  await new Promise((resolve, reject) => {
    pipeline(
      fs.createReadStream(filePath, { highWaterMark: 4 * 1024 * 1024 }),
      transform,
      ingest,
      (err) => err ? reject(err) : resolve()
    );
  });
  console.log(`✅ Importado: ${total.toLocaleString()} registros em ${((Date.now()-start)/1000).toFixed(0)}s`);
  pool.end();
} catch (err) {
  console.error('❌ Erro:', err.message);
  pool.end();
}
