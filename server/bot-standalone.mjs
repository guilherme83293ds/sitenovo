import dotenv from 'dotenv';
dotenv.config();

process.on('uncaughtException', (err) => { try { process.stderr.write('[BOT] UNCAUGHT: ' + err.message + '\n'); } catch(e){} });
process.on('unhandledRejection', (reason) => { try { process.stderr.write('[BOT] UNHANDLED: ' + reason + '\n'); } catch(e){} });

import pg from 'pg';
const { Pool } = pg;

const dbUrls = [
  process.env.DATABASE_URL_1,
  process.env.DATABASE_URL_2,
  process.env.DATABASE_URL_3,
  process.env.DATABASE_URL_4,
  process.env.DATABASE_URL_5
].filter(Boolean);
if (dbUrls.length === 0 && process.env.DATABASE_URL) dbUrls.push(process.env.DATABASE_URL);

if (dbUrls.length === 0) {
  try { process.stderr.write('[BOT] No DB URLs configured\n'); } catch(e){}
  process.exit(0);
}

const pools = dbUrls.map((url, i) => {
  const p = new Pool({
    connectionString: url.replace(/-pooler/, '').replace(/&?channel_binding=require/gi, ''),
    max: 10,
    idleTimeoutMillis: 600000,
    connectionTimeoutMillis: 5000,
    query_timeout: 35000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 1000,
    ssl: { rejectUnauthorized: false }
  });
  p.on('error', () => {});
  return p;
});

class MultiClient {
  constructor(clients) { this.clients = clients; }
  async query(sql, params) {
    if (typeof sql === 'string' && (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK') || sql.startsWith('SET'))) {
      await Promise.all(this.clients.map(c => c.query(sql, params).catch(() => {})));
      return { rows: [] };
    }
    const results = await Promise.all(this.clients.map(c => c.query(sql, params).catch(() => ({ rows: [] }))));
    let allRows = [];
    for (let r of results) { if (r && r.rows) allRows = allRows.concat(r.rows); }
    return { rows: allRows, rowCount: allRows.length };
  }
  release() { this.clients.forEach(c => c.release()); }
}

class MultiPool {
  constructor(poolsArray) { this.pools = poolsArray; }
  async connect() {
    const clients = await Promise.all(this.pools.map(p => p.connect()));
    return new MultiClient(clients);
  }
  async query(sql, params) {
    const results = await Promise.all(this.pools.map(p => p.query(sql, params).catch(() => ({ rows: [] }))));
    let allRows = [];
    for (const r of results) { if (r && r.rows) allRows = allRows.concat(r.rows); }
    return { rows: allRows, rowCount: allRows.length };
  }
}

const botMultiPool = new MultiPool(pools);
const botMultiPoolPublic = new MultiPool(pools.slice(0, pools.length - 1));
const pool = pools[0];

const app = { get: () => {} };
const { setupBot } = await import('./bot.js');

try {
  try { process.stdout.write('[BOT] Starting setup...\n'); } catch(e){}
  setupBot(app, botMultiPool, pool, botMultiPoolPublic);
  try { process.stdout.write('[BOT] Setup complete, polling...\n'); } catch(e){}
} catch (e) {
  try { process.stderr.write('[BOT] Setup error: ' + (e?.message || e) + '\n'); } catch(ee){}
  process.exit(1);
}

// Keep alive
setInterval(() => {}, 30000);
