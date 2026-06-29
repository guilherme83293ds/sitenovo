import crypto from 'crypto';

async function checkWhatsApp(numero) {
  const digits = numero.replace(/[^\d]/g, '');
  const full = digits.length <= 11 ? `55${digits}` : digits;
  try {
    const res = await fetch(`https://wa.me/${full}`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (res.status === 302 || res.status === 301) {
      const loc = res.headers.get('location') || '';
      return { exists: loc.includes('wa.me') || loc.includes('whatsapp'), number: full };
    }
    return { exists: false, number: full };
  } catch {
    const res = await fetch(`https://wa.me/${full}`, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(8000) });
    return { exists: res.ok || res.status === 200, number: full };
  }
}

async function scanLink(url) {
  let target = url.trim();
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    const html = await res.text();
    const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || null;
    const desc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1] || null;
    const icon = html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i)?.[1] || null;
    const finalUrl = res.url || target;
    return {
      url: finalUrl,
      status: res.status,
      title,
      description: desc,
      icon,
      server: res.headers.get('server') || null,
      contentType: res.headers.get('content-type') || null
    };
  } catch {
    return { url: target, error: 'Falha ao acessar' };
  }
}

async function reverseImage(imageUrl) {
  try {
    const googleUrl = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`;
    const yandexUrl = `https://yandex.com/images/search?url=${encodeURIComponent(imageUrl)}&rpt=imageview`;
    const res = await fetch(googleUrl, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) });
    return {
      googleLens: googleUrl,
      yandex: yandexUrl,
      googleStatus: res.status
    };
  } catch {
    return {
      googleLens: `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`,
      yandex: `https://yandex.com/images/search?url=${encodeURIComponent(imageUrl)}&rpt=imageview`
    };
  }
}

function checkPixKey(key) {
  const k = key.trim();
  if (/^\d{11}$/.test(k)) return { type: 'CPF', value: k, formatado: `${k.slice(0,3)}.${k.slice(3,6)}.${k.slice(6,9)}-${k.slice(9)}` };
  if (/^\d{14}$/.test(k)) return { type: 'CNPJ', value: k, formatado: `${k.slice(0,2)}.${k.slice(2,5)}.${k.slice(5,8)}/${k.slice(8,12)}-${k.slice(12)}` };
  if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(k)) return { type: 'EMAIL', value: k };
  if (/^\+?\d{10,15}$/.test(k.replace(/[^\d+]/g, ''))) return { type: 'TELEFONE', value: k.replace(/[^\d]/g, '') };
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(k)) return { type: 'ALEATÓRIA', value: k };
  return { type: 'DESCONHECIDO', value: k };
}

async function usernameScan(username) {
  const u = username.trim().toLowerCase();
  const checks = [
    { name: 'GitHub', url: `https://github.com/${u}` },
    { name: 'Twitter', url: `https://twitter.com/${u}` },
    { name: 'Instagram', url: `https://www.instagram.com/${u}/` },
    { name: 'Reddit', url: `https://www.reddit.com/user/${u}` },
    { name: 'Telegram', url: `https://t.me/${u}` },
    { name: 'TikTok', url: `https://www.tiktok.com/@${u}` },
    { name: 'YouTube', url: `https://www.youtube.com/@${u}` },
    { name: 'Twitch', url: `https://www.twitch.tv/${u}` },
    { name: 'GitLab', url: `https://gitlab.com/${u}` },
    { name: 'Keybase', url: `https://keybase.io/${u}` },
    { name: 'Pinterest', url: `https://pinterest.com/${u}` },
    { name: 'Medium', url: `https://medium.com/@${u}` },
    { name: 'DEV', url: `https://dev.to/${u}` },
    { name: 'Replit', url: `https://replit.com/@${u}` }
  ];
  const results = await Promise.allSettled(
    checks.map(c =>
      fetch(c.url, { method: 'GET', signal: AbortSignal.timeout(3000), redirect: 'manual' })
        .then(r => (r.status === 200 || r.status === 301 || r.status === 302) ? c.name : null)
        .catch(() => null)
    )
  );
  const found = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) found.push(r.value);
  }
  return { username: u, total: checks.length, found };
}

async function checkPassword(pass) {
  const hash = crypto.createHash('sha1').update(pass).digest('hex').toUpperCase();
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { pwned: false, error: `HTTP ${res.status}` };
    const text = await res.text();
    const lines = text.split('\n');
    for (const line of lines) {
      const [suf, count] = line.trim().split(':');
      if (suf === suffix) return { pwned: true, count: parseInt(count), hash: hash.slice(0, 10) + '...' };
    }
    return { pwned: false };
  } catch {
    return { pwned: false, error: 'Falha na consulta' };
  }
}

