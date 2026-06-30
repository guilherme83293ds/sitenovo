import crypto from 'crypto';
import dns from 'dns';

const HUNTER_API_KEY = process.env.HUNTER_API_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

function extractLocal(email) {
  if (!email || !email.includes('@')) return null;
  return email.split('@')[0].toLowerCase();
}

function extractDomain(email) {
  if (!email || !email.includes('@')) return null;
  return email.split('@')[1].toLowerCase();
}

async function searchGitHub(email) {
  const results = { users: [], commits: [], code: [] };
  const local = extractLocal(email);
  try {
    const [userRes, commitRes, codeRes] = await Promise.all([
      local
        ? fetch(`https://api.github.com/search/users?q=${encodeURIComponent(local)}+in:login`, {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AssemblyBot', ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}) },
            signal: AbortSignal.timeout(4000)
          }).then(r => r.ok ? r.json() : null).catch(() => null)
        : null,
      fetch(`https://api.github.com/search/commits?q=${encodeURIComponent(email)}`, {
        headers: { Accept: 'application/vnd.github.cloak-preview', 'User-Agent': 'AssemblyBot', ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}) },
        signal: AbortSignal.timeout(4000)
      }).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`https://api.github.com/search/code?q=${encodeURIComponent(email)}+in:file`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AssemblyBot', ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}) },
        signal: AbortSignal.timeout(4000)
      }).then(r => r.ok ? r.json() : null).catch(() => null)
    ]);
    if (userRes && userRes.items) {
      results.users = userRes.items.slice(0, 5).map(u => ({ login: u.login, url: u.html_url }));
    }
    if (commitRes && commitRes.items) {
      results.commits = commitRes.items.slice(0, 5).map(c => ({
        repo: c.repository?.full_name,
        message: c.commit?.message?.split('\n')[0],
        url: c.html_url,
        date: c.commit?.author?.date
      }));
    }
    if (codeRes && codeRes.items) {
      results.code = codeRes.items.slice(0, 5).map(c => ({
        repo: c.repository?.full_name,
        path: c.path,
        url: c.html_url
      }));
    }
  } catch {}
  return results;
}

async function checkSMTP(email) {
  const domain = extractDomain(email);
  if (!domain) return { valid: false, reason: 'Email inválido' };
  try {
    const mxRecords = await dns.promises.resolveMx(domain);
    if (!mxRecords || mxRecords.length === 0) {
      return { valid: false, reason: 'Nenhum registro MX' };
    }
    const mx = mxRecords.sort((a, b) => a.priority - b.priority)[0];
    return {
      valid: true,
      mx: mx.exchange,
      priority: mx.priority,
      total: mxRecords.length
    };
  } catch (e) {
    if (e.code === 'ENOTFOUND') return { valid: false, reason: 'Domínio não existe' };
    if (e.code === 'ENODATA') return { valid: false, reason: 'Domínio sem MX' };
    return { valid: false, reason: 'Falha DNS' };
  }
}

async function socialScan(email) {
  const local = extractLocal(email);
  if (!local) return { profiles: [] };
  const checks = [
    { name: 'GitHub', url: `https://github.com/${local}`, link: `https://github.com/${local}` },
    { name: 'GitLab', url: `https://gitlab.com/${local}`, link: `https://gitlab.com/${local}` },
    { name: 'Twitter/X', url: `https://x.com/${local}`, link: `https://x.com/${local}` },
    { name: 'Instagram', url: `https://www.instagram.com/${local}/`, link: `https://www.instagram.com/${local}/` },
    { name: 'Reddit', url: `https://www.reddit.com/user/${local}`, link: `https://www.reddit.com/user/${local}` },
    { name: 'TikTok', url: `https://www.tiktok.com/@${local}`, link: `https://www.tiktok.com/@${local}` },
    { name: 'YouTube', url: `https://www.youtube.com/@${local}`, link: `https://www.youtube.com/@${local}` },
    { name: 'Twitch', url: `https://www.twitch.tv/${local}`, link: `https://www.twitch.tv/${local}` },
    { name: 'Keybase', url: `https://keybase.io/${local}`, link: `https://keybase.io/${local}` },
    { name: 'Pinterest', url: `https://www.pinterest.com/${local}`, link: `https://www.pinterest.com/${local}` },
    { name: 'Medium', url: `https://medium.com/@${local}`, link: `https://medium.com/@${local}` },
    { name: 'Telegram', url: `https://t.me/${local}`, link: `https://t.me/${local}` },
    { name: 'Replit', url: `https://replit.com/@${local}`, link: `https://replit.com/@${local}` },
    { name: 'DEV.to', url: `https://dev.to/${local}`, link: `https://dev.to/${local}` }
  ];
  const results = await Promise.allSettled(
    checks.map(c =>
      fetch(c.url, { method: 'GET', signal: AbortSignal.timeout(3000), redirect: 'manual' })
        .then(r => (r.status === 200 || r.status === 301 || r.status === 302)
          ? { platform: c.name, url: c.link } : null)
        .catch(() => null)
    )
  );
  const profiles = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) profiles.push(r.value);
  }
  return { profiles, username: local, total: checks.length };
}

