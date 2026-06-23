import { parentPort } from 'worker_threads';
import crypto from 'crypto';

function sanitize(str) {
  return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function parseLine(line) {
  if (line.length < 5) return null;
  const colon1 = line.indexOf(':');
  if (colon1 === -1) return null;
  const colon2 = line.indexOf(':', colon1 + 1);
  let url = '', email = '', password = '';
  if (colon2 === -1) {
    email = line.substring(0, colon1).trim();
    password = line.substring(colon1 + 1).trim();
  } else {
    url = line.substring(0, colon1).trim();
    email = line.substring(colon1 + 1, colon2).trim();
    password = line.substring(colon2 + 1).trim();
  }
  if (!email || !password) return null;
  
  const sUrl = sanitize(url).slice(0, 500);
  const sEmail = sanitize(email).slice(0, 320);
  const sPass = sanitize(password).slice(0, 500);
  const hash = crypto.createHash('md5').update(`${sUrl}|${sEmail}|${sPass}`).digest('hex');
  
  return [sUrl, sEmail, sPass, hash];
}

parentPort.on('message', ({ lines }) => {
  const processed = [];
  for (const line of lines) {
    const p = parseLine(line);
    if (p) processed.push(p);
  }
  parentPort.postMessage(processed);
});