async function searchAddress(query) {
  const q = query.trim();
  if (/^\d{5}-?\d{3}$/.test(q)) {
    const cep = q.replace('-', '');
    try {
      const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { error: `HTTP ${res.status}` };
      const data = await res.json();
      if (data.erro) return { error: 'CEP não encontrado' };
      return { tipo: 'CEP', cep: data.cep, logradouro: data.logradouro, bairro: data.bairro, cidade: data.localidade, estado: data.uf, ibge: data.ibge };
    } catch {
      return { error: 'Falha na consulta' };
    }
  }
  try {
    const res = await fetch(`https://viacep.com.br/ws/${encodeURIComponent(q)}/json/`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    if (!data || data.length === 0) return { error: 'Nada encontrado' };
    const results = data.slice(0, 5).map(d => ({ cep: d.cep, logradouro: d.logradouro, bairro: d.bairro, cidade: d.localidade, estado: d.uf }));
    return { tipo: 'BUSCA', results };
  } catch {
    return { error: 'Falha na consulta' };
  }
}

function formatWhatsApp(data) {
  if (data.exists) return `🟢 *WhatsApp:* ✅ Número \`${data.number}\` tem WhatsApp`;
  return `🟢 *WhatsApp:* ❌ Número \`${data.number}\` não encontrado`;
}

function formatLink(data) {
  if (data.error) return `🔗 *Link Scanner:* ❌ ${data.error}`;
  let msg = `🔗 *Link Scanner:*\n`;
  msg += `• URL: \`${data.url}\`\n`;
  msg += `• Status: ${data.status}\n`;
  if (data.title) msg += `• Título: ${data.title}\n`;
  if (data.description) msg += `• Descrição: ${data.description.slice(0, 200)}\n`;
  if (data.server) msg += `• Servidor: \`${data.server}\`\n`;
  if (data.contentType) msg += `• Tipo: \`${data.contentType}\``;
  return msg;
}

function formatReverseImage(data) {
  return `📸 *Reverse Image:*\n\n• [Google Lens](${data.googleLens})\n• [Yandex](${data.yandex})`;
}

function formatPixKey(data) {
  let msg = `💳 *Pix Key:* Tipo \`${data.type}\``;
  if (data.formatado) msg += `\n• Formatado: \`${data.formatado}\``;
  msg += `\n• Valor: \`${data.value}\``;
  return msg;
}

function formatUsername(data) {
  if (data.found.length === 0) return `👤 *Username:* \`${data.username}\` — Nenhum perfil encontrado`;
  return `👤 *Username:* \`${data.username}\`\n✅ Encontrado em ${data.found.length}/${data.total}:\n\n${data.found.map(p => `• [${p}](${p === 'Telegram' ? 'https://t.me/' + data.username : 'https://' + p.toLowerCase().replace(/\s/g, '') + '.com/' + data.username})`).join('\n')}`;
}

function formatPassword(data) {
  if (data.error) return `🔐 *Password Check:* ❌ ${data.error}`;
  if (data.pwned) return `🔐 *Password Check:* ⚠️ Vazada! ${data.count.toLocaleString()}x encontrada (hash: ${data.hash})`;
  return `🔐 *Password Check:* ✅ Não encontrada em vazamentos`;
}

function formatAddress(data) {
  if (data.error) return `🗺️ *Endereço:* ❌ ${data.error}`;
  if (data.tipo === 'CEP') {
    return `🗺️ *Endereço (CEP ${data.cep}):*\n• ${data.logradouro || 'N/A'}\n• ${data.bairro || 'N/A'}\n• ${data.cidade || 'N/A'} - ${data.estado || 'N/A'}\n• IBGE: ${data.ibge || 'N/A'}`;
  }
  if (data.results) {
    let msg = `🗺️ *Endereços encontrados:*\n\n`;
    data.results.forEach((r, i) => {
      msg += `${i + 1}. ${r.logradouro || ''}, ${r.bairro || ''} — ${r.cidade}/${r.estado} (CEP ${r.cep})\n`;
    });
    return msg;
  }
  return `🗺️ *Endereço:* Nada encontrado`;
}

export async function checkBin(bin) {
  const digits = bin.replace(/\D/g, '').substring(0, 6);
  if (digits.length < 6) return null;
  try {
    const res = await fetch(`https://lookup.binlist.net/${digits}`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export function formatBin(data, bin) {
  if (!data) return `🔢 *BIN ${bin}:* Não encontrado`;
  return `🔢 *BIN Lookup*\n\n` +
    `🔢 *BIN:* \`${bin}\`\n` +
    `💳 *Bandeira:* ${data.scheme || '?'}\n` +
    `🏦 *Banco:* ${data.bank?.name || '?'}\n` +
    `🌐 *Banco URL:* ${data.bank?.url || '?'}\n` +
    `📞 *Banco Tel:* ${data.bank?.phone || '?'}\n` +
    `📋 *Tipo:* ${data.type || '?'}\n` +
    `🏷️ *Categoria:* ${data.brand || '?'}\n` +
    `🌍 *País:* ${data.country?.name || '?'} (${data.country?.alpha2 || '?'})`;
}

export {
  checkWhatsApp, scanLink, reverseImage, checkPixKey, usernameScan, checkPassword, searchAddress,
  formatWhatsApp, formatLink, formatReverseImage, formatPixKey, formatUsername, formatPassword, formatAddress
};
