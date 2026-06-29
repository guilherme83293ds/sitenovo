const SHODAN_KEY = process.env.SHODAN_API_KEY || '';

function formatShodanResult(data) {
  if (!data || data.error) return null;
  const lines = [];
  if (data.ip_str) lines.push(`🌐 *IP:* \`${data.ip_str}\``);
  if (data.hostnames && data.hostnames.length > 0) lines.push(`📌 *Hostnames:* ${data.hostnames.join(', ')}`);
  if (data.org) lines.push(`🏢 *Org:* ${data.org}`);
  if (data.isp) lines.push(`📡 *ISP:* ${data.isp}`);
  if (data.country_name) lines.push(`🌍 *País:* ${data.country_name}${data.city ? `, ${data.city}` : ''}`);
  if (data.os) lines.push(`💻 *OS:* ${data.os}`);
  if (data.ports && data.ports.length > 0) lines.push(`🔌 *Portas:* ${data.ports.slice(0, 20).join(', ')}${data.ports.length > 20 ? ` (+${data.ports.length - 20})` : ''}`);
  if (data.vulns && data.vulns.length > 0) lines.push(`⚠️ *Vulns:* ${data.vulns.slice(0, 10).join(', ')}${data.vulns.length > 10 ? ` (+${data.vulns.length - 10})` : ''}`);
  if (data.tags && data.tags.length > 0) lines.push(`🏷️ *Tags:* ${data.tags.join(', ')}`);
  return lines.join('\n');
}

async function lookupShodan(ip) {
  if (!SHODAN_KEY || !ip) return null;
  try {
    const res = await fetch(`https://api.shodan.io/shodan/host/${encodeURIComponent(ip)}?key=${SHODAN_KEY}`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export { lookupShodan, formatShodanResult };
