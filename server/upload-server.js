import express from 'express';
import { Pool } from 'pg';
import cors from 'cors';
import { copyFrom } from 'pg-copy-streams';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3002;

const uploadDbUrl = (process.env.UPLOAD_DATABASE_URL || '').replace(/-pooler/, '');
const uploadPool = new Pool({ connectionString: uploadDbUrl, max: 20, idleTimeoutMillis: 300000, connectionTimeoutMillis: 5000, keepAlive: true, ssl: { rejectUnauthorized: false } });

const globalState = { active: false, total: 0, inserted: 0, speed: 0, startTime: 0, skipped: 0, sessionTotal: 0, fonte: '' };
let activeUploadRequests = 0;

function parseLine(line, fonte) {
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
  if (!senha) return null;
  if (!url && !email) return null;
  if (senha.length < 1) return null;
  url = url.replace(/^(URL|Host|Website|Domain|Endereço)\s*:\s*/i, '');
  email = email.replace(/^(Username|User|Login|Email|E-mail|User\s*Name)\s*:\s*/i, '');
  senha = senha.replace(/^(Password|Pass|Senha)\s*:\s*/i, '');
  url = url.trim(); email = email.trim(); senha = senha.trim();
  if (!senha) return null;
  if (!url && !email) return null;
  const cleanUrl = url.substring(0, 450);
  const cleanEmail = email.substring(0, 255);
  const cleanSenha = senha.substring(0, 255);
  if (!cleanSenha) return null;
  if (!cleanUrl && !cleanEmail) return null;
  return `${cleanUrl}\t${cleanEmail}\t${cleanSenha}\t\t${fonte}\n`;
}

async function copyInsert(batchItem) {
  if (!batchItem || batchItem.count === 0) return { inserted: 0, skipped: 0 };
  const { csv, count, poolToUse } = batchItem;
  let client;
  try {
    client = await poolToUse.connect();
    await client.query(`SET synchronous_commit TO OFF; SET statement_timeout = '600s'; SET work_mem = '64MB';`);
    await new Promise((resolve, reject) => {
      const stream = client.query(copyFrom(`COPY credentials (url, email, senha, telefone, fonte) FROM STDIN WITH (FORMAT text, DELIMITER E'\\t', NULL '')`));
      stream.on('finish', resolve);
      stream.on('error', reject);
      stream.write(csv);
      stream.end();
    });
    return { inserted: count, skipped: 0 };
  } catch (e) {
    const lines = csv.split('\n').filter(l => l.length > 0);
    let inserted = 0, skipped = 0;
    for (let i = 0; i < lines.length; i += 1000) {
      const sub = lines.slice(i, i + 1000).join('\n') + '\n';
      try {
        if (!client) client = await poolToUse.connect();
        await new Promise((resolve, reject) => {
          const stream = client.query(copyFrom(`COPY credentials (url, email, senha, telefone, fonte) FROM STDIN WITH (FORMAT text, DELIMITER E'\\t', NULL '')`));
          stream.on('finish', resolve);
          stream.on('error', reject);
          stream.write(sub);
          stream.end();
        });
        inserted += Math.min(1000, lines.length - i);
      } catch {
        for (let j = i; j < Math.min(i + 1000, lines.length); j += 100) {
          const sub2 = lines.slice(j, j + 100).join('\n') + '\n';
          try {
            if (!client) client = await poolToUse.connect();
            await new Promise((resolve, reject) => {
              const stream = client.query(copyFrom(`COPY credentials (url, email, senha, telefone, fonte) FROM STDIN WITH (FORMAT text, DELIMITER E'\\t', NULL '')`));
              stream.on('finish', resolve);
              stream.on('error', reject);
              stream.write(sub2);
              stream.end();
            });
            inserted += Math.min(100, Math.min(i + 1000, lines.length) - j);
          } catch { skipped += Math.min(100, Math.min(i + 1000, lines.length) - j); }
        }
      }
    }
    return { inserted, skipped };
  } finally {
    if (client) client.release();
  }
}

