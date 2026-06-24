const FREE_API_BASE = 'https://cavalier.hudsonrock.com/api/json/v2/osint-tools';

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
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  return res.json();
}

async function searchByUsername(username) {
  const url = `${FREE_API_BASE}/search-by-username?username=${encodeURIComponent(username)}`;
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  return res.json();
}

function formatHudsonRockResult(data, searchType, searchValue) {
  if (!data || !data.stealers || data.stealers.length === 0) {
    return `HudsonRock: Nenhum resultado encontrado para ${searchType} "${searchValue}"`;
  }

  const stealers = data.stealers;
  let output = '';
  output += `HudsonRock - Resultados para ${searchType}: "${searchValue}"\n`;
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

export { searchByEmail, searchByUsername, formatHudsonRockResult, formatText };
