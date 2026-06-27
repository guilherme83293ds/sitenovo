const FREE_API_BASE = 'https://cavalier.hudsonrock.com/api/json/v2/osint-tools';
const LEAKCHECK_API = 'https://leakcheck.io/api/public';
const XON_API = 'https://api.xposedornot.com/v1';
const INTELX_BASE = process.env.INTELX_BASE_URL || 'https://free.intelx.io';
const INTELX_KEY = process.env.INTELX_API_KEY || '';
const LEAKLOOKUP_KEY = process.env.LEAKLOOKUP_API_KEY || '';

function mask(text) {
  if (!text) return text;
  if (text.length <= 2) return text[0] + '*'.repeat(text.length - 1);
  return text[0] + '*'.repeat(Math.min(text.length - 2, 8)) + text.slice(-1);
}

function maskEmail(email) {
  if (!email || !email.includes('@')) return mask(email);
  const [local, domain] = email.split('@');
  return mask(local) + '@' + domain;
}

async function searchByEmail(email) {
  const url = `${FREE_API_BASE}/search-by-email?email=${encodeURIComponent(email)}`;
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
  if (!res.ok) return null;
  return res.json();
}

async function searchByUsername(username) {
  const url = `${FREE_API_BASE}/search-by-username?username=${encodeURIComponent(username)}`;
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3000) });
  if (!res.ok) return null;
  return res.json();
}

async function searchLeakCheck(query) {
  const url = `${LEAKCHECK_API}?check=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(3000)
  });
  if (!res.ok) return null;
  return res.json();
}

async function searchXposedOrNot(email) {
  const url = `${XON_API}/check-email/${encodeURIComponent(email)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) return null;
  return res.json();
}

async function searchIntelX(term) {
  if (!INTELX_KEY) return null;
  try {
    const searchRes = await fetch(`${INTELX_BASE}/intelligent/search`, {
      method: 'POST',
      headers: { 'x-key': INTELX_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ term, maxresults: 100, media: 0, terminate: [], timeout: 10 }),
      signal: AbortSignal.timeout(6000)
    });
    if (!searchRes.ok) return null;
    const { id } = await searchRes.json();
    if (!id) return null;
    await new Promise(r => setTimeout(r, 500));
    const resultRes = await fetch(`${INTELX_BASE}/intelligent/search/result?id=${id}&limit=50&offset=0`, {
      headers: { 'x-key': INTELX_KEY },
      signal: AbortSignal.timeout(3000)
    });
    if (!resultRes.ok) return null;
    const data = await resultRes.json();
    // Fetch actual content for first 20 records
    if (data.records && data.records.length > 0) {
      const batch = data.records.slice(0, 10);
      data.records = await Promise.all(batch.map(async (rec) => {
        try {
          const url = `${INTELX_BASE}/intelligent/search/result/item?type=${rec.type || 0}&media=${rec.media || 0}&key=${encodeURIComponent(rec.key || '')}&id=${rec.id}&bucket=${rec.bucket || ''}&term=${encodeURIComponent(term)}&sort=0&limit=1&offset=0`;
          const itemRes = await fetch(url, { headers: { 'x-key': INTELX_KEY }, signal: AbortSignal.timeout(3000) });
          if (itemRes.ok) {
            const itemData = await itemRes.json();
            if (itemData && itemData.records && itemData.records.length > 0) {
              rec.content = itemData.records.map(r => r.value || '').filter(Boolean).join('\n');
            }
          }
        } catch {}
        return rec;
      }));
    }
    return data;
  } catch (e) { return null; }
}

async function searchLeakLookup(query, type = 'email_address') {
  if (!LEAKLOOKUP_KEY) return null;
  const url = 'https://leak-lookup.com/api/search';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `key=${encodeURIComponent(LEAKLOOKUP_KEY)}&type=${encodeURIComponent(type)}&query=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(3000)
  });
  if (!res.ok) return null;
  return res.json();
}

function formatHudsonRockResult(data, searchType, searchValue) {
  if (!data || !data.stealers || data.stealers.length === 0) {
    return `Nenhum resultado encontrado para ${searchType} "${searchValue}"`;
  }

  const stealers = data.stealers;
  let output = '';
  output += `Resultados para ${searchType}: "${searchValue}"\n`;
  output += `Total de dispositivos infectados: ${stealers.length}\n`;
  output += `Total de serviços corporativos: ${data.total_corporate_services ?? 0}\n`;
  output += `Total de serviços de usuário: ${data.total_user_services ?? 0}\n`;
  output += `${'='.repeat(60)}\n\n`;

  stealers.forEach((s, i) => {
    output += `--- Dispositivo ${i + 1} ---\n`;
    output += `Computador: ${s.computer_name || 'N/A'}\n`;
    output += `Sistema: ${s.operating_system || 'N/A'}\n`;
    output += `IP: ${s.ip || 'N/A'}\n`;
    output += `Data do comprometimento: ${s.date_compromised ? new Date(s.date_compromised).toLocaleDateString('pt-BR') : 'N/A'}\n`;
    output += `Família do stealer: ${s.stealer_family || 'N/A'}\n`;
    output += `Antivírus: ${(s.antiviruses || []).join(', ') || 'N/A'}\n`;
    output += `Caminho do malware: ${s.malware_path || 'N/A'}\n`;
    output += `Serviços corporativos: ${s.total_corporate_services ?? 0}\n`;
    output += `Serviços de usuário: ${s.total_user_services ?? 0}\n`;
    if (s.top_logins && s.top_logins.length > 0) {
      output += `Logins encontrados: ${s.top_logins.map(l => maskEmail(l)).join(', ')}\n`;
    }
    if (s.top_passwords && s.top_passwords.length > 0) {
      output += `Senhas encontradas: ${s.top_passwords.map(p => mask(p)).join(', ')}\n`;
    }
    output += `${'-'.repeat(60)}\n\n`;
  });

  return output;
}

async function formatText(searchType, searchValue) {
  let data;
  switch (searchType) {
    case 'email':
      data = await searchByEmail(searchValue);
      break;
    case 'username':
      data = await searchByUsername(searchValue);
      break;
    default:
      return `Tipo de busca inválido: ${searchType}. Use: email, username`;
  }
  return formatHudsonRockResult(data, searchType, searchValue);
}

export { searchByEmail, searchByUsername, searchLeakCheck, searchXposedOrNot, searchIntelX, searchLeakLookup, formatHudsonRockResult, formatText };