async function checkGravatar(email) {
  const hash = crypto.createHash('md5').update(email.trim().toLowerCase()).digest('hex');
  try {
    const res = await fetch(`https://www.gravatar.com/avatar/${hash}?d=404&s=200`, {
      method: 'HEAD', signal: AbortSignal.timeout(3000), redirect: 'follow'
    });
    if (res.ok || res.status === 200 || res.status === 302) {
      return {
        exists: true,
        hash,
        avatarUrl: `https://www.gravatar.com/avatar/${hash}?s=200`,
        profileUrl: `https://www.gravatar.com/${hash}`
      };
    }
    return { exists: false };
  } catch {
    return { exists: false };
  }
}

async function searchHunter(email) {
  if (!HUNTER_API_KEY) return { available: false };
  try {
    const res = await fetch(`https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${HUNTER_API_KEY}`, {
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return { available: false };
    const data = await res.json();
    const d = data.data;
    return {
      available: true,
      result: d.result,
      score: d.score,
      disposable: d.disposable,
      webmail: d.webmail,
      mx_records: d.mx_records,
      smtp_check: d.smtp_check,
      accept_all: d.accept_all,
      block: d.block,
      sources: d.sources?.slice(0, 5) || null
    };
  } catch {
    return { available: false };
  }
}

async function checkEmailRep(email) {
  try {
    await new Promise(r => setTimeout(r, 2000));
    const res = await fetch(`https://emailrep.io/${encodeURIComponent(email)}`, {
      headers: { 'User-Agent': 'AssemblyBot/1.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(4000)
    });
    if (res.status === 404) return { available: false, reason: 'Não encontrado' };
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 3000));
      const retry = await fetch(`https://emailrep.io/${encodeURIComponent(email)}`, {
        headers: { 'User-Agent': 'AssemblyBot/1.0', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(4000)
      });
      if (retry.status === 404) return { available: false, reason: 'Não encontrado' };
      if (!retry.ok) return { available: false, reason: `HTTP ${retry.status}` };
      const d2 = await retry.json();
      return { available: true, reputation: d2.reputation || null, suspicious: d2.suspicious === true, details: d2.details || {} };
    }
    if (!res.ok) return { available: false, reason: `HTTP ${res.status}` };
    const data = await res.json();
    return {
      available: true,
      reputation: data.reputation || null,
      suspicious: data.suspicious === true,
      details: data.details ? {
        blacklisted: data.details.blacklisted === true,
        malicious_activity: data.details.malicious_activity === true,
        credentials_leaked: data.details.credentials_leaked === true,
        data_breach: data.details.data_breach === true,
        first_seen: data.details.first_seen || null,
        last_seen: data.details.last_seen || null,
        domain_exists: data.details.domain_exists === true,
        domain_reputation: data.details.domain_reputation || null,
        disposable: data.details.disposable === true,
        free_provider: data.details.free_provider === true
      } : null
    };
  } catch {
    return { available: false };
  }
}

function formatGitHub(data) {
  const parts = [];
  if (data.users.length > 0) {
    parts.push(`👤 *GitHub:* ${data.users.map(u => `[${u.login}](${u.url})`).join(', ')}`);
  }
  if (data.commits.length > 0) {
    parts.push(`📝 *Commits:* ${data.commits.length}`);
    for (const c of data.commits.slice(0, 3)) {
      const date = c.date ? new Date(c.date).toLocaleDateString('pt-BR') : '?';
      parts.push(`• \`${c.repo}\` — ${c.message} ([link](${c.url})) ${date}`);
    }
  }
  if (data.code.length > 0) {
    parts.push(`📄 *Código:* ${data.code.length} arquivos`);
    for (const c of data.code.slice(0, 3)) {
      parts.push(`• \`${c.repo}/${c.path}\` ([link](${c.url}))`);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function formatSMTP(data) {
  if (data.valid) {
    return `📧 *SMTP:* ✅ MX \`${data.mx}\` (${data.total} servidores)`;
  }
  return `📧 *SMTP:* ❌ ${data.reason}`;
}

function formatSocial(data) {
  if (!data.profiles.length) return null;
  const total = data.total || data.profiles.length;
  const list = data.profiles.map(p => `[${p.platform}](${p.url})`).join(' • ');
  return `🔗 *Perfis sociais:* ${data.profiles.length}/${total}\n${list}`;
}

function formatGravatar(data) {
  if (data.exists) {
    return `👤 *Gravatar:* ✅ [Ver perfil](${data.profileUrl})`;
  }
  return null;
}

function formatHunter(data) {
  if (!data.available) return null;
  const lines = [`🕵️ *Hunter.io:*`];
  if (data.result) lines.push(`• Resultado: \`${data.result}\``);
  if (data.score !== undefined && data.score !== null) lines.push(`• Score: ${data.score}/100`);
  if (data.disposable !== undefined) lines.push(`• Descartável: ${data.disposable ? '⚠️ Sim' : '✅ Não'}`);
  if (data.webmail !== undefined) lines.push(`• Webmail: ${data.webmail ? '✅ Sim' : '❌ Não'}`);
  if (data.mx_records !== undefined) lines.push(`• MX records: ${data.mx_records ? '✅ Sim' : '❌ Não'}`);
  if (data.smtp_check !== undefined) lines.push(`• SMTP check: ${data.smtp_check ? '✅ Passou' : '❌ Falhou'}`);
  if (data.accept_all !== undefined) lines.push(`• Accept all: ${data.accept_all ? '⚠️ Sim' : '✅ Não'}`);
  if (data.block !== undefined) lines.push(`• Bloqueado: ${data.block ? '🚫 Sim' : '✅ Não'}`);
  if (data.sources?.length > 0) {
    const srcList = data.sources.slice(0, 5).map(s => s.uri ? `[${s.domain || s}](${s.uri})` : (s.domain || s));
    lines.push(`• Fontes: ${srcList.join(', ')}`);
  }
  return lines.join('\n');
}

function formatEmailRep(data) {
  if (!data.available) return data.reason ? `⭐ *EmailRep:* ❌ ${data.reason}` : null;
  const d = data.details;
  const lines = [`⭐ *EmailRep:*`];
  if (data.reputation) lines.push(`• Reputação: \`${data.reputation}\``);
  if (data.suspicious) lines.push(`• Suspeito: ⚠️ Sim`);
  if (d) {
    if (d.blacklisted) lines.push(`• Blacklist: ⚠️`);
    if (d.malicious_activity) lines.push(`• Ativ\. maliciosa: ⚠️`);
    if (d.credentials_leaked) lines.push(`• Creds vazadas: ⚠️`);
    if (d.data_breach) lines.push(`• Data breach: ⚠️`);
    if (d.first_seen) lines.push(`• 1ª vez visto: ${d.first_seen}`);
    if (d.last_seen) lines.push(`• Última vez: ${d.last_seen}`);
    if (d.domain_reputation) lines.push(`• Rep\. domínio: \`${d.domain_reputation}\``);
    if (d.domain_exists !== undefined) lines.push(`• Domínio existe: ${d.domain_exists ? '✅' : '❌'}`);
    if (d.free_provider !== undefined) lines.push(`• Provedor gratuito: ${d.free_provider ? '✅ Sim' : '❌ Não'}`);
    if (d.disposable !== undefined) lines.push(`• Descartável: ${d.disposable ? '⚠️' : '✅'}`);
  }
  return lines.join('\n');
}

export {
  searchGitHub, checkSMTP, socialScan, checkGravatar, searchHunter, checkEmailRep,
  formatGitHub, formatSMTP, formatSocial, formatGravatar, formatHunter, formatEmailRep
};
