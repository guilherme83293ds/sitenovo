import dotenv from 'dotenv';
dotenv.config();

// WAF/Turnstile removido

// ══════════════════════════════════════════════════════
// ANTI-CRASH GLOBAL (Ignora erros e mantem o servidor vivo)
// ══════════════════════════════════════════════════════
process.on('uncaughtException', (err) => {
  console.error('🔥 [ANTI-CRASH] Erro Fatal Ignorado:', err.message);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('🔥 [ANTI-CRASH] Promessa Rejeitada Ignorada:', reason);
});

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import readline from 'readline';
import https from 'https';
import http from 'http';
import crypto from 'crypto';
import { setGlobalDispatcher, Agent as UndiciAgent } from 'undici';

// Aumenta pool de conexões HTTP para máximo throughput
setGlobalDispatcher(new UndiciAgent({
  connections: 100,
  keepAliveTimeout: 60000,
  keepAliveMaxTimeout: 60000,
}));
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import cors from 'cors';
import pg from 'pg';
import { setupBot, handlePaymentSuccess, isMaintenance } from './bot.js';
import { querySIPNI, authenticateSIPNI } from './sipni-api.js';
import Stripe from 'stripe';

const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = stripeKey && stripeKey !== 'sua_chave_secreta_stripe' ? new Stripe(stripeKey) : null;

import { Readable } from 'stream';
import QueryStream from 'pg-query-stream';
import pgCopyStreams from 'pg-copy-streams';
const { from: copyFrom } = pgCopyStreams;
import { createRequire } from 'module';
const archiver = createRequire(import.meta.url)('archiver');
import zlib from 'zlib';

const { Pool } = pg;

// ══════════════════════════════════════════════════════
// MULTI-DB POOL (Neon) — BUSCA em TODOS os bancos
// ══════════════════════════════════════════════════════
const dbUrls = [
  process.env.DATABASE_URL_1,
  process.env.DATABASE_URL_2,
  process.env.DATABASE_URL_3,
  process.env.DATABASE_URL_4,
  process.env.DATABASE_URL_5
].filter(Boolean);

// Fallback caso alguém rode com DATABASE_URL normal ainda
if (dbUrls.length === 0 && process.env.DATABASE_URL) {
  dbUrls.push(process.env.DATABASE_URL);
}

// Cria os pools para cada banco (usados para BUSCA)
const pools = dbUrls.map((url, i) => {
  // Remove pooler + channel_binding — conexão direta, mais rápida
  const directUrl = url.replace(/-pooler/, '').replace(/&?channel_binding=require/gi, '');
  const p = new Pool({
    connectionString: directUrl,
    max: 20,
    idleTimeoutMillis: 600000,
    connectionTimeoutMillis: 5000,
    query_timeout: 35000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 1000,
    ssl: { rejectUnauthorized: false }
  });
  p.on('error', (err) => console.error(`⚠️ [DB POOL ${i+1} ERROR]`, err.message));
  return p;
});

// O primeiro pool será usado como "principal" para auth e migracoes locais
const pool = pools[0];

// Array de pools que será passado pro bot para pesquisas simultâneas
const botPools = pools;



// ══════════════════════════════════════════════════════
// AUTO-MIGRATE + STARTUP
// ══════════════════════════════════════════════════════
async function migrate() {
  for (let i = 0; i < pools.length; i++) {
    const currentPool = pools[i];
    try {
      await currentPool.query(`
        CREATE TABLE IF NOT EXISTS credentials (
          id          BIGSERIAL PRIMARY KEY,
          url         TEXT,
          email       TEXT,
          senha       TEXT,
          telefone    TEXT,
          fonte       TEXT,
          dedupe_hash CHAR(32)
        )
      `);
      await currentPool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id             BIGSERIAL PRIMARY KEY,
          email          TEXT UNIQUE NOT NULL,
          password       CHAR(64) NOT NULL,
          display_name   TEXT,
          avatar_url     TEXT,
          two_factor_secret TEXT,
          two_factor_enabled BOOLEAN DEFAULT false,
          two_factor_method TEXT DEFAULT 'authenticator',
          two_factor_temp_code TEXT,
          two_factor_temp_expires TIMESTAMPTZ,
          trial_searches INT DEFAULT 0,
          premium_until  TIMESTAMPTZ,
          telegram_id    BIGINT UNIQUE,
          created_at     TIMESTAMPTZ DEFAULT now()
        )
      `);
      // Em caso de tabela antiga sem as colunas
      const alterQueries = [
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_searches INT DEFAULT 0;`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_until TIMESTAMPTZ;`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id BIGINT UNIQUE;`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_secret TEXT;`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN DEFAULT false;`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_method TEXT DEFAULT 'authenticator';`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_temp_code TEXT;`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_temp_expires TIMESTAMPTZ;`,
        `ALTER TABLE users ADD COLUMN IF NOT EXISTS max_results INT DEFAULT 100;`
      ];
      for (const q of alterQueries) {
        try { await currentPool.query(q); } catch (e) {}
      }
      await currentPool.query(`
        CREATE TABLE IF NOT EXISTS scam_reports (
          id              BIGSERIAL PRIMARY KEY,
          reporter_id     BIGINT NOT NULL,
          reporter_user   TEXT,
          reported_user   TEXT NOT NULL,
          reason          TEXT,
          chat_id         BIGINT,
          created_at      TIMESTAMPTZ DEFAULT now()
        )
      `);
      // Tabelas de licença/trial — só no pool principal (i === 0)
      if (i === 0) {
        await currentPool.query(`
          CREATE TABLE IF NOT EXISTS license_keys (
            id           BIGSERIAL PRIMARY KEY,
            key          TEXT UNIQUE NOT NULL,
            telegram_id  BIGINT,
            user_id      BIGINT,
            activated_at TIMESTAMPTZ,
            expires_days INT,
            expires_at   TIMESTAMPTZ,
            duration_seconds INT,
            created_at   TIMESTAMPTZ DEFAULT now()
          )
        `);
        try { await currentPool.query(`ALTER TABLE license_keys ADD COLUMN user_id BIGINT;`); } catch {}
        try { await currentPool.query(`ALTER TABLE license_keys ADD COLUMN duration_seconds INT;`); } catch {}
        // Colunas de expiração se não existirem
        await currentPool.query(`ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS expires_days INT`).catch(() => {});
        await currentPool.query(`ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`).catch(() => {});
        await currentPool.query(`ALTER TABLE license_keys ADD COLUMN IF NOT EXISTS duration_seconds BIGINT`).catch(() => {});
        await currentPool.query(`
          CREATE TABLE IF NOT EXISTS bot_trials (
            id           BIGSERIAL PRIMARY KEY,
            telegram_id  BIGINT UNIQUE NOT NULL,
            searches     INT DEFAULT 0,
            created_at   TIMESTAMPTZ DEFAULT now()
          )
        `);
      }
      const pgTrgm = await currentPool.query(`SELECT 1 FROM pg_extension WHERE extname='pg_trgm'`).catch(() => ({ rows: [] }));
      if (pgTrgm.rows.length === 0) {
        await currentPool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`).catch(e => console.warn(`⚠️ [DB ${i+1}] pg_trgm indisponível: ${e.message}`));
      }
      const idxRows = await currentPool.query(`SELECT indexname FROM pg_indexes WHERE indexname LIKE 'idx_%_trgm'`).catch(() => ({ rows: [] }));
      const existingIdx = new Set(idxRows.rows.map(r => r.indexname));
      const indexes = [
        { name: 'idx_url_trgm', col: 'url' },
        { name: 'idx_email_trgm', col: 'email' },
        { name: 'idx_senha_trgm', col: 'senha' },
        { name: 'idx_telefone_trgm', col: 'telefone' }
      ];
      for (const idx of indexes) {
        if (!existingIdx.has(idx.name)) {
          await currentPool.query(`SET statement_timeout = '3600s'`);
          const r = await currentPool.query(`CREATE INDEX CONCURRENTLY ${idx.name} ON credentials USING GIN (${idx.col} gin_trgm_ops)`).catch(e => e);
          if (r?.message) console.warn(`⚠️ [DB ${i+1}] Falha idx ${idx.name}: ${r.message}`);
          else console.log(`✅ [DB ${i+1}] Índice ${idx.name} criado`);
        } else {
          console.log(`✅ [DB ${i+1}] Índice ${idx.name} já existe`);
        }
      }
      console.log(`✅ [MIGRATE DB ${i+1}/${pools.length}] Schema OK`);
    } catch (e) {
      console.error(`❌ [MIGRATE ERROR DB ${i+1}]`, e.message);
    }
  }
}
migrate();

const app = express();

// Sem WAF/proxy

app.post('/api/organize', async (req, res) => {
  res.json({ success: true, message: "Indices ja existem - nada a fazer" });
});

app.use(cors({ origin: '*', exposedHeaders: ['Content-Disposition'] }));

// ── API SIPNI LOCAL (Cache + Rápida) ──
app.post('/api/sipni/consulta', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const { tipo, valor } = req.body;
    
    if (!tipo || !valor) {
      return res.status(400).json({ error: 'Parâmetros tipo e valor são obrigatórios' });
    }

    // Mapeia tipos de consulta para endpoints apisbrasilpro
    const endpointMap = {
      cpf:      { endpoint: 'consulta/cpf',      param: 'cpf' },
      nome:     { endpoint: 'consulta/nome',     param: 'nome' },
      mae:      { endpoint: 'consulta/mae',      param: 'mae' },
      pai:      { endpoint: 'consulta/pai',      param: 'pai' },
      rg:       { endpoint: 'consulta/rg',       param: 'rg' },
      tel:      { endpoint: 'consulta/tel',      param: 'tel' },
      sit_cpf:  { endpoint: 'consulta/situacao', param: 'cpf' },
      titulo:   { endpoint: 'consulta/titulo',   param: 'titulo' },
    };

    const config = endpointMap[tipo];
    if (!config) {
      return res.status(400).json({ error: `Tipo de consulta inválido: ${tipo}` });
    }

    // Faz a consulta SIPNI
    const result = await querySIPNI(config.endpoint, { [config.param]: valor });
    
    res.json({
      success: true,
      tipo,
      valor,
      resultado: result
    });
  } catch (error) {
    console.error('❌ [API] SIPNI Error:', error.message);
    res.status(500).json({
      error: 'Erro ao consultar SIPNI',
      message: error.message
    });
  }
});

// ── Healthcheck SIPNI ──
app.get('/api/sipni/health', async (req, res) => {
  try {
    await authenticateSIPNI();
    res.json({ status: 'ok', sipni: 'connected' });
  } catch (error) {
    res.status(503).json({ status: 'error', sipni: 'disconnected', message: error.message });
  }
});

// ── MODO MANUTENÇÃO — bloqueia acesso ao site ──
app.use((req, res, next) => {
  if (isMaintenance() && !req.url.startsWith('/api/health')) {
    return res.status(503).json({
      error: 'SITE EM MANUTENÇÃO',
      message: 'O site está temporariamente fora do ar para atualizações. Tente novamente em alguns minutos.'
    });
  }
  next();
});

// O express.json() para todas as rotas API
const skipJsonParse = (req, res, next) => {
  if (req.url === '/api/upload-stream') return next();
  express.json({ limit: '50mb' })(req, res, next);
};
app.use(skipJsonParse);

import osintgramRouter from './osintgram-runner.js';
osintgramRouter(app);
import subkillerRouter from './subkiller-runner.js';
subkillerRouter(app);

import { formatText } from './hudsonrock-api.js';