app.use(cors());
app.use(express.text({ type: 'text/plain', limit: '500mb' }));

app.get('/upload', (req, res) => {
  res.sendFile(join(__dirname, 'upload.html'));
});

app.get('/api/upload-progress', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const send = () => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(globalState)}\n\n`); };
  const interval = setInterval(send, 500);
  req.on('close', () => clearInterval(interval));
});

app.post('/api/upload-stream', async (req, res) => {
  req.socket.setTimeout(0);
  req.setTimeout(0);
  res.setTimeout(0);
  const fonte = req.headers['x-source'] ? decodeURIComponent(req.headers['x-source']) : 'unknown';
  const chunkIndex = req.headers['x-chunk-index'] ? parseInt(req.headers['x-chunk-index']) : 0;
  const chunksTotal = req.headers['x-chunks-total'] ? parseInt(req.headers['x-chunks-total']) : 1;
  activeUploadRequests++;
  if (!globalState.startTime) { globalState.total = 0; globalState.inserted = 0; globalState.skipped = 0; globalState.speed = 0; globalState.startTime = Date.now(); }
  globalState.active = true;
  globalState.fonte = fonte;

  const BATCH_SIZE = 100_000;
  const MAX_PARALLEL = 32;
  const MAX_QUEUE = 80;
  let textBuffer = '';
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
      (async (batchToInsert) => {
        let lastErr;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try { const result = await copyInsert(batchToInsert); requestInsertedCount += result.inserted; requestSkippedCount += result.skipped; lastErr = null; break; }
          catch (err) { lastErr = err; if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1))); }
        }
        if (lastErr) { globalState.skipped += batchToInsert.count; }
        activeWorkers--;
        const elapsed = (Date.now() - globalState.startTime) / 1000 || 0.001;
        globalState.speed = Math.round(globalState.inserted / elapsed);
        startWorkers();
      })(currentBatch);
    }
  }

  function flushBatch() {
    if (linesCount === 0) return;
    queue.push({ csv: csvLines.join(''), count: linesCount, poolToUse: uploadPool });
    csvLines = []; linesCount = 0;
    startWorkers();
  }

  try {
    const body = typeof req.body === 'string' ? req.body : '';
    const lines = (textBuffer + body).split('\n');
    textBuffer = lines.pop() || '';
    for (const line of lines) {
      requestParsedCount++;
      globalState.total++;
      const p = parseLine(line, fonteClean);
      if (!p) { requestSkippedCount++; globalState.skipped++; continue; }
      csvLines.push(p);
      linesCount++;
      if (linesCount >= BATCH_SIZE) flushBatch();
    }
    if (textBuffer.length > 0) {
      requestParsedCount++;
      globalState.total++;
      const p = parseLine(textBuffer, fonteClean);
      if (p) { csvLines.push(p); linesCount++; }
      else { requestSkippedCount++; globalState.skipped++; }
    }
    flushBatch();
    res.status(202).json({ success: true, parsed: requestParsedCount, inserted: requestInsertedCount, chunkIndex, chunksTotal });
    try {
      while (activeWorkers > 0 || queue.length > 0) await new Promise(r => setTimeout(r, 50));
    } catch (bgErr) {
      console.error(`⚠️ [UPLOAD BG] ${bgErr.message}`);
    }
  } catch (err) {
    console.error('Upload Error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    activeUploadRequests--;
    if (activeUploadRequests <= 0) { activeUploadRequests = 0; globalState.active = false; }
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 NITRO UPLOAD v50.0 — Porta ${PORT}`);
  console.log(`   ✅ Upload pool: ${uploadDbUrl.substring(0, 80)}...`);
  console.log(`   ✅ BATCH_SIZE: 100K | MAX_PARALLEL: 32 | POOL: 200`);
});