app.post('/api/hudsonrock', async (req, res) => {
  try {
    const { type, value } = req.body || {};
    if (!type || !value) {
      return res.status(400).json({ error: 'Parâmetros type e value são obrigatórios' });
    }
    if (!['email', 'username'].includes(type)) {
      return res.status(400).json({ error: 'Type deve ser "email" ou "username"' });
    }
    const result = await formatText(type, value);
    res.json({ success: true, type, value, result });
  } catch (err) {
    console.error('[HUDSONROCK API ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/hudsonrock', async (req, res) => {
  try {
    const { type = 'email', value = '' } = req.query;
    if (!type || !value) {
      return res.status(400).json({ error: 'Parâmetros type e value são obrigatórios' });
    }
    if (!['email', 'username'].includes(type)) {
      return res.status(400).json({ error: 'Type deve ser "email" ou "username"' });
    }
    const result = await formatText(type, value);
    res.json({ success: true, type, value, result });
  } catch (err) {
    console.error('[HUDSONROCK API ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[API] ${req.method} ${req.url} ${res.statusCode} - ${Date.now() - start}ms`);
  });
  next();
});

class MultiClient {
  constructor(clients) {
    this.clients = clients;
  }
  async query(sql, params) {
    // Se a query for apenas BEGIN/COMMIT/ROLLBACK/SET LOCAL, roda e ignora retorno de rows
    if (typeof sql === 'string' && (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK') || sql.startsWith('SET'))) {
      await Promise.all(this.clients.map(c => c.query(sql, params).catch(() => {})));
      return { rows: [] };
    }

    // Para buscas reais, roda em paralelo em todos os bancos
    const results = await Promise.all(
      this.clients.map(c => c.query(sql, params).catch(e => {
        console.error('MultiClient DB Error:', e.message);
        return { rows: [] }; // Ignora erro individual para o bot não parar
      }))
    );
    
    // Unifica e retorna tudo
    let allRows = [];
    for (let r of results) {
      if (r && r.rows) {
        allRows = allRows.concat(r.rows);
      }
    }
    return { rows: allRows, command: 'SELECT', rowCount: allRows.length };
  }
  release() {
    this.clients.forEach(c => c.release());
  }
}

class MultiPool {
  constructor(poolsArray) {
    this.pools = poolsArray;
  }
  async connect() {
    const clients = await Promise.all(this.pools.map(p => p.connect()));
    return new MultiClient(clients);
  }
  // Query paralela simplificada — pool.query direto, sem SET overhead
  async query(sql, params) {
    const results = await Promise.all(
      this.pools.map(p => p.query(sql, params).catch(e => {
        if (e.code !== '57014') console.warn('MultiPool DB:', e.message);
        return { rows: [] };
      }))
    );
    let allRows = [];
    for (const r of results) {
      if (r && r.rows) allRows = allRows.concat(r.rows);
    }
    return { rows: allRows, rowCount: allRows.length };
  }
}

const botMultiPool = new MultiPool(botPools);
const botMultiPoolPublic = new MultiPool(botPools.slice(0, botPools.length - 1));
if (process.env.DISABLE_TELEGRAM_BOT !== 'true') {
  setupBot(app, botMultiPool, pool, botMultiPoolPublic);
} else {
  console.log('🤖 [BOT] Desativado via DISABLE_TELEGRAM_BOT=true');
}

// Cria índices B-tree em background (exact match = instantâneo) — paralelo nos 4 DBs
setTimeout(async () => {
  const btreeIndexes = [
    { name: 'idx_url_btree', col: 'url' },
    { name: 'idx_email_btree', col: 'email' },
    { name: 'idx_senha_btree', col: 'senha' },
    { name: 'idx_telefone_btree', col: 'telefone' }
  ];
  await Promise.all(pools.map(async (pool, i) => {
    for (const idx of btreeIndexes) {
      try {
        const client = await pools[i].connect();
        try {
          await client.query(`SET statement_timeout = '28800000'`);
          const exists = await client.query(`SELECT 1 FROM pg_indexes WHERE indexname='${idx.name}'`);
          if (exists.rows.length === 0) {
            console.log(`⏳ [DB ${i+1}] Criando ${idx.name}...`);
            await client.query(`CREATE INDEX CONCURRENTLY ${idx.name} ON credentials (${idx.col})`);
            console.log(`✅ [DB ${i+1}] ${idx.name} criado`);
          }
        } finally { client.release(); }
      } catch (e) {
        const skip = e.code === '57014' || e.message?.includes('timeout');
        if (!skip) console.warn(`⚠️ [DB ${i+1}] ${idx.name}: ${e.message}`);
      }
    }
  }));
}, 5000);

// ══════════════════════════════════════════════════════
// HEALTH & STATS
// ══════════════════════════════════════════════════════
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Keep-alive: pinga a si mesmo a cada 4 min para evitar cold start
setInterval(() => {
  const url = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  const mod = url.startsWith('https') ? https : http;
  mod.get(`${url}/api/health`, () => {}).on('error', () => {});
}, 4 * 60 * 1000);

// DB keep-alive: mantém os 4 pools Neon acordados a cada 3 min
setInterval(() => {
  for (const p of pools) {
    p.query('SELECT 1').catch(() => {});
  }
}, 3 * 60 * 1000);

// DB warm-up: aquece todas as conexões na inicialização
(async () => {
  for (let i = 0; i < pools.length; i++) {
    try {
      await pools[i].query('SELECT 1');
      console.log(`🔥 [WARM-UP] Pool ${i+1} aquecido`);
    } catch (e) {
      console.error(`⚠️ [WARM-UP] Pool ${i+1} falhou:`, e.message);
    }
  }
})();

app.get('/api/db-status', async (req, res) => {
  try {
    const dbs = [];
    let total = 0;
    for (let i = 0; i < botPools.length; i++) {
      const p = botPools[i];
      const r = await p.query(`SELECT reltuples::bigint AS count FROM pg_class WHERE relname = 'credentials'`);
      const count = parseInt(r.rows[0]?.count || 0);
      dbs.push({ db: i + 1, count });
      total += count;
    }
    res.json({ databases: dbs, total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/db-analyze', async (req, res) => {
  const auth = req.headers['authorization'];
  if (auth !== 'Bearer breachdb-admin-2025') return res.status(401).json({ error: 'Unauthorized' });
  try {
    for (let i = 0; i < botPools.length; i++) {
      await botPools[i].query('ANALYZE credentials');
    }
    res.json({ status: 'ok', message: 'ANALYZE executado em todos os databases' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});



app.get('/api/stats', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    // Consulta rápida via pg_class (muito mais rápido que COUNT(*))
    const p = botPools[0];
    const tr = await p.query(`SELECT sum(reltuples)::bigint AS count FROM pg_class WHERE relname = 'credentials'`).catch(() => ({ rows: [{ count: 0 }] }));
    const baseCount = parseInt(tr.rows[0]?.count || 0);
    const total = baseCount > 0 ? baseCount * botPools.length : 124508930; // Fallback demonstrativo se as stats falharem
    
    // Estimativa instantânea para dados diários
    const today = Math.floor(total * 0.0015);
    const sources = [
      { name: 'stealer_logs', count: Math.floor(total * 0.4) },
      { name: 'combolists', count: Math.floor(total * 0.3) },
      { name: 'databreaches', count: Math.floor(total * 0.2) }
    ];
    
    res.json({ total, today, sources });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
// PUBLIC SEARCH — wrapper para o site BreachDB
// Aceita: ?field=url|email|user|telefone|senha|inurl|inmail&value=X
// Retorna até 100 resultados (100k para premium via header X-Premium-Key)
// ══════════════════════════════════════════════════════
app.get('/api/public-search', authMiddleware, async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const { field = 'url', value = '' } = req.query;
  const v = String(value).trim();
  if (!v || v.length < 1) return res.json({ success: false, results: [], total: 0, error: 'value_required' });

  const f = String(field).toLowerCase();
  
  // Check Premium Status
  const isPremium = req.user.premium_until && new Date(req.user.premium_until) > new Date();
  
  const limit = 500000;

  try {
    const cols = `url, email, senha, telefone, fonte`;
    let query, params = [];
    const govFilter = '';
    
    // Exact matches for extreme speed, ILIKE for specific 'in...' fields
    if (f === 'url')      { const domain = v.replace(/^https?:\/\//i, '').replace(/^www\./i, ''); query = `SELECT ${cols} FROM credentials WHERE url LIKE $1 OR url LIKE $2 OR url LIKE $3 OR url LIKE $4 OR url LIKE $5 ${govFilter} LIMIT $6`; params = [`http://${domain}%`, `https://${domain}%`, `http://www.${domain}%`, `https://www.${domain}%`, `${domain}%`, limit]; }
    else if (f === 'email')    { query = `SELECT ${cols} FROM credentials WHERE email = $1 ${govFilter} LIMIT $2`;    params = [v, limit]; }
    else if (f === 'user')     { query = `SELECT ${cols} FROM credentials WHERE email LIKE $1 ${govFilter} LIMIT $2`;    params = [`${v}%`, limit]; }
    else if (f === 'senha')    { query = `SELECT ${cols} FROM credentials WHERE senha = $1 ${govFilter} LIMIT $2`;    params = [v, limit]; }
    else if (f === 'telefone') { query = `SELECT ${cols} FROM credentials WHERE telefone = $1 ${govFilter} LIMIT $2`; params = [v, limit]; }
    else if (f === 'inurl')    { query = `SELECT ${cols} FROM credentials WHERE url ILIKE $1 ${govFilter} LIMIT $2`;      params = [`%${v}%`, limit]; }
    else if (f === 'inmail')   { query = `SELECT ${cols} FROM credentials WHERE email ILIKE $1 ${govFilter} LIMIT $2`;    params = [`%${v}%`, limit]; }
    else if (f === 'ip')      { query = `SELECT ${cols} FROM credentials WHERE url ILIKE $1 ${govFilter} LIMIT $2`;      params = [`%${v}%`, limit]; }
    else if (f === 'ftp')     { const term = v || 'ftp://'; query = `SELECT ${cols} FROM credentials WHERE url ILIKE $1 ${govFilter} LIMIT $2`; params = [`%${term}%`, limit]; }
    else if (f === 'smtp')    { const term = v || 'smtp'; query = `SELECT ${cols} FROM credentials WHERE url ILIKE $1 ${govFilter} LIMIT $2`; params = [`%${term}%`, limit]; }
    else if (f === 'mysql')   { const term = v || ':3306'; query = `SELECT ${cols} FROM credentials WHERE url ILIKE $1 ${govFilter} LIMIT $2`; params = [`%${term}%`, limit]; }
    else if (f === 'port8080'){ const term = v || ':8080'; query = `SELECT ${cols} FROM credentials WHERE url ILIKE $1 ${govFilter} LIMIT $2`; params = [`%${term}%`, limit]; }
    else if (f === 'port8443'){ const term = v || ':8443'; query = `SELECT ${cols} FROM credentials WHERE url ILIKE $1 ${govFilter} LIMIT $2`; params = [`%${term}%`, limit]; }
    else if (f === 'copiar_site') { const domain = v.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0]; query = `SELECT ${cols} FROM credentials WHERE url LIKE $1 OR url LIKE $2 OR url LIKE $3 OR url LIKE $4 OR url LIKE $5 ${govFilter} LIMIT $6`; params = [`http://${domain}%`, `https://${domain}%`, `http://www.${domain}%`, `https://www.${domain}%`, `${domain}%`, limit]; }
    else { query = `SELECT ${cols} FROM credentials WHERE email = $1 ${govFilter} LIMIT $2`; params = [v, limit]; }

    const r = await botMultiPool.query(query, params);
    // Dedup igual ao bot: por id ou url|email|senha
    const seen = new Set();
    const deduped = [];
    for (const row of r.rows) {
      const key = `${row.url}|${row.email}|${row.senha}`;
      if (!row.url || seen.has(key)) continue;
      seen.add(key);
      deduped.push(row);
      if (deduped.length >= limit) break;
    }
    const rows = deduped.map((row, i) => {
      const { fonte, ...rest } = row;
      return { ...rest, numero: i + 1 };
    });
    return res.json({ success: true, results: rows, total: rows.length, limited: rows.length >= limit && !isPremium, source: 'merge' });
  } catch (err) {
    console.error('public-search error:', err.message);
    return res.status(500).json({ success: false, results: [], total: 0, error: err.message });
  }
});



// ══════════════════════════════════════════════════════
// DOMAIN INFO (stats sobre um domínio)
// ══════════════════════════════════════════════════════
app.get('/api/domain-info', authMiddleware, async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const { value = '' } = req.query;
  const v = String(value).trim();
  if (!v || v.length < 3) return res.json({ success: false, error: 'Mínimo 3 caracteres' });

  try {
    const r = await botMultiPool.query(
      `SELECT COUNT(*) as total, COUNT(DISTINCT email) as unique_emails, COUNT(DISTINCT senha) as unique_pass, COUNT(DISTINCT telefone) as unique_phones FROM credentials WHERE url ILIKE $1`,
      [`%${v}%`]
    );
    const total = r.rows.reduce((s, row) => s + parseInt(row.total) || 0, 0);
    const unique_emails = r.rows.reduce((s, row) => s + parseInt(row.unique_emails) || 0, 0);
    const unique_pass = r.rows.reduce((s, row) => s + parseInt(row.unique_pass) || 0, 0);
    const unique_phones = r.rows.reduce((s, row) => s + parseInt(row.unique_phones) || 0, 0);

    const topRes = await botMultiPool.query(
      `SELECT email, COUNT(*) as c FROM credentials WHERE url ILIKE $1 AND email IS NOT NULL AND email != '' GROUP BY email ORDER BY c DESC LIMIT 10`,
      [`%${v}%`]
    );
    const topEmails = [];
    const seenEmails = new Set();
    for (const row of topRes.rows) {
      const key = row.email.toLowerCase();
      if (seenEmails.has(key)) continue;
      seenEmails.add(key);
      topEmails.push({ email: row.email, count: parseInt(row.c) });
    }

    return res.json({ success: true, domain: v, total, unique_emails, unique_pass, unique_phones, topEmails });
  } catch (err) {
    console.error('domain-info error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});


// ══════════════════════════════════════════════════════
// SUBDOMÍNIOS (busca de subdomínios no banco)
// ══════════════════════════════════════════════════════
app.get('/api/subdomains', authMiddleware, async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const { value = '' } = req.query;
  const v = String(value).trim();
  if (!v || v.length < 3) return res.json({ success: false, error: 'Mínimo 3 caracteres' });

  try {
    const r = await botMultiPool.query(
      `SELECT url, email, senha FROM credentials WHERE url ILIKE $1 LIMIT 20000`,
      [`%${v}%`]
    );
    const domainMap = new Map();
    for (const row of r.rows) {
      if (!row.url) continue;
      try {
        const hostname = new URL(row.url.startsWith('http') ? row.url : `https://${row.url}`).hostname;
        if (!domainMap.has(hostname)) domainMap.set(hostname, []);
        domainMap.get(hostname).push(row);
      } catch {}
    }
    const subdomains = [...domainMap.entries()].map(([host, rows]) => {
      const seen = new Set();
      const unique = [];
      for (const row of rows) {
        const key = `${row.email}|${row.senha}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(row);
      }
      return { host, count: unique.length, rows: unique };
    }).sort((a, b) => b.count - a.count);

    return res.json({ success: true, domain: v, total: subdomains.length, subdomains });
  } catch (err) {
    console.error('subdomains error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});


// ══════════════════════════════════════════════════════
// WHOIS (busca por telefone — OSINT)
// ══════════════════════════════════════════════════════
app.get('/api/whois', authMiddleware, async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const { value = '' } = req.query;
  const phone = String(value).replace(/[^\d]/g, '');
  if (!phone || phone.length < 7) return res.json({ success: false, error: 'Mínimo 7 dígitos' });

  try {
    const r = await botMultiPool.query(
      `SELECT url, email, senha, telefone, fonte FROM credentials WHERE telefone ILIKE $1 LIMIT 500`,
      [`%${phone}%`]
    );
    const emails = new Set();
    const sites = new Set();
    const passwords = new Set();
    const rows = [];
    const seen = new Set();

    for (const row of r.rows) {
      if (row.email) emails.add(row.email);
      if (row.url) {
        try { sites.add(new URL(row.url.startsWith('http') ? row.url : `https://${row.url}`).hostname); } catch {}
      }
      if (row.senha) passwords.add(row.senha);
      const key = `${row.url}|${row.email}|${row.senha}`;
      if (!seen.has(key)) { seen.add(key); rows.push(row); }
    }

    return res.json({
      success: true, phone, total: rows.length,
      emails: [...emails].slice(0, 50),
      sites: [...sites].slice(0, 30),
      passwords: [...passwords].slice(0, 20),
      results: rows.map((row, i) => ({ ...row, numero: i + 1 }))
    });
  } catch (err) {
    console.error('whois error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});


// ══════════════════════════════════════════════════════
// GEOIP (geolocalização via ip-api.com)
// ══════════════════════════════════════════════════════
app.get('/api/geoip', authMiddleware, async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  const { value = '' } = req.query;
  const target = String(value).trim();
  if (!target || target.length < 3) return res.json({ success: false, error: 'Mínimo 3 caracteres' });

  try {
    let ip = target;
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(target)) {
      const dns = await import('dns');
      const addresses = await dns.promises.resolve4(target);
      if (!addresses.length) return res.json({ success: false, error: 'DNS não resolveu' });
      ip = addresses[0];
    }
    const fetch = (await import('node-fetch')).default;
    const r = await fetch(`http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,hosting,query`);
    const data = await r.json();
    if (data.status !== 'success') return res.json({ success: false, error: data.message || 'Falha na geolocalização' });

    return res.json({ success: true, target, ip: data.query, country: data.country, countryCode: data.countryCode, region: data.regionName, city: data.city, zip: data.zip, lat: data.lat, lon: data.lon, timezone: data.timezone, isp: data.isp, org: data.org, as: data.as, hosting: data.hosting });
  } catch (err) {
    console.error('geoip error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});


// ══════════════════════════════════════════════════════
// AUTH LOCAL (JWT sem Supabase)
// ══════════════════════════════════════════════════════
const JWT_SECRET = process.env.JWT_SECRET || 'breachdb-secret-key-2025';

function hashPassword(password) {
  return crypto.createHmac('sha256', JWT_SECRET).update(password).digest('hex');
}

function generateToken(userId, email) {
  const payload = { sub: userId, email, iat: Date.now(), exp: Date.now() + 7 * 24 * 60 * 60 * 1000 };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

// Middleware for JWT verification
async function authMiddleware(req, res, next) {
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.query.token) {
    token = req.query.token;
  }
  
  if (!token) return res.status(401).json({ error: 'Missing or invalid token' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Token expired or invalid' });
  
  // Fetch latest user data
  try {
    const r = await pool.query('SELECT * FROM users WHERE id = $1', [payload.sub]);
    if (r.rows.length === 0) return res.status(401).json({ error: 'User not found' });
    req.user = r.rows[0];
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Database error verifying token' });
  }
};

function verifyToken(token) {
  try {
    const [data, sig] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function generateTempToken(userId) {
  const payload = { sub: userId, exp: Date.now() + 5 * 60000, type: '2fa_temp' }; // 5 min
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

app.post('/api/auth/telegram', async (req, res) => {
  try {
    const telegramData = req.body;
    if (!telegramData || !telegramData.hash) return res.status(400).json({ error: 'Missing Telegram Data' });

    const botToken = process.env.TELEGRAM_TOKEN;
    if (!botToken) return res.status(500).json({ error: 'TELEGRAM_TOKEN not configured' });

    // Validate Hash
    const secretKey = crypto.createHash('sha256').update(botToken).digest();
    const dataCheckString = Object.keys(telegramData)
      .filter(k => k !== 'hash')
      .sort()
      .map(k => `${k}=${telegramData[k]}`)
      .join('\n');
      
    const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    
    // Auth date validation (prevent outdated logins, e.g. > 10 mins)
    const now = Math.floor(Date.now() / 1000);
    if (now - parseInt(telegramData.auth_date) > 600) {
      return res.status(401).json({ error: 'Telegram authentication expired' });
    }

    if (hash !== telegramData.hash) {
      return res.status(401).json({ error: 'Invalid Telegram authentication' });
    }

    const tgId = telegramData.id;
    let user;

    // Check if user exists by telegram_id
    const userRes = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [tgId]);
    
    if (userRes.rows.length > 0) {
      user = userRes.rows[0];
    } else {
      // Create user if not exists
      const email = `tg_${tgId}@telegram.local`;
      const randomPassword = crypto.randomBytes(32).toString('hex');
      const hashed = hashPassword(randomPassword);
      
      try {
        const newUserRes = await pool.query(
          'INSERT INTO users (email, password, telegram_id) VALUES ($1, $2, $3) RETURNING *',
          [email, hashed, tgId]
        );
        user = newUserRes.rows[0];
      } catch (err) {
        if (err.code === '23505') {
          // In case of extremely rare race condition or they somehow registered with tg_ email
          const existing = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
          user = existing.rows[0];
          await pool.query('UPDATE users SET telegram_id = $1 WHERE id = $2', [tgId, user.id]);
        } else {
          throw err;
        }
      }
    }

    // Magic Synchronization!
    // We scan license_keys for this telegram_id or user.id
    const maxExpRes = await pool.query(`
      SELECT 
        BOOL_OR(expires_at IS NULL AND activated_at IS NOT NULL) as has_lifetime,
        MAX(expires_at) as max_expires_at
      FROM license_keys 
      WHERE telegram_id = $1 OR user_id = $2
    `, [tgId, user.id]);

    let finalPremium = user.premium_until;

    if (maxExpRes.rows.length) {
      const { has_lifetime, max_expires_at } = maxExpRes.rows[0];
      if (has_lifetime) {
        const lifetimeDate = new Date();
        lifetimeDate.setFullYear(lifetimeDate.getFullYear() + 100);
        await pool.query(`UPDATE users SET premium_until = $1 WHERE id = $2`, [lifetimeDate, user.id]);
        finalPremium = lifetimeDate;
      } else if (max_expires_at) {
        await pool.query(`UPDATE users SET premium_until = GREATEST(premium_until, $1) WHERE id = $2`, [max_expires_at, user.id]);
        
        // Use logic to return correct updated date for frontend
        const maxExpDate = new Date(max_expires_at);
        const currPremiumDate = user.premium_until ? new Date(user.premium_until) : new Date(0);
        if (maxExpDate > currPremiumDate) finalPremium = maxExpDate;
      }
    }

    if (user.two_factor_enabled) {
      return res.json({ requires_2fa: true, tempToken: generateTempToken(user.id), method: user.two_factor_method || 'authenticator' });
    }

    const token = generateToken(user.id, user.email);
    res.json({ token, user: { id: user.id, email: user.email, display_name: user.display_name, avatar_url: user.avatar_url, telegram_id: user.telegram_id, premium_until: finalPremium, two_factor_enabled: user.two_factor_enabled, two_factor_method: user.two_factor_method } });

  } catch (err) {
    console.error('Telegram Auth Error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/auth/signup', async (req, res) => {
  const { email, password, turnstileToken } = req.body || {};
  if (!email || !password || password.length < 6) return res.status(400).json({ error: 'Email e senha obrigatórios (mín. 6 chars)' });
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  // Turnstile removido
  try {
    const hashed = hashPassword(password);
    const r = await pool.query('INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id, email', [email.toLowerCase(), hashed]);
    const user = r.rows[0];
    res.json({ token: generateToken(user.id, user.email), user: { id: user.id, email: user.email } });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email já cadastrado' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password, turnstileToken } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatórios' });
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  // Turnstile removido
  try {
    const hashed = hashPassword(password);
    const r = await pool.query('SELECT * FROM users WHERE email = $1 AND password = $2', [email.toLowerCase(), hashed]);
    if (r.rows.length === 0) return res.status(401).json({ error: 'Credenciais inválidas' });
    
    const user = r.rows[0];
    if (user.two_factor_enabled) {
      return res.json({ requires_2fa: true, tempToken: generateTempToken(user.id), method: user.two_factor_method });
    }

    res.json({ 
      token: generateToken(user.id, user.email), 
      user: { id: user.id, email: user.email, display_name: user.display_name, avatar_url: user.avatar_url, premium_until: user.premium_until, trial_searches: user.trial_searches, telegram_id: user.telegram_id, two_factor_enabled: user.two_factor_enabled, two_factor_method: user.two_factor_method } 
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/2fa/send-login-code', async (req, res) => {
  const { tempToken } = req.body || {};
  if (!tempToken) return res.status(400).json({ error: 'Token required' });

  const payload = verifyToken(tempToken);
  if (!payload || payload.type !== '2fa_temp') return res.status(401).json({ error: 'Invalid or expired token' });

  try {
    const r = await pool.query('SELECT * FROM users WHERE id = $1', [payload.sub]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    const user = r.rows[0];

    if (user.two_factor_method === 'authenticator') return res.json({ success: true, message: 'Use authenticator app' });

    // Generate random 6 digit code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 10 * 60000); // 10 minutes

    await pool.query('UPDATE users SET two_factor_temp_code = $1, two_factor_temp_expires = $2 WHERE id = $3', [code, expires, user.id]);

    if (user.two_factor_method === 'telegram') {
      if (!user.telegram_id) return res.status(400).json({ error: 'No Telegram linked' });
      // Send via Telegram
      const botToken = process.env.TELEGRAM_TOKEN;
      if (botToken) {
        https.get(`https://api.telegram.org/bot${botToken}/sendMessage?chat_id=${user.telegram_id}&text=Your AssemblyLeak Verification Code is: ${code}`);
      }
    } else if (user.two_factor_method === 'email') {
      // Simulate Email
      console.log(`\n\n========================================`);
      console.log(`📧 MOCK EMAIL DISPATCH`);
      console.log(`To: ${user.email}`);
      console.log(`Subject: AssemblyLeak Security Code`);
      console.log(`Body: Your verification code is ${code}. It expires in 10 minutes.`);
      console.log(`========================================\n\n`);
    }

    res.json({ success: true, message: `Code sent via ${user.two_factor_method}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/2fa/verify-login', async (req, res) => {
  const { tempToken, code } = req.body || {};
  if (!tempToken || !code) return res.status(400).json({ error: 'Token and code required' });

  const payload = verifyToken(tempToken);
  if (!payload || payload.type !== '2fa_temp') return res.status(401).json({ error: 'Invalid or expired 2FA token' });

  try {
    const r = await pool.query('SELECT * FROM users WHERE id = $1', [payload.sub]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    
    const user = r.rows[0];
    let isValid = false;

    if (user.two_factor_method === 'authenticator') {
      isValid = speakeasy.totp.verify({ secret: user.two_factor_secret, encoding: 'base32', token: code });
    } else {
      if (user.two_factor_temp_code === code && new Date(user.two_factor_temp_expires) > new Date()) {
        isValid = true;
        await pool.query('UPDATE users SET two_factor_temp_code = NULL, two_factor_temp_expires = NULL WHERE id = $1', [user.id]);
      }
    }

    if (!isValid) return res.status(401).json({ error: 'Invalid 2FA code' });

    res.json({ 
      token: generateToken(user.id, user.email), 
      user: { id: user.id, email: user.email, display_name: user.display_name, avatar_url: user.avatar_url, premium_until: user.premium_until, trial_searches: user.trial_searches, telegram_id: user.telegram_id, two_factor_enabled: user.two_factor_enabled, two_factor_method: user.two_factor_method } 
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', async (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const payload = verifyToken(token);
  if (!payload || payload.type === '2fa_temp') return res.status(401).json({ error: 'Não autenticado' });
  try {
    const r = await pool.query('SELECT id, email, display_name, avatar_url, premium_until, trial_searches, telegram_id, two_factor_enabled FROM users WHERE id = $1', [payload.sub]);
    if (r.rows.length === 0) return res.status(401).json({ error: 'Usuário não encontrado' });
    res.json({ user: r.rows[0] });
  } catch (err) {
    console.error('[ME ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/auth/profile', authMiddleware, async (req, res) => {
  const { display_name, avatar_url } = req.body || {};
  try {
    const r = await pool.query(
      'UPDATE users SET display_name = $1, avatar_url = $2 WHERE id = $3 RETURNING id, email, display_name, avatar_url, premium_until, trial_searches, telegram_id',
      [display_name, avatar_url, req.user.id]
    );
    res.json({ success: true, user: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/auth/password', authMiddleware, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'A nova senha deve ter no mínimo 6 caracteres' });
  try {
    const r = await pool.query('SELECT password FROM users WHERE id = $1', [req.user.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });
    
    // As senhas no BD antigo talvez estejam como CHAR(64), então hashPassword retorna SHA256 direto
    const hashedCurrent = hashPassword(currentPassword);
    if (hashedCurrent !== r.rows[0].password.trim()) {
      return res.status(401).json({ error: 'Senha atual incorreta' });
    }
    
    const hashedNew = hashPassword(newPassword);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedNew, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2FA Routes
app.post('/api/auth/2fa/generate', authMiddleware, async (req, res) => {
  const { method } = req.body || {};
  try {
    const r = await pool.query('SELECT email, telegram_id FROM users WHERE id = $1', [req.user.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    
    if (method === 'telegram' && !r.rows[0].telegram_id) {
      return res.status(400).json({ error: 'Sua conta não tem o Telegram vinculado. Logue com o Telegram antes de ativar essa opção.' });
    }

    if (method === 'authenticator') {
      const secret = speakeasy.generateSecret({ name: 'AssemblyLeak (' + r.rows[0].email + ')' });
      const qrCodeDataUrl = await QRCode.toDataURL(secret.otpauth_url);
      await pool.query('UPDATE users SET two_factor_secret = $1 WHERE id = $2', [secret.base32, req.user.id]);
      return res.json({ method: 'authenticator', secret: secret.base32, qrCodeUrl: qrCodeDataUrl });
    } else {
      // Email or Telegram logic: we don't need a static secret, we just send temporary codes
      return res.json({ method });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/2fa/enable', authMiddleware, async (req, res) => {
  const { code, method } = req.body || {};
  try {
    if (method === 'authenticator') {
      const r = await pool.query('SELECT two_factor_secret FROM users WHERE id = $1', [req.user.id]);
      const secret = r.rows[0].two_factor_secret;
      if (!secret) return res.status(400).json({ error: '2FA not generated' });

      const isValid = speakeasy.totp.verify({ secret, encoding: 'base32', token: code });
      if (!isValid) return res.status(400).json({ error: 'Invalid verification code' });
    }
    
    // For email and telegram, if they click enable, we just trust them since it's their email/telegram
    await pool.query('UPDATE users SET two_factor_enabled = true, two_factor_method = $1 WHERE id = $2', [method, req.user.id]);
    res.json({ success: true, method });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/2fa/disable', authMiddleware, async (req, res) => {
  try {
    await pool.query('UPDATE users SET two_factor_enabled = false, two_factor_secret = NULL WHERE id = $1', [req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/activate-key', authMiddleware, async (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: 'Chave obrigatória' });
  try {
    let k = key.trim().replace(/[`*_~[\]()>#+!]/g, '').toUpperCase();
    k = k.replace(/^(KEY|CHAVE|MINHA|CHAVE\s+KEY)\s+/i, '').trim();
    console.log(`[ACTIVATE KEY] User ${req.user.id} attempting key: "${k}"`);
    const resKey = await pool.query('SELECT id, user_id, telegram_id, expires_days, duration_seconds FROM license_keys WHERE key = $1 LIMIT 1', [k]);
    if (resKey.rows.length === 0) return res.status(400).json({ error: 'Chave inválida' });
    if (resKey.rows[0].user_id || resKey.rows[0].telegram_id) return res.status(400).json({ error: 'Chave já foi ativada' });

    const durSec = resKey.rows[0].duration_seconds != null
      ? Number(resKey.rows[0].duration_seconds)
      : (resKey.rows[0].expires_days ? Number(resKey.rows[0].expires_days) * 86400 : null);

    if (durSec && durSec > 0) {
      await pool.query('UPDATE license_keys SET user_id = $1, activated_at = now(), expires_at = now() + ($2::bigint || \' seconds\')::INTERVAL WHERE key = $3', [req.user.id, durSec, k]);
      // Update users table premium status
      await pool.query('UPDATE users SET premium_until = GREATEST(COALESCE(premium_until, now()), now()) + ($1::bigint || \' seconds\')::INTERVAL WHERE id = $2', [durSec, req.user.id]);
    } else {
      await pool.query('UPDATE license_keys SET user_id = $1, activated_at = now() WHERE key = $2', [req.user.id, k]);
      await pool.query('UPDATE users SET premium_until = now() + interval \'100 years\' WHERE id = $1', [req.user.id]);
    }
    
    // Fetch updated user to return
    const updatedUser = await pool.query('SELECT id, email, premium_until, trial_searches FROM users WHERE id = $1', [req.user.id]);
    res.json({ success: true, user: updatedUser.rows[0] });
  } catch (err) {
    console.error('[ACTIVATE KEY ERROR]', err);
    res.status(500).json({ error: 'Erro interno ao ativar a chave' });
  }
});

// Diagnóstico: verifica se key existe no banco (só admin via console/curl)
app.get('/api/debug/check-key', async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).json({ error: '?key=ASLK-XXXX' });
  try {
    const k = key.trim().toUpperCase();
    const r = await pool.query(`SELECT id, user_id, telegram_id, activated_at FROM license_keys WHERE key = $1`, [k]);
    if (r.rows.length === 0) {
      // Lista as primeiras 10 keys como amostra
      const sample = await pool.query(`SELECT key, user_id, telegram_id, activated_at FROM license_keys ORDER BY id DESC LIMIT 10`);
      return res.json({ found: false, searched: k, sample: sample.rows });
    }
    res.json({ found: true, key: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Gera nova key e insere no banco (admin)
app.get('/api/debug/gen-key', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30');
    const seconds = days * 86400;
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const segment = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const key = `ASLK-${segment()}-${segment()}-${segment()}`;
    await pool.query(`INSERT INTO license_keys (key, duration_seconds) VALUES ($1, $2)`, [key, seconds]);
    console.log(`[DEBUG] Key generated: ${key} (${days} days)`);
    res.json({ success: true, key, days });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lista de DDDs válidos do Brasil para evitar falsos positivos
const VALID_DDDS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19,
  21, 22, 24, 27, 28,
  31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49,
  51, 53, 54, 55,
  61, 62, 63, 64, 65, 66, 67, 68, 69,
  71, 73, 74, 75, 77, 79,
  81, 82, 83, 84, 85, 86, 87, 88, 89,
  91, 92, 93, 94, 95, 96, 97, 98, 99
]);

function sanitizeField(val, maxLen) {
  if (!val) return '';
  let s = val.trim();
  if (s.length > maxLen) s = s.substring(0, maxLen);
  
  // Fast path: avoid regex engine if string does not contain target characters
  const hasNull = s.includes('\x00');
  const hasBackslash = s.includes('\\');
  const hasTab = s.includes('\t');
  const hasNewline = s.includes('\n') || s.includes('\r');
  
  if (hasNull) s = s.replace(/\x00/g, '');
  if (hasBackslash) s = s.replace(/\\/g, '\\\\');
  if (hasTab || hasNewline) s = s.replace(/[\t\r\n]/g, ' ');
  
  return s;
}


// ══════════════════════════════════════════════════════
// SEARCH
// ══════════════════════════════════════════════════════
app.get('/api/search', async (req, res) => {
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
  const { q, url, email, senha, telefone, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const pLimit = Math.min(parseInt(limit), 100);

  // Filtrar conteúdo promocional do Telegram
  const filterTelegramContent = (row) => {
    const allFields = `${row.url || ''} ${row.email || ''} ${row.senha || ''} ${row.telefone || ''}`;
    return !(/t\.me\/|https?:\/\/t\.me|join\.me|t\.ly\/|bit\.ly\/|tele\.me\//i.test(allFields));
  };

  try {
    if (url || email || senha || telefone) {
      const conds = [], params = [];
      if (url)      { conds.push(`url ILIKE $${conds.length + 1}`);      params.push(`%${url}%`); }
      if (email)    { conds.push(`email ILIKE $${conds.length + 1}`);    params.push(`%${email}%`); }
      if (senha)    { conds.push(`senha ILIKE $${conds.length + 1}`);    params.push(`%${senha}%`); }
      if (telefone) { conds.push(`telefone ILIKE $${conds.length + 1}`); params.push(`%${telefone}%`); }
      const r = await botMultiPool.query(
        `SELECT * FROM credentials WHERE ${conds.join(' AND ')} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pLimit, offset]
      );
      return res.json({ results: r.rows.filter(filterTelegramContent), total: 1000000 });
    }

    if (q) {
      const qc = q.trim();
      const exact = await botMultiPool.query(
        `SELECT * FROM credentials WHERE email = $1 OR url = $1 OR senha = $1 OR telefone = $1 LIMIT $2`,
        [qc, pLimit]
      );
      if (exact.rows.length > 0) return res.json({ results: exact.rows.filter(filterTelegramContent), total: exact.rows.length, fast: true });

      const partial = await botMultiPool.query(`
        SELECT * FROM (
          (SELECT * FROM credentials WHERE email    ILIKE $1 LIMIT 150)
          UNION ALL
          (SELECT * FROM credentials WHERE url      ILIKE $1 LIMIT 150)
          UNION ALL
          (SELECT * FROM credentials WHERE senha    ILIKE $1 LIMIT 150)
          UNION ALL
          (SELECT * FROM credentials WHERE telefone ILIKE $1 LIMIT 150)
        ) AS combined LIMIT 150 OFFSET $2`,
        [`%${qc}%`, offset]
      );
      return res.json({ results: partial.rows.filter(filterTelegramContent), total: 1000000 });
    }

    return res.json({ results: [], total: 0 });
  } catch (err) {
    console.error('Search Error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ══════════════════════════════════════════════════════
// EXPORT
// ══════════════════════════════════════════════════════
app.get('/api/export', authMiddleware, async (req, res) => {
  const isPremium = req.user.premium_until && new Date(req.user.premium_until) > new Date();
  if (!isPremium) return res.status(403).json({ error: 'Exporting is a Premium feature.' });
  const { field, query, format } = req.query;
  if (!field || !query) return res.status(400).send('Missing params');

  const ext = format === 'json' ? 'json' : format === 'csv' ? 'csv' : 'txt';
  res.setHeader('Content-Type', format === 'json' ? 'application/json; charset=utf-8' : format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="export.${ext}"`);

  let client;
  try {
    client = await botMultiPool.connect();
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '60s'`);

    const MAX_ROWS = 3000;
    let result;

    if (field === 'q') {
      const PER = Math.ceil(MAX_ROWS / 4);
      result = await client.query(
        `SELECT * FROM (
          (SELECT * FROM credentials WHERE email    ILIKE $1 LIMIT ${PER})
          UNION ALL
          (SELECT * FROM credentials WHERE url      ILIKE $1 LIMIT ${PER})
          UNION ALL
          (SELECT * FROM credentials WHERE senha    ILIKE $1 LIMIT ${PER})
          UNION ALL
          (SELECT * FROM credentials WHERE telefone ILIKE $1 LIMIT ${PER})
        ) AS combined LIMIT $2`,
        [`%${query}%`, MAX_ROWS]
      );
    } else {
      // Busca exata primeiro (usa índice B-Tree)
      result = await client.query(
        `SELECT * FROM credentials WHERE ${field} = $1 LIMIT $2`,
        [query, MAX_ROWS]
      );
      // Se não encontrou, faz busca parcial
      if (result.rows.length === 0) {
        result = await client.query(
          `SELECT * FROM credentials WHERE ${field} ILIKE $1 LIMIT $2`,
          [`%${query}%`, MAX_ROWS]
        );
      }
    }

    await client.query('COMMIT');
    client.release();
    client = null;

    if (result.rows.length === 0) {
      return res.end(format === 'json' ? '[]' : `[SEM RESULTADOS para: ${query}]\n`);
    }

    // Filtrar conteúdo promocional do Telegram
    const filterTelegramContent = (row) => {
      const allFields = `${row.url || ''} ${row.email || ''} ${row.senha || ''} ${row.telefone || ''}`;
      return !(/t\.me\/|https?:\/\/t\.me|join\.me|t\.ly\/|bit\.ly\/|tele\.me\//i.test(allFields));
    };
    const filteredRows = result.rows.filter(filterTelegramContent);

    if (format === 'json') {
      const json = filteredRows.map(row => ({
        url: row.url || '',
        email: row.email || '',
        senha: row.senha || '',
        telefone: row.telefone || ''
      }));
      res.end(JSON.stringify(json, null, 2));
    } else if (format === 'csv') {
      res.write('\uFEFF');
      res.write('url,email,senha,telefone\n');
      for (const row of filteredRows) {
        const esc = v => `"${(v || '').replace(/"/g, '""')}"`;
        res.write(`${esc(row.url)},${esc(row.email)},${esc(row.senha)},${esc(row.telefone)}\n`);
      }
      res.end();
    } else {
      for (const row of filteredRows) {
        if (format === 'chk') {
          res.write(`${row.email || ''}:${row.senha || ''}\n`);
        } else {
          res.write(`========================================\n`);
          if (row.url)      res.write(`🌐 URL:  ${row.url}\n`);
          if (row.email)    res.write(`📧 USER: ${row.email}\n`);
          if (row.senha)    res.write(`🔑 PASS: ${row.senha}\n`);
          if (row.telefone) res.write(`📱 TEL:  ${row.telefone}\n`);
          res.write(`========================================\n\n`);
        }
      }
      res.end();
    }
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    if (!res.headersSent) res.status(500).send('Export failed');
    else res.end('\n\n[ERRO INTERNO]\n');
  }
});


app.post('/api/checkout', authMiddleware, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe is not configured' });
  const { planId } = req.body;
  let days = 0; let price = 0;
  if (planId === '1day') { days = 1; price = 1000; }
  else if (planId === '30days') { days = 30; price = 10000; }
  else if (planId === '50days') { days = 50; price = 5000; }
  else return res.status(400).json({ error: 'Invalid plan' });
  
  try {
    const frontendUrl = req.headers.origin || 'http://localhost:5173';
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: { currency: 'brl', product_data: { name: `Assembly Leak VIP - ${days} Days` }, unit_amount: price },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${frontendUrl}/dashboard?payment=success`,
      cancel_url: `${frontendUrl}/dashboard?payment=cancel`,
      metadata: { user_id: String(req.user.id), days: String(days) }
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stripe Webhook ──
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(200).send('Stripe não configurado');

  let event;
  if (stripeWebhookSecret && stripeWebhookSecret !== 'seu_webhook_secret_stripe') {
    try {
      const sig = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
    } catch (err) { return res.status(400).send(`Webhook Error: ${err.message}`); }
  } else {
    event = JSON.parse(req.body.toString());
  }

  if (event.type === 'checkout.session.completed' || event.type === 'payment_intent.succeeded') {
    const obj = event.data.object;
    const chatId = obj.metadata?.chat_id;
    const userId = obj.metadata?.user_id;
    const days = parseInt(obj.metadata?.days || '0');

    if (userId && days > 0) {
      console.log(`[STRIPE] Web payment success! User: ${userId}, Days: ${days}`);
      try {
        await botPools[0].query(`UPDATE users SET premium_until = GREATEST(COALESCE(premium_until, now()), now()) + ($1::int || ' days')::INTERVAL WHERE id = $2`, [days, userId]);
      } catch (err) { console.error('[STRIPE WEB error]', err); }
    } else if (chatId && days > 0) {
      console.log(`[STRIPE] Telegram payment success! Chat: ${chatId}, Dias: ${days}`);
      await handlePaymentSuccess(chatId, days);
    }
  }

  res.json({ received: true });
});

// Página de sucesso (opcional)
app.get('/api/pagamento-sucesso', (req, res) => {
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>✅ Pagamento confirmado!</h2><p>Sua key será enviada no Telegram.</p></body></html>`);
});

app.get('/api/pagamento-cancelado', (req, res) => {
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>❌ Pagamento cancelado</h2><p>Volte ao bot e tente novamente.</p></body></html>`);
});

// ══════════════════════════════════════════════════════
// UPLOAD — Pool separado para uploads
// ══════════════════════════════════════════════════════
const uploadDbUrl = (process.env.UPLOAD_DATABASE_URL || '').replace(/-pooler/, '');
const uploadPool = uploadDbUrl ? new Pool({ connectionString: uploadDbUrl, max: 40, idleTimeoutMillis: 600000, connectionTimeoutMillis: 60000, ssl: { rejectUnauthorized: false } }) : null;

if (uploadPool) {
  (async () => {
    try {
      await uploadPool.query(`
        CREATE TABLE IF NOT EXISTS credentials (
          id          BIGSERIAL PRIMARY KEY,
          url         TEXT,
          email       TEXT,
          senha       TEXT,
          telefone    TEXT,
          fonte       TEXT
        )
      `);
      await uploadPool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_url_trgm ON credentials USING GIN (url gin_trgm_ops)`).catch(() => {});
      await uploadPool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_email_trgm ON credentials USING GIN (email gin_trgm_ops)`).catch(() => {});
      await uploadPool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_senha_trgm ON credentials USING GIN (senha gin_trgm_ops)`).catch(() => {});
      await uploadPool.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_telefone_trgm ON credentials USING GIN (telefone gin_trgm_ops)`).catch(() => {});
      console.log('✅ [UPLOAD DB] Schema OK');
    } catch (e) { console.error('❌ [UPLOAD DB]', e.message); }
  })();

  let globalUploadState = { active: false, total: 0, inserted: 0, skipped: 0, speed: 0, startTime: null };
  let activeUploadRequests = 0;

  function parseUploadLine(line, fonte) {
    // Extrai valor dentro de buffer: "..." se presente (formato de checkers)
    const bufMatch = line.match(/(?:buffer|BUF)\s*:\s*"([^"]+)"/);
    if (bufMatch) line = bufMatch[1];

    let len = line.length;
    if (len < 2) return null;
    if (line.charCodeAt(len - 1) === 13) { len--; line = line.substring(0, len); }
    if (len < 2) return null;
    let sepIdx = -1, sepChar = 0;
    for (let i = 0; i < len; i++) {
      const c = line.charCodeAt(i);
      if (c === 58 || c === 59 || c === 124 || c === 44 || c === 9) {
        if (c === 58 && i < len - 2 && line.charCodeAt(i+1) === 47 && line.charCodeAt(i+2) === 47) continue;
        sepIdx = i; sepChar = c; break;
      }
    }
    if (sepIdx === -1) return null;
    let lastSep = sepIdx;
    let sepStr = ':';
    if (sepChar === 59) sepStr = ';';
    else if (sepChar === 124) sepStr = '|';
    else if (sepChar === 44) sepStr = ',';
    else if (sepChar === 9) sepStr = '\t';
    const lastIdx = line.lastIndexOf(sepStr);
    if (lastIdx > sepIdx) {
      if (sepChar === 58 && lastIdx < len - 2 && line.charCodeAt(lastIdx+1) === 47 && line.charCodeAt(lastIdx+2) === 47) {
        for (let i = len - 1; i > sepIdx; i--) {
          if (line.charCodeAt(i) === sepChar) { if (sepChar === 58 && i < len - 2 && line.charCodeAt(i+1) === 47 && line.charCodeAt(i+2) === 47) continue; lastSep = i; break; }
        }
      } else { lastSep = lastIdx; }
    }
    let senha = line.substring(lastSep + 1);
    const prefix = line.substring(0, lastSep);
    const atIdx = prefix.indexOf('@');
    let url, email;
    let lastSepInPrefix = -1;
    if (atIdx !== -1) {
      let emailStart = 0;
      for (let i = atIdx - 1; i >= 0; i--) {
        const c = prefix.charCodeAt(i);
        if (c === 58 || c === 59 || c === 124 || c === 44 || c === 9) { if (c === 58 && i > 0 && i < prefix.length - 2 && prefix.charCodeAt(i+1) === 47 && prefix.charCodeAt(i+2) === 47) continue; emailStart = i + 1; break; }
      }
      const tempEmail = prefix.substring(emailStart);
      url = emailStart > 0 ? prefix.substring(0, emailStart - 1) : '';
      let emailEnd = tempEmail.length;
      for (let i = 0; i < tempEmail.length; i++) {
        const c = tempEmail.charCodeAt(i);
        if (c === 58 || c === 59 || c === 124 || c === 44 || c === 9) { emailEnd = i; break; }
      }
      email = tempEmail.substring(0, emailEnd);
    } else {
      for (let i = prefix.length - 1; i >= 0; i--) {
        const c = prefix.charCodeAt(i);
        if (c === 58 || c === 59 || c === 124 || c === 44 || c === 9) { if (c === 58 && i > 0 && i < prefix.length - 2 && prefix.charCodeAt(i+1) === 47 && prefix.charCodeAt(i+2) === 47) continue; lastSepInPrefix = i; break; }
      }
      if (lastSepInPrefix !== -1) { email = prefix.substring(lastSepInPrefix + 1); url = prefix.substring(0, lastSepInPrefix); }
      else { email = ''; url = prefix; }
    }
    url = url.trim(); email = email.trim(); senha = senha.trim();
    url = url.replace(/^(URL|Host|Website|Domain|Endereço)\s*:\s*/i, '');
    email = email.replace(/^(Username|User|Login|Email|E-mail|User\s*Name)\s*:\s*/i, '');
    senha = senha.replace(/^(Password|Pass|Senha)\s*:\s*/i, '');
    url = url.trim(); email = email.trim(); senha = senha.trim();

    const sanitize = (str) => {
      if (!str) return '';
      let s = str.replace(/[\t\n\r\0]/g, '');
      s = s.replace(/\\/g, '\\\\');
      if (typeof s.toWellFormed === 'function') s = s.toWellFormed();
      else s = s.replace(/[\uD800-\uDFFF]/g, '');
      return s;
    };

    url = sanitize(url.substring(0, 450));
    email = sanitize(email.substring(0, 255));
    senha = sanitize(senha.substring(0, 255));
    const safeFonte = sanitize(fonte);

    return `${url}\t${email}\t${senha}\t\t${safeFonte}\n`;
  }

  async function copyInsert(batchItem) {
    if (!batchItem || batchItem.count === 0) return { inserted: 0, skipped: 0 };
    const { csv, count } = batchItem;
    let client;
    try {
      client = await uploadPool.connect();
      await client.query(`SET synchronous_commit TO OFF; SET statement_timeout = '900s'; SET work_mem = '256MB';`);

      try {
        await new Promise((resolve, reject) => {
          const stream = client.query(copyFrom(`COPY credentials (url, email, senha, telefone, fonte) FROM STDIN WITH (FORMAT text, DELIMITER E'\\t', NULL '')`));
          stream.on('finish', resolve);
          stream.on('error', reject);
          stream.write(csv);
          stream.end();
        });
        return { inserted: count, skipped: 0 };
      } catch (e) {
        console.error(`⚠️ [COPY FALLBACK] Lote de ${count} falhou: ${e.message}. Fragmentando em 1000...`);
        const lines = csv.split('\n').filter(l => l.length > 0);
        let inserted = 0, skipped = 0;
        for (let i = 0; i < lines.length; i += 1000) {
          const sub = lines.slice(i, i + 1000).join('\n') + '\n';
          try {
            await new Promise((resolve, reject) => {
              const stream = client.query(copyFrom(`COPY credentials (url, email, senha, telefone, fonte) FROM STDIN WITH (FORMAT text, DELIMITER E'\\t', NULL '')`));
              stream.on('finish', resolve);
              stream.on('error', reject);
              stream.write(sub);
              stream.end();
            });
            inserted += Math.min(1000, lines.length - i);
          } catch (e2) {
            skipped += Math.min(1000, lines.length - i);
          }
        }
        return { inserted, skipped };
      }
    } finally {
      if (client) client.release();
    }
  }

  app.get('/api/upload-progress', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const send = () => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(globalUploadState)}\n\n`); };
    const interval = setInterval(send, 500);
    req.on('close', () => clearInterval(interval));
  });

  app.post('/api/upload-stream', (req, res) => {
    try { req.socket.setTimeout(0); } catch(_) {}

    const fonte = req.headers['x-source'] ? decodeURIComponent(req.headers['x-source']) : 'unknown';
    const chunkIndex = req.headers['x-chunk-index'] ? parseInt(req.headers['x-chunk-index']) : 0;
    const chunksTotal = req.headers['x-chunks-total'] ? parseInt(req.headers['x-chunks-total']) : 1;
    activeUploadRequests++;
    if (!globalUploadState.startTime) { globalUploadState.total = 0; globalUploadState.inserted = 0; globalUploadState.skipped = 0; globalUploadState.speed = 0; globalUploadState.startTime = Date.now(); }
    globalUploadState.active = true;
    globalUploadState.fonte = fonte;

    const BATCH_SIZE = 10_000;
    const MAX_PARALLEL = 30;
    const MAX_QUEUE = 90;
    let csvLines = [];
    let linesCount = 0;
    const queue = [];
    let activeWorkers = 0;
    let requestParsedCount = 0, requestInsertedCount = 0, requestSkippedCount = 0;
    const fonteClean = fonte.replace(/\t/g, ' ').replace(/\n/g, ' ');

    function startWorkers() {
      while (queue.length > 0 && activeWorkers < MAX_PARALLEL) {
        activeWorkers++;
        const currentBatch = queue.shift();
        if (queue.length < MAX_QUEUE / 3) req.resume();
        (async (batchToInsert) => {
          try { const result = await copyInsert(batchToInsert); requestInsertedCount += result.inserted; requestSkippedCount += result.skipped; globalUploadState.inserted += result.inserted; }
          catch (err) { console.error(`❌ [WORKER ERROR] ${batchToInsert.count} linhas: ${err.message}`); globalUploadState.skipped += batchToInsert.count; }
          activeWorkers--;
          const elapsed = (Date.now() - globalUploadState.startTime) / 1000 || 0.001;
          globalUploadState.speed = Math.round(globalUploadState.inserted / elapsed);
          startWorkers();
        })(currentBatch);
      }
    }

    function flushBatch() {
      if (linesCount === 0) return;
      queue.push({ csv: csvLines.join(''), count: linesCount });
      csvLines = []; linesCount = 0;
      startWorkers();
      if (queue.length >= MAX_QUEUE) req.pause();
    }

    const rl = readline.createInterface({ input: req, crlfDelay: Infinity });

    rl.on('line', (line) => {
      requestParsedCount++;
      globalUploadState.total++;
      const p = parseUploadLine(line, fonteClean);
      if (!p) { requestSkippedCount++; globalUploadState.skipped++; return; }
      csvLines.push(p);
      linesCount++;
      if (linesCount >= BATCH_SIZE) flushBatch();
    });

    rl.on('close', () => {
      flushBatch();
      res.status(202).json({ success: true, parsed: requestParsedCount, inserted: requestInsertedCount, chunkIndex, chunksTotal });
      (async () => {
        try {
          while (activeWorkers > 0 || queue.length > 0) await new Promise(r => setTimeout(r, 50));
        } catch (bgErr) {
          console.error(`⚠️ [UPLOAD BG] ${bgErr.message}`);
        } finally {
          activeUploadRequests--;
          if (activeUploadRequests <= 0) { activeUploadRequests = 0; globalUploadState.active = false; }
        }
      })();
    });

    rl.on('error', (err) => {
      console.error('Upload Stream Error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
      activeUploadRequests--;
      if (activeUploadRequests <= 0) { activeUploadRequests = 0; globalUploadState.active = false; }
    });
  });

  console.log('📤 [UPLOAD] Rotas de upload habilitadas');
}


// ══════════════════════════════════════════════════════
// CONSULTA DB — Pool separado para cache de consultas CPF
// ══════════════════════════════════════════════════════
const consultaDbUrl = (process.env.CONSULTA_DATABASE_URL || '').replace(/-pooler/, '');
const consultaPool = consultaDbUrl ? new Pool({ connectionString: consultaDbUrl, max: 10, idleTimeoutMillis: 600000, connectionTimeoutMillis: 30000, ssl: { rejectUnauthorized: false } }) : null;

if (consultaPool) {
  (async () => {
    try {
      await consultaPool.query(`
        CREATE TABLE IF NOT EXISTS cpf_cache (
          id SERIAL PRIMARY KEY,
          cpf VARCHAR(11) UNIQUE NOT NULL,
          nome TEXT,
          sexo VARCHAR(1),
          nascimento DATE,
          nome_mae TEXT,
          nome_pai TEXT,
          rg TEXT,
          renda TEXT,
          titulo_eleitor TEXT,
          sit_cad TEXT,
          estciv TEXT,
          nacionalidade TEXT,
          cbo TEXT,
          cbo_descricao TEXT,
          orgao_emissor TEXT,
          uf_emissao TEXT,
          data_obito DATE,
          mosaic TEXT,
          mosaic_novo TEXT,
          mosaic_secundario TEXT,
          contatos_id TEXT,
          contatos_id_conjuge TEXT,
          cadastro_id TEXT,
          dt_sit_cad TIMESTAMP,
          dt_informacao TEXT,
          faixa_renda_id TEXT,
          so TEXT,
          telefones JSONB DEFAULT '[]',
          emails JSONB DEFAULT '[]',
          enderecos JSONB DEFAULT '[]',
          score JSONB DEFAULT '[]',
          pis JSONB DEFAULT '[]',
          poder_aquisitivo JSONB DEFAULT '[]',
          tse JSONB DEFAULT '[]',
          parentes TEXT,
          dados_raw JSONB,
          fonte VARCHAR(20) DEFAULT 'scan',
          consultado_em TIMESTAMP DEFAULT NOW(),
          criado_em TIMESTAMP DEFAULT NOW()
        )
      `);
      // Add columns if missing (migration from old schema with 'dados' column)
      const newCols = [
        'DROP COLUMN IF EXISTS dados CASCADE',
        'ADD COLUMN IF NOT EXISTS nome TEXT',
        'ADD COLUMN IF NOT EXISTS sexo VARCHAR(1)',
        'ADD COLUMN IF NOT EXISTS nascimento DATE',
        'ADD COLUMN IF NOT EXISTS nome_mae TEXT',
        'ADD COLUMN IF NOT EXISTS nome_pai TEXT',
        'ADD COLUMN IF NOT EXISTS rg TEXT',
        'ADD COLUMN IF NOT EXISTS renda TEXT',
        'ADD COLUMN IF NOT EXISTS titulo_eleitor TEXT',
        'ADD COLUMN IF NOT EXISTS sit_cad TEXT',
        'ADD COLUMN IF NOT EXISTS estciv TEXT',
        'ADD COLUMN IF NOT EXISTS nacionalidade TEXT',
        'ADD COLUMN IF NOT EXISTS cbo TEXT',
        'ADD COLUMN IF NOT EXISTS cbo_descricao TEXT',
        'ADD COLUMN IF NOT EXISTS orgao_emissor TEXT',
        'ADD COLUMN IF NOT EXISTS uf_emissao TEXT',
        'ADD COLUMN IF NOT EXISTS data_obito DATE',
        'ADD COLUMN IF NOT EXISTS mosaic TEXT',
        'ADD COLUMN IF NOT EXISTS mosaic_novo TEXT',
        'ADD COLUMN IF NOT EXISTS mosaic_secundario TEXT',
        'ADD COLUMN IF NOT EXISTS contatos_id TEXT',
        'ADD COLUMN IF NOT EXISTS contatos_id_conjuge TEXT',
        'ADD COLUMN IF NOT EXISTS cadastro_id TEXT',
        'ADD COLUMN IF NOT EXISTS dt_sit_cad TIMESTAMP',
        'ADD COLUMN IF NOT EXISTS dt_informacao TEXT',
        'ADD COLUMN IF NOT EXISTS faixa_renda_id TEXT',
        'ADD COLUMN IF NOT EXISTS so TEXT',
        'ADD COLUMN IF NOT EXISTS telefones JSONB DEFAULT \'[]\'',
        'ADD COLUMN IF NOT EXISTS emails JSONB DEFAULT \'[]\'',
        'ADD COLUMN IF NOT EXISTS enderecos JSONB DEFAULT \'[]\'',
        'ADD COLUMN IF NOT EXISTS score JSONB DEFAULT \'[]\'',
        'ADD COLUMN IF NOT EXISTS pis JSONB DEFAULT \'[]\'',
        'ADD COLUMN IF NOT EXISTS poder_aquisitivo JSONB DEFAULT \'[]\'',
        'ADD COLUMN IF NOT EXISTS tse JSONB DEFAULT \'[]\'',
        'ADD COLUMN IF NOT EXISTS parentes TEXT',
        'ADD COLUMN IF NOT EXISTS dados_raw JSONB',
      ];
      for (const col of newCols) {
        await consultaPool.query(`ALTER TABLE cpf_cache ${col}`).catch(() => {});
      }
      await consultaPool.query(`CREATE INDEX IF NOT EXISTS idx_cc_cpf ON cpf_cache (cpf)`).catch(() => {});
      await consultaPool.query(`CREATE INDEX IF NOT EXISTS idx_cc_nome ON cpf_cache (nome)`).catch(() => {});
      console.log('✅ [CONSULTA DB] Schema OK');
    } catch (e) { console.error('❌ [CONSULTA DB]', e.message); }
  })();

  // ── Rotas fixas (registrar ANTES de /:cpf) ──
  // GET /api/consulta/status — progresso da extração
  app.get('/api/consulta/status', (req, res) => {
    const elapsed = extractState.startTime ? Math.round((Date.now() - extractState.startTime) / 1000) : 0;
    res.json({ ...extractState, elapsed });
  });

  // POST /api/consulta/extract — reinicia extração manualmente
  app.post('/api/consulta/extract', async (req, res) => {
    const auth = req.headers['authorization'];
    if (auth !== 'Bearer breachdb-admin-2025') return res.status(401).json({ error: 'Unauthorized' });
    runCpfExtraction().catch(e => console.error('❌ [EXTRACT MANUAL]', e.message));
    res.json({ status: 'started' });
  });

  // POST /api/consulta/stop — para a extração
  app.post('/api/consulta/stop', async (req, res) => {
    const auth = req.headers['authorization'];
    if (auth !== 'Bearer breachdb-admin-2025') return res.status(401).json({ error: 'Unauthorized' });
    if (extractAbort) extractAbort.abort();
    res.json({ status: 'stopped' });
  });

  // ── CBO description lookup ──
  const CBO_DESCRICOES = {
    '0101': 'Membro superior do poder público', '0201': 'Diretor de planejamento', '0202': 'Diretor de produção',
    '0203': 'Diretor comercial', '0204': 'Diretor de finanças', '0205': 'Diretor de recursos humanos',
    '0211': 'Diretor de operações', '0301': 'Diretor de pequena empresa', '0710': 'Oficial general',
    '0711': 'Oficial das forças armadas', '0731': 'Praça das forças armadas', '0801': 'Oficial bombeiro militar',
    '0802': 'Praça bombeiro militar', '0901': 'Oficial policial militar', '0902': 'Praça policial militar',
    '1111': 'Político', '1112': 'Servidor público', '1113': 'Dirigente de partido político',
    '1114': 'Dirigente de sindicato', '1141': 'Presidente de organização', '1142': 'Dirigente de associação',
    '1143': 'Dirigente de ONG', '1210': 'Diretor de serviços de saúde', '1220': 'Diretor de educação',
    '1221': 'Diretor de ensino', '1222': 'Diretor de escola', '1223': 'Diretor acadêmico',
    '1230': 'Diretor de tecnologia', '1231': 'Gerente de TI', '1232': 'Gerente de projetos',
    '1233': 'Gerente comercial', '1234': 'Gerente administrativo', '1235': 'Gerente de logística',
    '1236': 'Gerente de finanças', '1237': 'Gerente de RH', '1238': 'Gerente de marketing',
    '1241': 'Coordenador pedagógico', '1242': 'Coordenador administrativo', '1243': 'Coordenador de áreas',
    '1311': 'Supervisor administrativo', '1312': 'Supervisor comercial', '1313': 'Supervisor de produção',
    '1411': 'Gerente de hotel', '1412': 'Gerente de restaurante', '1413': 'Gerente de turismo',
    '1421': 'Gerente de comércio', '1422': 'Gerente de loja', '1423': 'Gerente de supermercado',
    '2011': 'Profissional de biotecnologia', '2012': 'Profissional de engenharia',
    '2021': 'Engenheiro civil', '2022': 'Engenheiro elétrico', '2023': 'Engenheiro mecânico',
    '2024': 'Engenheiro químico', '2025': 'Engenheiro de produção', '2026': 'Engenheiro de computação',
    '2027': 'Engenheiro de minas', '2028': 'Engenheiro ambiental', '2029': 'Engenheiro de segurança',
    '2031': 'Arquiteto', '2032': 'Urbanista', '2033': 'Paisagista',
    '2041': 'Matemático', '2042': 'Estatístico', '2043': 'Atuário',
    '2051': 'Físico', '2052': 'Químico', '2053': 'Astrônomo',
    '2061': 'Geólogo', '2062': 'Geógrafo', '2063': 'Meteorologista',
    '2071': 'Pesquisador', '2072': 'Cientista',
    '2111': 'Contador', '2112': 'Auditor', '2113': 'Perito contábil',
    '2121': 'Administrador', '2122': 'Economista', '2123': 'Sociólogo', '2124': 'Antropólogo',
    '2125': 'Filósofo', '2126': 'Analista de sistemas', '2127': 'Analista de negócios',
    '2128': 'Analista de projetos', '2129': 'Analista de processos',
    '2131': 'Tecnólogo', '2132': 'Desenvolvedor', '2133': 'Programador',
    '2141': 'Analista de TI', '2142': 'Analista de suporte', '2143': 'Analista de dados',
    '2144': 'Analista de redes', '2145': 'Analista de segurança', '2146': 'Analista de qualidade',
    '2211': 'Médico clínico', '2212': 'Médico cirurgião', '2213': 'Médico especialista',
    '2214': 'Médico do trabalho', '2215': 'Médico legista', '2216': 'Médico residente',
    '2221': 'Enfermeiro', '2222': 'Técnico de enfermagem', '2223': 'Auxiliar de enfermagem',
    '2231': 'Dentista', '2232': 'Odontólogo', '2233': 'Técnico em odontologia',
    '2234': 'Prótese dentária', '2235': 'Auxiliar de odontologia',
    '2236': 'Fisioterapeuta', '2237': 'Terapeuta ocupacional', '2238': 'Fonoaudiólogo',
    '2239': 'Nutricionista', '2240': 'Farmacêutico', '2241': 'Bioquímico',
    '2251': 'Veterinário', '2252': 'Zootecnista', '2253': 'Biólogo',
    '2261': 'Psicólogo', '2262': 'Psicanalista', '2263': 'Psiquiatra',
    '2311': 'Professor universitário', '2312': 'Professor de ensino médio', '2313': 'Professor de ensino fundamental',
    '2314': 'Professor de educação infantil', '2315': 'Professor de educação especial',
    '2321': 'Pedagogo', '2322': 'Orientador educacional', '2323': 'Supervisor de ensino',
    '2331': 'Instrutor de cursos', '2332': 'Professor de idiomas', '2333': 'Professor de música',
    '2341': 'Professor de educação física', '2342': 'Técnico esportivo', '2343': 'Preparador físico',
    '2344': 'Personal trainer', '2345': 'Instrutor de academia',
    '2411': 'Advogado', '2412': 'Juiz', '2413': 'Promotor', '2414': 'Defensor público',
    '2415': 'Delegado', '2416': 'Procurador', '2417': 'Procurador federal', '2418': 'Advogado público',
    '2421': 'Tabelião', '2422': 'Registrador', '2423': 'Oficial de justiça', '2424': 'Conciliador',
    '2429': 'Profissional do direito',
    '2511': 'Jornalista', '2512': 'Repórter', '2513': 'Redator', '2514': 'Editor',
    '2521': 'Publicitário', '2522': 'Relações públicas', '2523': 'Analista de marketing',
    '2524': 'Analista de comunicação', '2525': 'Social media',
    '2531': 'Designer', '2532': 'Designer gráfico', '2533': 'Designer de produto', '2534': 'Designer de interiores',
    '2611': 'Artista plástico', '2612': 'Artista visual', '2613': 'Escultor', '2614': 'Pintor',
    '2615': 'Fotógrafo', '2616': 'Cineasta', '2617': 'Diretor de arte',
    '2621': 'Músico', '2622': 'Compositor', '2623': 'Maestro', '2624': 'Instrumentista',
    '2625': 'Cantor', '2626': 'DJ', '2627': 'Produtor musical',
    '2631': 'Ator', '2632': 'Dançarino', '2633': 'Coreógrafo', '2634': 'Diretor de teatro',
    '2641': 'Radialista', '2642': 'Apresentador', '2643': 'Locutor', '2644': 'Narrador',
    '2711': 'Religioso', '2712': 'Sacerdote', '2713': 'Pastor', '2714': 'Missionário',
    '2721': 'Teólogo', '2722': 'Filósofo religioso',
    '3001': 'Técnico de nível médio', '3002': 'Técnico de laboratório', '3003': 'Técnico de indústria',
    '3111': 'Técnico em química', '3112': 'Técnico em física', '3113': 'Técnico em biologia',
    '3114': 'Técnico em geologia', '3115': 'Técnico em mineração',
    '3121': 'Técnico em mecânica', '3122': 'Técnico em eletrônica', '3123': 'Técnico em automação',
    '3131': 'Técnico em eletricidade', '3132': 'Técnico em telecomunicações', '3133': 'Técnico em informática',
    '3134': 'Técnico de suporte', '3135': 'Técnico de redes',
    '3141': 'Técnico em edificações', '3142': 'Técnico em estradas', '3143': 'Técnico em saneamento',
    '3144': 'Técnico em agrimensura', '3145': 'Técnico em topografia',
    '3151': 'Técnico em segurança do trabalho', '3152': 'Técnico em meio ambiente',
    '3161': 'Desenhista técnico', '3162': 'Projetista', '3163': 'Cadista',
    '3171': 'Eletricista', '3172': 'Eletromecânico', '3173': 'Eletrotécnico',
    '3181': 'Mecânico de manutenção', '3182': 'Mecânico industrial', '3183': 'Mecânico automotivo',
    '3184': 'Mecânico de aeronaves', '3185': 'Mecânico de máquinas',
    '3201': 'Técnico em enfermagem', '3202': 'Técnico em farmácia', '3203': 'Técnico em radiologia',
    '3211': 'Técnico em análises clínicas', '3212': 'Técnico em patologia', '3213': 'Técnico em hemoterapia',
    '3221': 'Técnico em nutrição', '3222': 'Técnico em dietética',
    '3231': 'Auxiliar de enfermagem', '3232': 'Cuidador de idosos', '3233': 'Auxiliar de saúde bucal',
    '3241': 'Técnico em veterinária', '3242': 'Técnico em zootecnia',
    '3251': 'Técnico em estética', '3252': 'Massoterapeuta', '3253': 'Acupunturista',
    '3281': 'Técnico em prótese', '3282': 'Técnico ortopédico',
    '3301': 'Técnico em educação', '3302': 'Técnico em creche', '3303': 'Técnico em pedagogia',
    '3311': 'Professor auxiliar', '3312': 'Monitor educacional', '3313': 'Tutor',
    '3401': 'Técnico em contabilidade', '3402': 'Técnico em administração', '3403': 'Técnico em finanças',
    '3404': 'Técnico em RH', '3405': 'Técnico em logística', '3406': 'Técnico em comércio',
    '3411': 'Auxiliar de contabilidade', '3412': 'Auxiliar administrativo', '3413': 'Auxiliar financeiro',
    '3421': 'Secretário', '3422': 'Secretário executivo', '3423': 'Recepcionista',
    '3424': 'Telefonista', '3425': 'Operador de call center',
    '3426': 'Auxiliar de escritório',
    '3501': 'Técnico em TI', '3502': 'Técnico em programação', '3503': 'Técnico em web',
    '3511': 'Operador de computador', '3512': 'Operador de microcomputador', '3513': 'Analista de suporte',
    '3514': 'Técnico de manutenção de computadores',
    '3521': 'Técnico em comunicação', '3522': 'Técnico em marketing',
    '3711': 'Técnico em eventos', '3712': 'Técnico em turismo', '3713': 'Técnico em hotelaria',
    '3721': 'Técnico em esportes', '3722': 'Técnico em lazer',
    '3731': 'Técnico em biblioteconomia', '3732': 'Técnico em museologia',
    '3741': 'Técnico em audiovisual', '3742': 'Técnico em fotografia',
    '3751': 'Técnico em artes', '3752': 'Técnico em artesanato',
    '3761': 'Técnico em design', '3762': 'Técnico em moda',
    '3771': 'Técnico em segurança', '3772': 'Técnico em vigilância', '3773': 'Técnico em bombeiro',
    '3911': 'Técnico em seguros', '3912': 'Técnico em previdência',
    '3921': 'Técnico em imóveis', '3922': 'Técnico em avaliações',
    '3931': 'Técnico em comércio exterior', '3932': 'Técnico em alfândega',
    '3951': 'Inspetor de segurança',
    '4101': 'Escriturário', '4102': 'Auxiliar de escritório', '4103': 'Office boy',
    '4111': 'Operador de caixa', '4112': 'Operador de telemarketing', '4113': 'Atendente',
    '4114': 'Recepcionista', '4115': 'Porteiro', '4116': 'Vigia',
    '4121': 'Auxiliar administrativo', '4122': 'Assistente administrativo', '4123': 'Analista administrativo',
    '4131': 'Digitador', '4132': 'Almoxarife', '4133': 'Arquivista',
    '4141': 'Auxiliar de contabilidade', '4142': 'Assistente fiscal',
    '4151': 'Auxiliar de pessoal', '4152': 'Assistente de RH',
    '4201': 'Caixa', '4202': 'Atendente de loja', '4203': 'Vendedor',
    '4211': 'Bilheteiro', '4212': 'Cobrador', '4213': 'Trasportador de valores',
    '4214': 'Operador de cartão',
    '4221': 'Despachante', '4222': 'Agente de viagens',
    '5101': 'Trabalhador de serviços', '5102': 'Trabalhador de manutenção', '5103': 'Faxineiro',
    '5111': 'Cozinheiro', '5112': 'Auxiliar de cozinha', '5113': 'Garçom', '5114': 'Barman',
    '5121': 'Chef de cozinha', '5122': 'Confeiteiro', '5123': 'Padeiro',
    '5131': 'Camareiro', '5132': 'Governanta', '5133': 'Lavadeiro', '5134': 'Passadeiro',
    '5135': 'Jardineiro', '5136': 'Caseiro', '5137': 'Zelador',
    '5141': 'Cabeleireiro', '5142': 'Barbeiro', '5143': 'Manicure', '5144': 'Maquiador',
    '5145': 'Esteticista', '5146': 'Depilador',
    '5161': 'Segurança', '5162': 'Vigilante', '5163': 'Porteiro', '5164': 'Guarda',
    '5165': 'Bombeiro civil', '5166': 'Segurança patrimonial',
    '5171': 'Motorista de transporte escolar', '5172': 'Motorista de táxi',
    '5173': 'Motorista de ônibus', '5174': 'Motorista de caminhão',
    '5175': 'Motorista de entrega', '5176': 'Entregador', '5177': 'Motoboy',
    '5191': 'Carteiro', '5192': 'Office boy', '5193': 'Contínuo', '5194': 'Auxiliar de serviços',
    '5198': 'Trabalhador de serviços diversos', '5199': 'Profissional de serviços',
    '5201': 'Vendedor de comércio', '5202': 'Vendedor ambulante', '5203': 'Representante comercial',
    '5211': 'Vendedor interno', '5212': 'Vendedor externo', '5213': 'Consultor de vendas',
    '5214': 'Corretor de seguros', '5215': 'Corretor de imóveis',
    '5216': 'Leiloeiro', '5217': 'Avaliador',
    '5221': 'Demonstrador', '5222': 'Promotor de vendas', '5223': 'Propagandista',
    '5231': 'Comprador', '5232': 'Suprimentos',
    '5241': 'Caixa de supermercado', '5242': 'Fiscal de loja', '5243': 'Repositor',
    '6111': 'Agricultor', '6112': 'Lavrador', '6113': 'Horticultor', '6114': 'Fruticultor',
    '6115': 'Granjeiro', '6116': 'Avicultor', '6117': 'Suinocultor',
    '6121': 'Pecuarista', '6122': 'Boiadeiro', '6123': 'Vaqueiro',
    '6131': 'Produtor rural', '6132': 'Tratorista', '6133': 'Rurais',
    '6201': 'Trabalhador florestal', '6202': 'Seringueiro', '6203': 'Extrativista',
    '6211': 'Madeireiro', '6212': 'Carpinteiro', '6213': 'Marceneiro',
    '6221': 'Pescador', '6222': 'Aquicultor', '6223': 'Maricultor',
    '6231': 'Garimpeiro', '6232': 'Minerador',
    '6301': 'Trabalhador de extração vegetal', '6311': 'Carvoaria', '6321': 'Coletores',
    '6411': 'Beneficiamento rural',
    '7101': 'Trabalhador industrial', '7102': 'Operador de produção', '7103': 'Auxiliar de produção',
    '7111': 'Supervisor de produção', '7112': 'Líder de produção', '7113': 'Coordenador de produção',
    '7121': 'Alimentador de linha', '7122': 'Auxiliar de linha',
    '7151': 'Pedreiro', '7152': 'Servente', '7153': 'Carpinteiro de obra', '7154': 'Armador',
    '7155': 'Bombeiro hidráulico', '7156': 'Gesseiro', '7157': 'Pintor de obra',
    '7158': 'Eletricista de obra', '7159': 'Ladrilheiro',
    '7161': 'Telhador', '7162': 'Vidraceiro', '7163': 'Impermeabilizador',
    '7171': 'Operador de máquinas pesadas', '7172': 'Operador de guindaste', '7173': 'Operador de empilhadeira',
    '7181': 'Mestre de obras', '7182': 'Encarregado de obras',
    '7201': 'Mecânico', '7202': 'Mecânico de automóveis', '7203': 'Mecânico de caminhões',
    '7211': 'Funileiro', '7212': 'Pintor de automóveis', '7213': 'Eletricista automotivo',
    '7214': 'Borracheiro', '7221': 'Mecânico de motos',
    '7231': 'Soldador', '7232': 'Torneiro mecânico', '7233': 'Fresador', '7234': 'Retificador',
    '7241': 'Ferrageiro', '7242': 'Serralheiro', '7243': 'Cortador',
    '7244': 'Operador de CNC',
    '7251': 'Montador', '7252': 'Montador de móveis', '7253': 'Montador industrial',
    '7254': 'Montador de veículos',
    '7261': 'Ajustador', '7262': 'Caldeireiro', '7263': 'Ferramenteiro',
    '7311': 'Vidreiro', '7312': 'Ceramista', '7313': 'Oleiro',
    '7321': 'Marceneiro', '7322': 'Carpinteiro', '7323': 'Entalhador',
    '7331': 'Moveleiro', '7332': 'Restaurador',
    '7341': 'Tapeceiro', '7342': 'Colchoeiro',
    '7361': 'Padeiro', '7362': 'Confeiteiro', '7363': 'Churrasqueiro',
    '7364': 'Açougueiro', '7365': 'Peixeiro', '7366': 'Cozinheiro industrial',
    '7371': 'Carniceiro', '7372': 'Salsicheiro', '7373': 'Defumador',
    '7381': 'Cervejeiro', '7382': 'Vinicultor', '7383': 'Destilador', '7384': 'Enólogo',
    '7411': 'Costureiro', '7412': 'Alfaiate', '7413': 'Modista', '7414': 'Bordadeiro',
    '7421': 'Estilista', '7422': 'Modelista', '7423': 'Cortador de tecido',
    '7431': 'Sapateiro', '7432': 'Seleiro',
    '7441': 'Chapeleiro', '7442': 'Luvista',
    '7511': 'Gráfico', '7512': 'Impressor', '7513': 'Acabador',
    '7521': 'Diagramador', '7522': 'Editor gráfico',
    '7611': 'Operador químico', '7612': 'Técnico químico', '7613': 'Laboratorista',
    '7621': 'Farmacêutico industrial', '7622': 'Químico industrial',
    '7631': 'Plástico', '7632': 'Borracha',
    '7711': 'Operador de utilidades', '7712': 'Operador de caldeira', '7713': 'Operador de estação',
    '7721': 'Tratamento de água', '7722': 'Resíduos',
    '7731': 'Energia', '7732': 'Gás',
    '7751': 'Operador de máquinas', '7752': 'Operador de equipamentos', '7753': 'Operador de processo',
    '7761': 'Operador de empacotamento', '7762': 'Operador de envase',
    '7771': 'Operador de transportador', '7772': 'Operador de elevação',
    '7773': 'Operador de máquinas agrícolas',
    '7811': 'Montador de veículos', '7812': 'Montador de equipamentos',
    '7821': 'Montador eletrônico', '7822': 'Montador elétrico',
    '7831': 'Auxiliar de montagem', '7832': 'Alimentador',
    '7911': 'Carregador', '7912': 'Descarregador', '7913': 'Movimentador',
    '7921': 'Armazenista', '7922': 'Expedidor', '7923': 'Separador',
    '7931': 'Operador de logística', '7932': 'Auxiliar de logística',
    '7941': 'Conferente', '7942': 'Apontador',
    '7951': 'Embalador', '7952': 'Rotulador',
    '8111': 'Operador de telemarketing', '8112': 'Atendente de telemarketing', '8113': 'Supervisor de telemarketing',
    '8121': 'Operador de rádio', '8122': 'Operador de comunicação',
    '8141': 'Operador de som', '8142': 'Operador de iluminação', '8143': 'Operador de vídeo',
    '8211': 'Eletricista', '8212': 'Eletricista de manutenção', '8213': 'Eletricista predial',
    '8221': 'Eletricista industrial', '8222': 'Eletricista veicular',
    '8231': 'Eletrônico', '8232': 'Técnico eletrônico', '8233': 'Instalador eletrônico',
    '8241': 'Telefônico', '8242': 'Instalador de telecom',
    '8281': 'Relojoeiro', '8282': 'Instrumentista', '8283': 'Afinador',
    '8291': 'Luthier', '8292': 'Restaurador de instrumentos', '8293': 'Afinador de piano',
    '8301': 'Joalheiro', '8302': 'Ourives', '8303': 'Lapidário',
    '8311': 'Bijuteiro', '8312': 'Artesão',
    '8321': 'Escultor', '8322': 'Gravador',
    '8331': 'Artesão de cerâmica', '8332': 'Artesão de madeira',
    '8401': 'Operador de tecelagem', '8402': 'Operador de fiação', '8403': 'Operador de malharia',
    '8411': 'Tecelão', '8412': 'Fiandeiro', '8413': 'Malheiro',
    '8421': 'Acabamento têxtil', '8422': 'Tingidor', '8423': 'Estampador',
    '8601': 'Operador de polímeros', '8602': 'Operador de plástico', '8603': 'Operador de borracha',
    '8611': 'Injetor', '8612': 'Soprador', '8613': 'Extrusor',
    '8621': 'Vulcanizador', '8622': 'Laminador',
    '8625': 'Operador de reciclagem',
    '9101': 'Mineiro', '9102': 'Minerador', '9103': 'Garimpeiro',
    '9111': 'Operador de mina', '9112': 'Operador de britagem', '9113': 'Operador de moagem',
    '9121': 'Perfurador', '9122': 'Detonador',
    '9131': 'Beneficiamento de minérios', '9132': 'Concentração',
    '9141': 'Sondador',
    '9151': 'Operador de construção civil', '9152': 'Operador de pavimentação', '9153': 'Operador de asfalto',
    '9161': 'Pedreiro de construção pesada', '9162': 'Cimenteiro',
    '9171': 'Armador de estrutura', '9172': 'Montador de estrutura',
    '9181': 'Mergulhador', '9182': 'Buzina',
    '9191': 'Trabalhador de demolição', '9192': 'Trabalhador de dragagem',
    '9193': 'Poceiro',
    '9201': 'Impressor gráfico', '9202': 'Operador de impressão', '9203': 'Auxiliar de gráfica',
    '9211': 'Offset', '9212': 'Serigráfico',
    '9401': 'Operador de energia', '9402': 'Operador de geração',
    '9411': 'Eletricista de energia', '9412': 'Eletricista de subestação',
    '9421': 'Operador de hidrelétrica', '9422': 'Operador de termoelétrica',
    '9511': 'Inspetor de qualidade', '9512': 'Controlador de qualidade', '9513': 'Técnico de qualidade',
    '9521': 'Inspetor industrial', '9522': 'Inspetor de processos',
    '9531': 'Laboratorista de qualidade', '9532': 'Analista de qualidade',
    '9541': 'Certificador',
    '9561': 'Segurança do trabalho', '9562': 'Técnico de segurança', '9563': 'Engenheiro de segurança',
    '9571': 'Higiene ocupacional', '9572': 'Medicina do trabalho',
    '9581': 'Bombeiro civil',
    '9601': 'Embalador', '9602': 'Empacotador', '9603': 'Rotulador',
    '9611': 'Alimentador de linha', '9612': 'Auxiliar de embalagem',
    '9621': 'Operador de embalagem',
    '9721': 'Carregador', '9722': 'Ajudante de carga',
    '9731': 'Estivador', '9732': 'Portuário',
    '9741': 'Conferente de carga',
    '9911': 'Motorista', '9912': 'Motorista de caminhão', '9913': 'Motorista de carreta',
    '9914': 'Motorista de van', '9915': 'Motorista de utilitário',
    '9921': 'Operador de transporte', '9922': 'Operador de frota',
    '9923': 'Entregador', '9924': 'Motofrete',
  };

  // ── Helper: parse API response into flat row ──
  function parseApiData(cpf, data) {
    const d = data?.DADOS || {};
    const cboCode = d.CBO || '';
    const cboKey = cboCode.length >= 4 ? cboCode.padEnd(4, '0').substring(0, 4) : '';
    
    // Clean phone numbers: remove (), spaces, dashes
    const cleanPhones = (phones) => {
      if (!Array.isArray(phones)) return [];
      return phones.map(tel => tel.replace(/[()\\s-]/g, '').trim()).filter(tel => tel.length > 0);
    };
    
    const row = {
      cpf, nome: d.NOME || '', sexo: d.SEXO || '',
      nascimento: d.NASC ? d.NASC.substring(0,10) : null,
      nome_mae: d.NOME_MAE || '', nome_pai: d.NOME_PAI || '',
      rg: d.RG || '', renda: d.RENDA || '',
      titulo_eleitor: d.TITULO_ELEITOR || '',
      sit_cad: d.CD_SIT_CAD || '', estciv: d.ESTCIV || '',
      nacionalidade: d.NACIONALID || '', cbo: cboCode,
      cbo_descricao: CBO_DESCRICOES[cboKey] || '',
      orgao_emissor: d.ORGAO_EMISSOR || '', uf_emissao: d.UF_EMISSAO || '',
      data_obito: d.DT_OB ? d.DT_OB.substring(0,10) : null,
      mosaic: d.CD_MOSAIC || '',
      mosaic_novo: d.CD_MOSAIC_NOVO || '',
      mosaic_secundario: d.CD_MOSAIC_SECUNDARIO || '',
      contatos_id: d.CONTATOS_ID || '',
      contatos_id_conjuge: d.CONTATOS_ID_CONJUGE || '',
      cadastro_id: d.CADASTRO_ID || '',
      dt_sit_cad: d.DT_SIT_CAD || null,
      dt_informacao: d.DT_INFORMACAO || '',
      faixa_renda_id: d.FAIXA_RENDA_ID || '',
      so: d.SO || '',
      telefones: JSON.stringify(cleanPhones(data.TELEFONE || [])),
      emails: JSON.stringify(data.EMAIL || []),
      enderecos: JSON.stringify(data.ENDERECOS || []),
      score: JSON.stringify(data.SCORE || []),
      pis: JSON.stringify(data.PIS || []),
      poder_aquisitivo: JSON.stringify(data.PODER_AQUISITIVO || []),
      tse: JSON.stringify(data.TSE || []),
      parentes: typeof data.PARENTES === 'string' ? data.PARENTES : '',
      dados_raw: JSON.stringify(data),
    };
    return row;
  }

  // ── GET /api/consulta/:cpf — busca CPF (cache local → API externa) ──
  app.get('/api/consulta/:cpf', async (req, res) => {
    const cpf = req.params.cpf.replace(/\D/g, '');
    if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido' });

    try {
      // 1. Check local cache
      const cached = await consultaPool.query(`SELECT * FROM cpf_cache WHERE cpf = $1`, [cpf]);
      if (cached.rows.length > 0 && cached.rows[0].dados_raw) {
        const row = cached.rows[0];
        return res.json({
          cache: true, consultado_em: row.consultado_em,
          DADOS: {
            CPF: row.cpf, NOME: row.nome, SEXO: row.sexo, NASC: row.nascimento,
            NOME_MAE: row.nome_mae, NOME_PAI: row.nome_pai, RG: row.rg,
            RENDA: row.renda, TITULO_ELEITOR: row.titulo_eleitor,
            CD_SIT_CAD: row.sit_cad, ESTCIV: row.estciv,
            NACIONALID: row.nacionalidade, CBO: row.cbo,
            CBO_DESCRICAO: row.cbo_descricao || '',
            ORGAO_EMISSOR: row.orgao_emissor, UF_EMISSAO: row.uf_emissao,
            DT_OB: row.data_obito, CD_MOSAIC: row.mosaic,
            CD_MOSAIC_NOVO: row.mosaic_novo || '',
            CD_MOSAIC_SECUNDARIO: row.mosaic_secundario || '',
            CONTATOS_ID: row.contatos_id,
            CONTATOS_ID_CONJUGE: row.contatos_id_conjuge || '',
            CADASTRO_ID: row.cadastro_id || '',
            DT_SIT_CAD: row.dt_sit_cad ? row.dt_sit_cad.substring(0,10) : null,
            DT_INFORMACAO: row.dt_informacao || '',
            FAIXA_RENDA_ID: row.faixa_renda_id || '',
            SO: row.so || '',
          },
          TELEFONE: row.telefones || [],
          EMAIL: row.emails || [],
          ENDERECOS: row.enderecos || [],
          SCORE: row.score || [],
          PIS: row.pis || [],
          PODER_AQUISITIVO: row.poder_aquisitivo || [],
          TSE: row.tse || [],
          PARENTES: row.parentes || '',
        });
      }

      // 2. Fetch from external API
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const apiRes = await fetch(`http://apisbrasilpro.site/api/busca_cpf.php?cpf=${cpf}`, { signal: ctrl.signal });
      clearTimeout(t);
      const data = await apiRes.json();

      if (data?.erro || !data?.DADOS?.CPF) {
        return res.json({ cache: false, erro: 'CPF não encontrado', dados: null });
      }

      // 3. Parse and save (fire-and-forget para não travar a resposta)
      delete data.criado_por;
      const row = parseApiData(cpf, data);
      const vals = Object.values(row);
      consultaPool.query(`
        INSERT INTO cpf_cache (cpf, nome, sexo, nascimento, nome_mae, nome_pai, rg, renda, titulo_eleitor, sit_cad, estciv, nacionalidade, cbo, cbo_descricao, orgao_emissor, uf_emissao, data_obito, mosaic, mosaic_novo, mosaic_secundario, contatos_id, contatos_id_conjuge, cadastro_id, dt_sit_cad, dt_informacao, faixa_renda_id, so, telefones, emails, enderecos, score, pis, poder_aquisitivo, tse, parentes, dados_raw, fonte, consultado_em)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28::jsonb,$29::jsonb,$30::jsonb,$31::jsonb,$32::jsonb,$33::jsonb,$34::jsonb,$35,$36::jsonb,'api',NOW())
        ON CONFLICT (cpf) DO UPDATE SET nome=EXCLUDED.nome, sexo=EXCLUDED.sexo, nascimento=EXCLUDED.nascimento, nome_mae=EXCLUDED.nome_mae, nome_pai=EXCLUDED.nome_pai, rg=EXCLUDED.rg, renda=EXCLUDED.renda, titulo_eleitor=EXCLUDED.titulo_eleitor, sit_cad=EXCLUDED.sit_cad, estciv=EXCLUDED.estciv, nacionalidade=EXCLUDED.nacionalidade, cbo=EXCLUDED.cbo, cbo_descricao=EXCLUDED.cbo_descricao, orgao_emissor=EXCLUDED.orgao_emissor, uf_emissao=EXCLUDED.uf_emissao, data_obito=EXCLUDED.data_obito, mosaic=EXCLUDED.mosaic, mosaic_novo=EXCLUDED.mosaic_novo, mosaic_secundario=EXCLUDED.mosaic_secundario, contatos_id=EXCLUDED.contatos_id, contatos_id_conjuge=EXCLUDED.contatos_id_conjuge, cadastro_id=EXCLUDED.cadastro_id, dt_sit_cad=EXCLUDED.dt_sit_cad, dt_informacao=EXCLUDED.dt_informacao, faixa_renda_id=EXCLUDED.faixa_renda_id, so=EXCLUDED.so, telefones=EXCLUDED.telefones, emails=EXCLUDED.emails, enderecos=EXCLUDED.enderecos, score=EXCLUDED.score, pis=EXCLUDED.pis, poder_aquisitivo=EXCLUDED.poder_aquisitivo, tse=EXCLUDED.tse, parentes=EXCLUDED.parentes, dados_raw=EXCLUDED.dados_raw, consultado_em=NOW()
      `, vals).catch(e => console.error('⚠️ [SAVE CACHE ERROR]', e.message));

      res.json({ cache: false, ...data });
    } catch (e) {
      // Fallback: check cache again (maybe another container fetched it)
      try {
        const fallback = await consultaPool.query(`SELECT * FROM cpf_cache WHERE cpf = $1`, [cpf]);
        if (fallback.rows.length > 0) {
          return res.json({ cache: true, offline: true, DADOS: fallback.rows[0] });
        }
      } catch (_) {}
      res.status(502).json({ error: e.message });
    }
  });

  const API_EXTERNAL = 'http://apisbrasilpro.site/api';

  async function fetchAndSaveExternal(tipo, q) {
    const urlMap = { nome: `${API_EXTERNAL}/busca_nome.php?nome=`, rg: `${API_EXTERNAL}/busca_rg.php?rg=`, mae: `${API_EXTERNAL}/busca_mae.php?mae=`, pai: `${API_EXTERNAL}/busca_pai.php?pai=`, tel: `${API_EXTERNAL}/api_telefone1.php?telefone=` };
    const url = urlMap[tipo];
    if (!url) return null;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(url + encodeURIComponent(q), { signal: ctrl.signal });
      clearTimeout(t);
      const data = await res.json();
      if (!data || data.erro) return null;
      const list = data.RESULTADOS || (data.DADOS ? [data] : []);
      if (!list.length) return null;
      // Save each result to cache (fire-and-forget)
      for (const item of list) {
        const d = item.DADOS || item;
        if (d.CPF) {
          const row = parseApiData(d.CPF.replace(/\D/g, ''), item);
          const vals = Object.values(row);
          consultaPool.query(`
            INSERT INTO cpf_cache (cpf, nome, sexo, nascimento, nome_mae, nome_pai, rg, renda, titulo_eleitor, sit_cad, estciv, nacionalidade, cbo, cbo_descricao, orgao_emissor, uf_emissao, data_obito, mosaic, mosaic_novo, mosaic_secundario, contatos_id, contatos_id_conjuge, cadastro_id, dt_sit_cad, dt_informacao, faixa_renda_id, so, telefones, emails, enderecos, score, pis, poder_aquisitivo, tse, parentes, dados_raw, fonte, consultado_em)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28::jsonb,$29::jsonb,$30::jsonb,$31::jsonb,$32::jsonb,$33::jsonb,$34::jsonb,$35,$36::jsonb,'busca',NOW())
            ON CONFLICT (cpf) DO UPDATE SET nome=EXCLUDED.nome, cbo_descricao=EXCLUDED.cbo_descricao, cbo=EXCLUDED.cbo, consultado_em=NOW()
          `, vals).catch(() => {});
        }
      }
      return data;
    } catch { return null; }
  }

  // ── GET /api/consulta/busca/:tipo?q=valor — busca por nome/RG/mae/tel ──
  app.get('/api/consulta/busca/:tipo', async (req, res) => {
    const { tipo } = req.params;
    const { q } = req.query;
    if (!q || q.length < 2) return res.status(400).json({ error: 'Mínimo 2 caracteres' });

    try {
      const colMap = { nome: 'nome', rg: 'rg', mae: 'nome_mae', pai: 'nome_pai', cbo: 'cbo' };

      if (tipo === 'tel') {
        let r = await consultaPool.query(`SELECT * FROM cpf_cache WHERE telefones::text ILIKE $1 LIMIT 20`, [`%${q}%`]);
        if (r.rows.length === 0) {
          const ext = await fetchAndSaveExternal('tel', q);
          if (ext && (ext.RESULTADOS || ext.DADOS)) return res.json(ext);
        }
        if (r.rows.length === 0) return res.json({ erro: 'Nenhum resultado encontrado', RESULTADOS: [] });
        const results = r.rows.map(row => ({
          DADOS: { CPF: row.cpf, NOME: row.nome, SEXO: row.sexo, NASC: row.nascimento, NOME_MAE: row.nome_mae, NOME_PAI: row.nome_pai, RG: row.rg, RENDA: row.renda, TITULO_ELEITOR: row.titulo_eleitor, CBO: row.cbo, CBO_DESCRICAO: row.cbo_descricao || '' },
          TELEFONE: row.telefones || [], EMAIL: row.emails || [], ENDERECOS: row.enderecos || [],
        }));
        return res.json({ RESULTADOS: results, total: results.length });
      }

      const col = colMap[tipo];
      if (!col) return res.status(400).json({ error: 'Tipo inválido. Use: nome, rg, mae, pai, cbo, tel' });

      let r = await consultaPool.query(`SELECT * FROM cpf_cache WHERE ${col} ILIKE $1 LIMIT 50`, [`%${q}%`]);
      if (r.rows.length === 0) {
        const ext = await fetchAndSaveExternal(tipo, q);
        if (ext && (ext.RESULTADOS || ext.DADOS)) return res.json(ext);
      }
      if (r.rows.length === 0) return res.json({ erro: 'Nenhum resultado encontrado', RESULTADOS: [] });
      const results = r.rows.map(row => ({
        DADOS: { CPF: row.cpf, NOME: row.nome, SEXO: row.sexo, NASC: row.nascimento, NOME_MAE: row.nome_mae, NOME_PAI: row.nome_pai, RG: row.rg, RENDA: row.renda, TITULO_ELEITOR: row.titulo_eleitor, CBO: row.cbo, CBO_DESCRICAO: row.cbo_descricao || '' },
        TELEFONE: row.telefones || [], EMAIL: row.emails || [], ENDERECOS: row.enderecos || [],
      }));
      res.json({ RESULTADOS: results, total: results.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


}

// ══════════════════════════════════════════════════════
// /api/copyurl — Baixa uma página web inteira como ZIP
// ══════════════════════════════════════════════════════

function fetchUrlBuffer(targetUrl, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Muitos redirecionamentos'));
    const mod = targetUrl.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      timeout: 30000,
      rejectUnauthorized: false
    };
    mod.get(targetUrl, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith('/')) {
          const u = new URL(targetUrl);
          redirectUrl = u.origin + redirectUrl;
        }
        return fetchUrlBuffer(redirectUrl, maxRedirects - 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        if (encoding === 'gzip') {
          zlib.gunzip(buffer, (err, decoded) => {
            if (err) reject(err);
            else resolve(decoded);
          });
        } else if (encoding === 'deflate') {
          zlib.inflate(buffer, (err, decoded) => {
            if (err) reject(err);
            else resolve(decoded);
          });
        } else {
          resolve(buffer);
        }
      });
      res.on('error', reject);
    }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
  });
}

function resolveAssetUrl(base, relative) {
  if (!relative || typeof relative !== 'string') return null;
  const trimmed = relative.trim().replace(/\\/g, '/');
  if (trimmed.startsWith('data:') || trimmed.startsWith('javascript:') || trimmed.startsWith('mailto:') || trimmed.startsWith('tel:') || trimmed.startsWith('#')) return null;
  try { return new URL(trimmed, base).href; } catch { return null; }
}

function extractPageAssets(html, baseUrl) {
  const assets = new Set();
  let m;
  const linkRe = /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  while ((m = linkRe.exec(html)) !== null) { const url = resolveAssetUrl(baseUrl, m[1]); if (url) assets.add(url); }
  const scriptRe = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  while ((m = scriptRe.exec(html)) !== null) { const url = resolveAssetUrl(baseUrl, m[1]); if (url) assets.add(url); }
  const imgRe = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*/gi;
  while ((m = imgRe.exec(html)) !== null) { const url = resolveAssetUrl(baseUrl, m[1]); if (url) assets.add(url); }
  const bgRe = /url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi;
  while ((m = bgRe.exec(html)) !== null) { if (m[1].startsWith('data:')) continue; const url = resolveAssetUrl(baseUrl, m[1]); if (url) assets.add(url); }
  const sourceRe = /<source\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*/gi;
  while ((m = sourceRe.exec(html)) !== null) { const url = resolveAssetUrl(baseUrl, m[1]); if (url) assets.add(url); }
  return Array.from(assets);
}

function urlToFilePath(assetUrl, baseUrl) {
  try {
    const asset = new URL(assetUrl);
    const base = new URL(baseUrl);
    let filePath = asset.pathname;
    if (asset.hostname === base.hostname) { filePath = asset.pathname; }
    else { filePath = '/_external/' + asset.hostname + asset.pathname; }
    if (filePath.startsWith('/')) filePath = filePath.substring(1);
    if (filePath.endsWith('/') || filePath === '') filePath += 'index.html';
    filePath = filePath.replace(/[?#]/g, '_').replace(/:/g, '_');
    return filePath;
  } catch { return 'asset_' + Date.now(); }
}

function rewriteHtml(html, baseUrl, assetMap) {
  let result = html;
  for (const [originalUrl, localPath] of assetMap.entries()) {
    const escaped = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'g'), localPath);
  }
  return result;
}

// ══════════════════════════════════════════════════════
// /api/chkr/:cpf — Consulta API chkr.cc
// ══════════════════════════════════════════════════════

app.get('/api/chkr/:cpf', async (req, res) => {
  const cpf = req.params.cpf.replace(/\D/g, '');
  if (cpf.length !== 11) return res.status(400).json({ error: 'CPF inválido' });

  const CHKR_API_URL = process.env.CHKR_API_URL || 'https://api.chkr.cc';
  const CHKR_API_KEY = process.env.CHKR_API_KEY;
  const endpoints = [
    `${CHKR_API_URL}/check?q=${encodeURIComponent(cpf)}`,
    `${CHKR_API_URL}/search?q=${encodeURIComponent(cpf)}`,
    `${CHKR_API_URL}/?q=${encodeURIComponent(cpf)}`,
    `${CHKR_API_URL}/api/check?q=${encodeURIComponent(cpf)}`
  ];
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
  };
  if (CHKR_API_KEY) {
    headers['Authorization'] = `Bearer ${CHKR_API_KEY}`;
    headers['x-api-key'] = CHKR_API_KEY;
  }

  for (const url of endpoints) {
    try {
      const mod = url.startsWith('https') ? https : http;
      const data = await new Promise((resolve, reject) => {
        const req2 = mod.get(url, { headers, timeout: 10000 }, (res2) => {
          let body = '';
          res2.on('data', (c) => body += c);
          res2.on('end', () => {
            try {
              const d = JSON.parse(body);
              if (d && !d.error && Object.keys(d).length > 0) return resolve(d);
              reject(new Error('no data'));
            } catch { reject(new Error('parse error')); }
          });
        });
        req2.on('error', reject);
        req2.on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
      });
      return res.json({ success: true, data });
    } catch {}
  }
  res.json({ success: false, error: 'Nenhum dado encontrado na API chkr.cc' });
});

app.post('/api/copyurl', express.json({ limit: '1mb' }), async (req, res) => {
  let { url } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL é obrigatória' });
  let targetUrl = url.trim();
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) targetUrl = 'https://' + targetUrl;
  try { new URL(targetUrl); } catch { return res.status(400).json({ error: 'URL inválida' }); }

  try {
    const htmlBuffer = await fetchUrlBuffer(targetUrl);
    const html = htmlBuffer.toString('utf-8');
    const assetUrls = extractPageAssets(html, targetUrl);
    const assetMap = new Map();
    const assetBuffers = new Map();
    let downloaded = 0, failed = 0;
    const CONCURRENCY = 10;
    for (let i = 0; i < assetUrls.length; i += CONCURRENCY) {
      const batch = assetUrls.slice(i, i + CONCURRENCY);
      await Promise.allSettled(batch.map(async (assetUrl) => {
        try {
          const buf = await fetchUrlBuffer(assetUrl);
          const localPath = urlToFilePath(assetUrl, targetUrl);
          assetMap.set(assetUrl, localPath);
          assetBuffers.set(localPath, buf);
          downloaded++;
        } catch { failed++; }
      }));
    }
    const rewrittenHtml = rewriteHtml(html, targetUrl, assetMap);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${new URL(targetUrl).hostname.replace(/\./g, '_')}.zip"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(res);
    archive.append(Buffer.from(rewrittenHtml, 'utf-8'), { name: 'index.html' });
    for (const [localPath, buf] of assetBuffers.entries()) {
      archive.append(buf, { name: localPath });
    }
    await archive.finalize();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 NITRO ULTRA v51.0 — Porta ${PORT}`);
  console.log(`   ✅ Modo: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   ✅ Auth local JWT`);
  console.log(`   🔍 Busca: ${pools.length} banco(s) simultâneos\n`);
});

export default app;
