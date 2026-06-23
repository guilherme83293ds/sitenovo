import { createFileRoute } from "@tanstack/react-router";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { createClient } from "@supabase/supabase-js";
import { buscaEmail, buscaTelefone, buscaSenha, buscaCPF, buscaUsername, buscaNome, formatPairs } from "@/lib/breach-db";

function countResults(r: { sections?: Array<{ fields?: unknown[]; list?: unknown[]; links?: unknown[] }> }): number {
  let n = 0;
  for (const s of r.sections ?? []) {
    n += (s.fields?.length ?? 0) + (s.list?.length ?? 0) + (s.links?.length ?? 0);
  }
  return Math.max(1, n);
}

type Field = { label: string; value: string; mono?: boolean; warn?: boolean; ok?: boolean };
type Section = { title: string; icon?: string; collapsible?: boolean; fields?: Field[]; list?: string[]; links?: { label: string; url: string }[] };
type OsintResult = {
  ok: boolean;
  tool: string;
  query: string;
  summary?: string;
  sections: Section[];
  sources: string[];
  error?: string;
};

const json = (data: OsintResult, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

// ---------- helpers ----------
function unmaskEmail(masked: string, knownEmail: string): string {
  if (!masked.includes("@")) return masked;
  const [maskedLocal, maskedDomain] = masked.split("@");
  const [knownLocal, knownDomain] = knownEmail.toLowerCase().split("@");
  if (maskedDomain.toLowerCase() !== knownDomain) return masked;
  const firstChar = maskedLocal[0];
  if (firstChar && knownLocal[0] === firstChar) {
    return `${knownLocal}@${maskedDomain}`;
  }
  return masked;
}

async function sha1Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function validCPF(raw: string): boolean {
  const cpf = raw.replace(/\D/g, "");
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const calc = (slice: number) => {
    let sum = 0;
    for (let i = 0; i < slice; i++) sum += parseInt(cpf[i]) * (slice + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === parseInt(cpf[9]) && calc(10) === parseInt(cpf[10]);
}

// ---------- tool implementations ----------

// disposable email domains (subset)
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com","10minutemail.com","guerrillamail.com","trashmail.com","tempmail.com",
  "yopmail.com","throwawaymail.com","getnada.com","temp-mail.org","fakeinbox.com",
  "maildrop.cc","dispostable.com","mailnesia.com","mintemail.com","sharklasers.com",
]);
const FREE_PROVIDERS = new Set([
  "gmail.com","googlemail.com","yahoo.com","ymail.com","outlook.com","hotmail.com","live.com",
  "icloud.com","me.com","aol.com","protonmail.com","proton.me","gmx.com","mail.com","zoho.com",
  "yandex.com","yandex.ru","tutanota.com","fastmail.com","uol.com.br","bol.com.br","terra.com.br",
]);

async function dnsHasMx(domain: string): Promise<{ has: boolean; first?: string }> {
  try {
    const r = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`, {
      signal: AbortSignal.timeout(3000),
    });
    const d = await r.json() as { Answer?: { data: string }[] };
    const ans = d.Answer || [];
    return { has: ans.length > 0, first: ans[0]?.data };
  } catch { return { has: false }; }
}

async function toolEmail(email: string): Promise<OsintResult> {
  const sections: Section[] = [];
  const sources: string[] = [];
  const domain = (email.split("@")[1] || "").toLowerCase().trim();

  // Cada operação com seu próprio timeout, falha isolada não derruba tudo
  const [dbResult, mx, hudsonRockResult] = await Promise.allSettled([
    Promise.race([
      buscaEmail(email),
      new Promise<{ rows: any[]; errors: string[] }>((_, reject) =>
        setTimeout(() => reject(new Error("DB timeout")), 35000)
      ),
    ]),
    Promise.race([
      dnsHasMx(domain),
      new Promise<{ has: boolean; first?: string }>((_, reject) =>
        setTimeout(() => reject(new Error("DNS timeout")), 3000)
      ),
    ]),
    Promise.race([
      fetch(`https://cavalier.hudsonrock.com/api/json/v2/osint-tools/search-by-email?email=${encodeURIComponent(email)}`, {
        headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000),
      }).then(r => r.ok ? r.json() : null).catch(() => null),
      new Promise<null>((_, reject) =>
        setTimeout(() => reject(new Error("HudsonRock timeout")), 6000)
      ),
    ]),
  ]);

  // Extrair valores dos resultados
  const db = dbResult.status === "fulfilled" ? dbResult.value : { rows: [], errors: [dbResult.reason?.message || "DB falhou"] };
  const mxVal = mx.status === "fulfilled" ? mx.value : { has: false };
  const hudsonRock = hudsonRockResult.status === "fulfilled" ? hudsonRockResult.value : null;

  // Disposable
  const isDisposable = DISPOSABLE_DOMAINS.has(domain);
  const isFree = FREE_PROVIDERS.has(domain);
  sections.push({
    title: "Disposable Check",
    fields: [
      { label: "Descartável?", value: isDisposable ? "Sim" : "Não", warn: isDisposable, ok: !isDisposable },
      { label: "Provedor gratuito?", value: isFree ? "Sim" : "Não" },
    ],
  });
  sources.push("Lista de domínios descartáveis");

  // MX
  sections.push({
    title: "SMTP Verify — Domínio",
    fields: [
      { label: "Domínio", value: domain || "—", mono: true },
      { label: "MX encontrado?", value: mxVal.has ? "Sim" : "Não", ok: mxVal.has, warn: !mxVal.has },
      { label: "Servidor MX", value: mxVal.first || "—", mono: true },
    ],
  });
  sources.push("Cloudflare DNS (MX)");

  // HudsonRock
  if (hudsonRock) {
    const d = hudsonRock as { stealers?: any[]; total_corporate_services?: number; total_user_services?: number };
    const stealers = d.stealers ?? [];
    sections.push({
      title: "HudsonRock — Stealer logs",
      fields: [
        { label: "Dispositivos", value: String(stealers.length), warn: stealers.length > 0 },
        { label: "Serviços corporativos", value: String(d.total_corporate_services ?? 0) },
        { label: "Serviços de usuário", value: String(d.total_user_services ?? 0) },
      ],
      list: stealers.slice(0, 5).flatMap((s: any, idx: number) => [
        `#${idx + 1}  ${s.computer_name || "?"} · ${s.ip || s.ip_address || "?"} · ${s.country || "?"}`,
      ]),
    });
    sources.push("HudsonRock");
  }

  // SCAM/ABUSE — referências cruzadas em bases públicas de fraude
  sections.push({
    title: "Scam / Abuse — Referências cruzadas",
    icon: `https://www.google.com/s2/favicons?domain=scamsearch.io&sz=64`,
    collapsible: true,
    fields: [
      { label: "ScamSearch", value: "Banco de dados colaborativo de e-mails reportados em golpes" },
      { label: "ScamAdviser", value: "Pontuação de confiança e histórico de denúncias" },
      { label: "CleanTalk", value: "Lista negra anti-spam usada por +500k sites" },
      { label: "StopForumSpam", value: "E-mails associados a spam/abuse em fóruns" },
      { label: "AbuseIPDB Email", value: "Cruzamento de e-mails com IPs reportados por abuse" },
    ],
    links: [
      { label: "ScamSearch", url: `https://scamsearch.io/search_report?searchoption=all&search=${encodeURIComponent(email)}` },
      { label: "ScamAdviser", url: `https://www.scamadviser.com/check-website/${encodeURIComponent(email.split("@")[1] || "")}` },
      { label: "CleanTalk", url: `https://cleantalk.org/blacklists/${encodeURIComponent(email)}` },
      { label: "StopForumSpam", url: `https://www.stopforumspam.com/search?q=${encodeURIComponent(email)}` },
      { label: "AbuseIPDB", url: `https://www.abuseipdb.com/check/${encodeURIComponent(email.split("@")[1] || "")}` },
    ],
  });
  sources.push("ScamSearch", "ScamAdviser", "CleanTalk", "StopForumSpam", "AbuseIPDB");

  // Identidade pública (links externos)
  const md5 = await sha1Hex(email.trim().toLowerCase());
  sections.push({
    title: "Identidade pública — Links",
    links: [
      { label: "Gravatar", url: `https://gravatar.com/${md5.toLowerCase().slice(0, 32)}` },
      { label: "Google", url: `https://www.google.com/search?q=${encodeURIComponent(`"${email}"`)}` },
      { label: "GitHub commits", url: `https://github.com/search?q=${encodeURIComponent(email)}&type=commits` },
      { label: "LeakLookup", url: `https://leak-lookup.com/?q=${encodeURIComponent(email)}` },
      { label: "DeHashed", url: `https://dehashed.com/search?query=${encodeURIComponent(email)}` },
      { label: "IntelX", url: `https://intelx.io/?s=${encodeURIComponent(email)}` },
    ],
  });
  sources.push("Gravatar", "Google", "GitHub", "LeakLookup", "DeHashed", "IntelX");

  // BreachDB (já resolvido no Promise.all)
  const { rows: dbRows, errors: dbErrors } = db;
  if (dbRows.length > 0) {
    const unique = new Map<string, { senha: string; telefone?: string; fonte?: string }>();
    for (const r of dbRows) {
      if (!unique.has(r.email + ":" + r.senha)) {
        unique.set(r.email + ":" + r.senha, { senha: r.senha, telefone: r.telefone, fonte: r.fonte });
      }
    }
    sections.splice(0, 0, {
      title: `BreachDB — Credenciais encontradas (${dbRows.length})`,
      fields: [
        { label: "Total de pares", value: String(dbRows.length) },
        { label: "Pares únicos", value: String(unique.size) },
      ],
      list: [...unique.entries()].slice(0, 200).map(([key, val], i) => {
        const [e, p] = key.split(":");
        const [local, dom] = e.split("@");
        const maskedEmail = `${local.slice(0, 2)}${"•".repeat(Math.min(local.length - 2, 6))}@${dom}`;
        const maskedPass = p.length > 4
          ? p.slice(0, 1) + "•".repeat(Math.min(p.length - 2, 6)) + p.slice(-1)
          : "•".repeat(p.length);
        const tel = val.telefone ? ` · tel: ${val.telefone.slice(0, 4)}••••` : "";
        return `#${i + 1}  ${maskedEmail}:${maskedPass}${tel}`;
      }),
    });
    sources.unshift("BreachDB (Neon)");
  }
  if (dbErrors.length > 0) {
    sections.push({
      title: "BreachDB — Erros de conexão",
      fields: dbErrors.map(e => ({ label: "Erro", value: e, warn: true })),
    });
  }

  return {
    ok: true, tool: "email", query: email,
    summary: `${sections.length} módulos consultados · ${dbRows.length} registros no DB`,
    sections, sources,
  };
}

async function toolPassword(password: string): Promise<OsintResult> {
  // Dispara BreachDB em paralelo com HIBP + heurísticas
  const dbPromise = buscaSenha(password);
  const hashPromise = sha1Hex(password);

  const hash = await hashPromise;
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  const r = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`);
  if (!r.ok) throw new Error("HIBP error");
  const text = await r.text();
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.toUpperCase().startsWith(suffix));
  const count = line ? parseInt(line.split(":")[1] ?? "0", 10) : 0;

  // Heurísticas de força
  const length = password.length;
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasDigit = /\d/.test(password);
  const hasSymbol = /[^A-Za-z0-9]/.test(password);
  const variety = [hasUpper, hasLower, hasDigit, hasSymbol].filter(Boolean).length;
  const strength =
    length >= 16 && variety >= 3 ? "Forte" :
    length >= 12 && variety >= 2 ? "Média" :
    "Fraca";

  // Bases de consulta (chips com favicon)
  const REFS: { name: string; domain: string; url: string; note: string }[] = [
    { name: "Have I Been Pwned", domain: "haveibeenpwned.com", url: "https://haveibeenpwned.com/Passwords", note: "Maior base pública de senhas vazadas (>800M hashes)." },
    { name: "DeHashed", domain: "dehashed.com", url: "https://dehashed.com/", note: "Busca em dumps por senha em texto claro (requer assinatura)." },
    { name: "LeakCheck", domain: "leakcheck.io", url: "https://leakcheck.io/", note: "Indexação de credenciais em vazamentos públicos." },
    { name: "Snusbase", domain: "snusbase.com", url: "https://snusbase.com/", note: "Pesquisa por senha em dumps de credenciais (pago)." },
    { name: "Scattered Secrets", domain: "scatteredsecrets.com", url: "https://scatteredsecrets.com/", note: "Verificação por hash em dumps reais." },
    { name: "IntelX", domain: "intelx.io", url: `https://intelx.io/?s=${encodeURIComponent(prefix)}`, note: "Index de leaks, pastes e dark web." },
    { name: "Leak-Lookup", domain: "leak-lookup.com", url: "https://leak-lookup.com/", note: "Mecanismo de busca em vazamentos." },
    { name: "BreachDirectory", domain: "breachdirectory.org", url: "https://breachdirectory.org/", note: "Pesquisa gratuita por email/senha em breaches." },
  ];
  const sections: Section[] = [
    {
      title: "Have I Been Pwned",
      fields: [
        { label: "Hash prefix (k-anonymity)", value: prefix, mono: true },
        { label: "Ocorrências", value: count.toLocaleString("pt-BR"), warn: count > 0, ok: count === 0 },
        { label: "Status", value: count > 0 ? "Vazada — troque imediatamente" : "Não encontrada em vazamentos conhecidos", warn: count > 0, ok: count === 0 },
      ],
    },
    {
      title: "Força da senha (heurística local)",
      fields: [
        { label: "Comprimento", value: String(length) },
        { label: "Maiúsculas", value: hasUpper ? "Sim" : "Não" },
        { label: "Minúsculas", value: hasLower ? "Sim" : "Não" },
        { label: "Dígitos", value: hasDigit ? "Sim" : "Não" },
        { label: "Símbolos", value: hasSymbol ? "Sim" : "Não" },
        { label: "Classificação", value: strength, ok: strength === "Forte", warn: strength === "Fraca" },
      ],
    },
    ...REFS.map<Section>((ref) => ({
      title: `${ref.name} — ${ref.domain}`,
      icon: `https://www.google.com/s2/favicons?domain=${ref.domain}&sz=64`,
      collapsible: true,
      fields: [
        { label: "Fonte", value: ref.name },
        { label: "Domínio", value: ref.domain, mono: true },
        { label: "Descrição", value: ref.note },
      ],
      links: [{ label: `Consultar em ${ref.name}`, url: ref.url }],
    })),
  ];

  // BreachDB (disparado em paralho no início)
  const { rows: dbRows, errors: dbErrors } = await dbPromise;
  if (dbErrors.length > 0) {
    sections.push({
      title: "BreachDB — Erros de conexão",
      fields: dbErrors.map(e => ({ label: "Erro", value: e, warn: true })),
    });
  }
  if (dbRows.length > 0) {
    const unique = new Map<string, string>();
    const uniqueEmails = new Set<string>();
    for (const r of dbRows) {
      unique.set(r.email + ":" + r.senha, r.fonte || "");
      uniqueEmails.add(r.email);
    }
    const breachSection: Section = {
      title: `BreachDB — Senha encontrada em ${dbRows.length} registros`,
      fields: [
        { label: "Total de ocorrências", value: String(dbRows.length), warn: true },
        { label: "Pares únicos", value: String(unique.size), warn: true },
        { label: "Emails associados", value: String(uniqueEmails.size) },
      ],
      list: [...unique.entries()].slice(0, 200).map(([key, fonte], i) => {
        const [e, p] = key.split(":");
        const [local, dom] = e.split("@");
        const maskedEmail = `${local.slice(0, 2)}${"•".repeat(Math.min(local.length - 2, 6))}@${dom}`;
        const maskedPass = p.length > 4
          ? p.slice(0, 1) + "•".repeat(Math.min(p.length - 2, 6)) + p.slice(-1)
          : "•".repeat(p.length);
        const f = fonte ? ` [${fonte}]` : "";
        return `#${i + 1}  ${maskedEmail}:${maskedPass}${f}`;
      }),
    };
    const summaryExtra = ` · ${dbRows.length} registros no BreachDB`;
    return {
      ok: true,
      tool: "password",
      query: "•••",
      summary: (count > 0
        ? `Senha vazada ${count.toLocaleString("pt-BR")} vezes · força: ${strength}`
        : `Senha não encontrada em vazamentos · força: ${strength}`) + summaryExtra,
      sections: [breachSection, ...sections],
      sources: ["BreachDB (Neon)", "HIBP Pwned Passwords", ...REFS.map(r => r.name)],
    };
  }
  return {
    ok: true,
    tool: "password",
    query: "•••",
    summary: count > 0
      ? `Senha vazada ${count.toLocaleString("pt-BR")} vezes · força: ${strength}`
      : `Senha não encontrada em vazamentos · força: ${strength}`,
    sections,
    sources: ["HIBP Pwned Passwords", ...REFS.map(r => r.name)],
  };
}

async function toolIp(ip: string): Promise<OsintResult> {
  const r = await fetch(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, {
    headers: { accept: "application/json" },
  });
  const d = await r.json() as {
    ip?: string; hostname?: string; city?: string; region?: string; country?: string;
    loc?: string; org?: string; postal?: string; timezone?: string; anycast?: boolean;
    bogon?: boolean; error?: { title?: string; message?: string };
  };
  if (d.error) throw new Error(d.error.message || d.error.title || "Erro ipinfo.io");
  if (!d.ip) throw new Error("IP inválido");
  if (d.bogon) {
    return {
      ok: true, tool: "ip", query: String(d.ip),
      summary: `${d.ip} é um endereço bogon (não roteável publicamente)`,
      sections: [{ title: "Bogon", fields: [{ label: "IP", value: String(d.ip), mono: true, warn: true }] }],
      sources: ["ipinfo.io"],
    };
  }
  return {
    ok: true,
    tool: "ip",
    query: String(d.ip),
    summary: `${d.city || "?"}, ${d.region || "?"} — ${d.country || "?"} (${d.org || "?"})`,
    sections: [
      {
        title: "Geolocalização",
        fields: [
          { label: "País", value: String(d.country || "—") },
          { label: "Região", value: String(d.region || "—") },
          { label: "Cidade", value: String(d.city || "—") },
          { label: "CEP", value: String(d.postal || "—") },
          { label: "Lat/Lon", value: String(d.loc || "—"), mono: true },
          { label: "Fuso", value: String(d.timezone || "—") },
        ],
      },
      {
        title: "Rede",
        fields: [
          { label: "Organização (ASN)", value: String(d.org || "—") },
          { label: "Hostname", value: String(d.hostname || "—"), mono: true },
          { label: "Anycast", value: d.anycast ? "Sim" : "Não", warn: !!d.anycast },
        ],
      },
    ],
    sources: ["ipinfo.io"],
  };
}

async function toolDomain(domain: string): Promise<OsintResult> {
  const clean = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim();
  const sections: Section[] = [];

  // DNS records via Cloudflare DoH
  const types = ["A", "AAAA", "MX", "NS", "TXT", "CNAME"];
  const dnsResults = await Promise.all(types.map(async (t) => {
    try {
      const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(clean)}&type=${t}`, {
        headers: { accept: "application/dns-json" },
      });
      const d = await r.json() as { Answer?: { data: string }[] };
      return { t, answers: (d.Answer || []).map((a) => a.data) };
    } catch {
      return { t, answers: [] as string[] };
    }
  }));
  sections.push({
    title: "DNS",
    fields: dnsResults.flatMap((r) =>
      r.answers.length ? r.answers.map((v) => ({ label: r.t, value: v, mono: true })) : [],
    ),
  });

  // Subdomains via crt.sh
  try {
    const r = await fetch(`https://crt.sh/?q=%25.${encodeURIComponent(clean)}&output=json`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const d = await r.json() as { name_value: string }[];
      const subs = Array.from(new Set(d.flatMap((row) => row.name_value.split("\n")))).filter((s) => s.endsWith(clean));
      sections.push({ title: `Subdomínios (${subs.length})`, list: subs.slice(0, 50) });
    }
  } catch { /* ignore */ }

  return {
    ok: true,
    tool: "domain",
    query: clean,
    summary: `${dnsResults.find((r) => r.t === "A")?.answers[0] || "Sem A"} • ${dnsResults.find((r) => r.t === "NS")?.answers.length || 0} NS`,
    sections,
    sources: ["Cloudflare DNS", "crt.sh"],
  };
}

async function toolCpfCnpj(raw: string): Promise<OsintResult> {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11) {
    const ok = validCPF(digits);
    const sections: Section[] = [
      {
        title: "CPF",
        fields: [
          { label: "Número", value: digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4"), mono: true },
          { label: "Algoritmo", value: ok ? "Válido" : "Inválido", ok, warn: !ok },
          { label: "Região fiscal", value: `Região ${digits[8]} (${["RS","DF/GO/MS/MT/TO","AC/AM/AP/PA/RO/RR","CE/MA/PI","PB/PE/RN/AL","BA/SE","MG","ES/RJ","SP","PR/SC"][parseInt(digits[8])]})` },
        ],
      },
    ];
    const sources = ["Algoritmo do Módulo 11"];

    // CONSULTA database
    try {
      const cpfData = await buscaCPF(digits);
      if (cpfData) {
        const fields: Field[] = [];
        if (cpfData.nome) fields.push({ label: "Nome completo", value: cpfData.nome });
        if (cpfData.sexo) fields.push({ label: "Sexo", value: cpfData.sexo });
        if (cpfData.nascimento) fields.push({ label: "Nascimento", value: String(cpfData.nascimento).split("T")[0] });
        if (cpfData.nome_mae) fields.push({ label: "Nome da mãe", value: cpfData.nome_mae });
        if (cpfData.nome_pai) fields.push({ label: "Nome do pai", value: cpfData.nome_pai || "—" });
        if (cpfData.rg) fields.push({ label: "RG", value: cpfData.rg });
        if (cpfData.orgao_emissor) fields.push({ label: "Órgão emissor", value: cpfData.orgao_emissor });
        if (cpfData.uf_emissao) fields.push({ label: "UF emissão", value: cpfData.uf_emissao });
        if (cpfData.sit_cad) fields.push({ label: "Situação cadastral", value: cpfData.sit_cad });
        if (cpfData.estciv) fields.push({ label: "Estado civil", value: cpfData.estciv });
        if (cpfData.nacionalidade) fields.push({ label: "Nacionalidade", value: cpfData.nacionalidade });
        if (cpfData.cbo_descricao) fields.push({ label: "Profissão", value: cpfData.cbo_descricao });
        if (cpfData.renda) fields.push({ label: "Renda", value: cpfData.renda });
        if (cpfData.titulo_eleitor) fields.push({ label: "Título de eleitor", value: cpfData.titulo_eleitor });
        if (cpfData.data_obito) fields.push({ label: "Data de óbito", value: String(cpfData.data_obito).split("T")[0], warn: true });

        sections.push({ title: "Dados cadastrais (CPF)", fields });

        if (cpfData.telefones && Array.isArray(cpfData.telefones) && cpfData.telefones.length > 0) {
          sections.push({
            title: `Telefones (${cpfData.telefones.length})`,
            list: cpfData.telefones.map((t: any) => typeof t === "string" ? t : JSON.stringify(t)),
          });
        }
        if (cpfData.emails && Array.isArray(cpfData.emails) && cpfData.emails.length > 0) {
          sections.push({
            title: `E-mails (${cpfData.emails.length})`,
            list: cpfData.emails.map((e: any) => typeof e === "string" ? e : JSON.stringify(e)),
          });
        }
        if (cpfData.enderecos && Array.isArray(cpfData.enderecos) && cpfData.enderecos.length > 0) {
          sections.push({
            title: `Endereços (${cpfData.enderecos.length})`,
            list: cpfData.enderecos.map((e: any) => typeof e === "string" ? e : JSON.stringify(e)),
          });
        }
        if (cpfData.parentes) {
          sections.push({ title: "Parentes", list: [cpfData.parentes] });
        }
        sources.push("CONSULTA Database");
      }
      return {
        ok: true,
        tool: "cpf",
        query: raw,
        summary: ok ? `CPF válido${cpfData?.nome ? ` · ${cpfData.nome}` : ""}` : "CPF inválido",
        sections,
        sources,
      };
    } catch {
      return {
        ok: true,
        tool: "cpf",
        query: raw,
        summary: ok ? "CPF formalmente válido" : "CPF inválido",
        sections: [
          ...sections,
          { title: "Observação", fields: [{ label: "Dados", value: "Dados cadastrais de CPF exigem autorização legal e não são públicos no Brasil." }] },
        ],
        sources,
      };
    }
  }
  if (digits.length === 14) {
    return fetch(`https://brasilapi.com.br/api/cnpj/v1/${digits}`).then(async (r) => {
      if (!r.ok) throw new Error("CNPJ não encontrado");
      const d = await r.json() as Record<string, unknown> & { qsa?: { nome_socio: string; qualificacao_socio: string }[] };
      return {
        ok: true,
        tool: "cnpj",
        query: raw,
        summary: `${d.razao_social} — ${d.descricao_situacao_cadastral}`,
        sections: [
          {
            title: "Empresa",
            fields: [
              { label: "Razão social", value: String(d.razao_social) },
              { label: "Nome fantasia", value: String(d.nome_fantasia || "—") },
              { label: "Situação", value: String(d.descricao_situacao_cadastral) },
              { label: "Abertura", value: String(d.data_inicio_atividade) },
              { label: "Porte", value: String(d.porte) },
              { label: "Capital social", value: `R$ ${Number(d.capital_social).toLocaleString("pt-BR")}` },
              { label: "Atividade principal", value: String(d.cnae_fiscal_descricao) },
            ],
          },
          {
            title: "Endereço",
            fields: [
              { label: "Logradouro", value: `${d.descricao_tipo_de_logradouro} ${d.logradouro}, ${d.numero}` },
              { label: "Bairro", value: String(d.bairro) },
              { label: "Município/UF", value: `${d.municipio}/${d.uf}` },
              { label: "CEP", value: String(d.cep) },
              { label: "Telefone", value: String(d.ddd_telefone_1 || "—") },
            ],
          },
          {
            title: "Quadro societário",
            list: (d.qsa || []).map((s) => `${s.nome_socio} — ${s.qualificacao_socio}`),
          },
        ],
        sources: ["BrasilAPI / Receita Federal"],
      } as OsintResult;
    });
  }
  return Promise.resolve({
    ok: false,
    tool: "cpf",
    query: raw,
    error: "Informe 11 dígitos (CPF) ou 14 dígitos (CNPJ).",
    sections: [],
    sources: [],
  });
}

async function toolPhone(raw: string): Promise<OsintResult> {
  const p = parsePhoneNumberFromString(raw, "BR");
  if (!p) {
    return { ok: false, tool: "phone", query: raw, error: "Número inválido", sections: [], sources: [] };
  }
  const dbPromise = buscaTelefone(raw);

  const sections: Section[] = [
    {
      title: "Número",
      fields: [
        { label: "E.164", value: p.number, mono: true },
        { label: "Internacional", value: p.formatInternational(), mono: true },
        { label: "Nacional", value: p.formatNational(), mono: true },
        { label: "País", value: String(p.country || "—") },
        { label: "DDD/região", value: String(p.nationalNumber).slice(0, 2) },
        { label: "Tipo", value: String(p.getType() || "desconhecido") },
        { label: "Válido", value: p.isValid() ? "Sim" : "Não", ok: p.isValid(), warn: !p.isValid() },
        { label: "Possível", value: p.isPossible() ? "Sim" : "Não" },
      ],
    },
    {
      title: "Busca",
      links: [
        { label: "Google", url: `https://www.google.com/search?q=${encodeURIComponent(`"${p.number}" OR "${p.formatNational()}"`)}` },
        { label: "Truecaller", url: `https://www.truecaller.com/search/br/${encodeURIComponent(p.nationalNumber)}` },
      ],
    },
  ];
  const sources = ["libphonenumber-js"];

  const { rows: dbRows, errors: dbErrors } = await dbPromise;
  if (dbErrors.length > 0) {
    sections.push({
      title: "BreachDB — Erros de conexão",
      fields: dbErrors.map(e => ({ label: "Erro", value: e, warn: true })),
    });
  }
  if (dbRows.length > 0) {
    const unique = new Map<string, string>();
    for (const r of dbRows) {
      unique.set(r.email + ":" + r.senha, r.fonte || "");
    }
    sections.push({
      title: `BreachDB — Credenciais encontradas (${dbRows.length})`,
      fields: [
        { label: "Total", value: String(dbRows.length), warn: true },
        { label: "Pares únicos", value: String(unique.size) },
      ],
      list: [...unique.entries()].slice(0, 200).map(([key, fonte], i) => {
        const [e, p] = key.split(":");
        const [local, dom] = e.split("@");
        const maskedEmail = `${local.slice(0, 2)}${"•".repeat(Math.min(local.length - 2, 6))}@${dom}`;
        const maskedPass = p.length > 4
          ? p.slice(0, 1) + "•".repeat(Math.min(p.length - 2, 6)) + p.slice(-1)
          : "•".repeat(p.length);
        const f = fonte ? ` [${fonte}]` : "";
        return `#${i + 1}  ${maskedEmail}:${maskedPass}${f}`;
      }),
    });
    sources.push("BreachDB (Neon)");
  }

  return {
    ok: true,
    tool: "phone",
    query: raw,
    summary: `${p.country} • ${p.getType() || "desconhecido"} • ${p.isValid() ? "válido" : "inválido"}${dbRows.length > 0 ? ` · ${dbRows.length} registros` : ""}`,
    sections,
    sources,
  };
}

const USERNAME_SITES: { name: string; domain: string; url: (u: string) => string }[] = [
  { name: "GitHub", domain: "github.com", url: (u) => `https://github.com/${u}` },
  { name: "GitLab", domain: "gitlab.com", url: (u) => `https://gitlab.com/${u}` },
  { name: "BitBucket", domain: "bitbucket.org", url: (u) => `https://bitbucket.org/${u}` },
  { name: "Twitter / X", domain: "x.com", url: (u) => `https://x.com/${u}` },
  { name: "Instagram", domain: "instagram.com", url: (u) => `https://www.instagram.com/${u}/` },
  { name: "TikTok", domain: "tiktok.com", url: (u) => `https://www.tiktok.com/@${u}` },
  { name: "YouTube", domain: "youtube.com", url: (u) => `https://www.youtube.com/@${u}` },
  { name: "Reddit", domain: "reddit.com", url: (u) => `https://www.reddit.com/user/${u}` },
  { name: "Twitch", domain: "twitch.tv", url: (u) => `https://www.twitch.tv/${u}` },
  { name: "Medium", domain: "medium.com", url: (u) => `https://medium.com/@${u}` },
  { name: "Steam", domain: "steamcommunity.com", url: (u) => `https://steamcommunity.com/id/${u}` },
  { name: "Pinterest", domain: "pinterest.com", url: (u) => `https://www.pinterest.com/${u}/` },
  { name: "DeviantArt", domain: "deviantart.com", url: (u) => `https://www.deviantart.com/${u}` },
  { name: "Dev.to", domain: "dev.to", url: (u) => `https://dev.to/${u}` },
  { name: "HackerNews", domain: "news.ycombinator.com", url: (u) => `https://news.ycombinator.com/user?id=${u}` },
  { name: "Replit", domain: "replit.com", url: (u) => `https://replit.com/@${u}` },
  { name: "Vimeo", domain: "vimeo.com", url: (u) => `https://vimeo.com/${u}` },
  { name: "Spotify", domain: "spotify.com", url: (u) => `https://open.spotify.com/user/${u}` },
  { name: "SoundCloud", domain: "soundcloud.com", url: (u) => `https://soundcloud.com/${u}` },
  { name: "Behance", domain: "behance.net", url: (u) => `https://www.behance.net/${u}` },
  { name: "Dribbble", domain: "dribbble.com", url: (u) => `https://dribbble.com/${u}` },
  { name: "Keybase", domain: "keybase.io", url: (u) => `https://keybase.io/${u}` },
  { name: "Telegram", domain: "t.me", url: (u) => `https://t.me/${u}` },
  { name: "Facebook", domain: "facebook.com", url: (u) => `https://www.facebook.com/${u}` },
  { name: "Snapchat", domain: "snapchat.com", url: (u) => `https://www.snapchat.com/add/${u}` },
  { name: "Pastebin", domain: "pastebin.com", url: (u) => `https://pastebin.com/u/${u}` },
  { name: "Patreon", domain: "patreon.com", url: (u) => `https://www.patreon.com/${u}` },
  { name: "Flickr", domain: "flickr.com", url: (u) => `https://www.flickr.com/people/${u}` },
  { name: "Last.fm", domain: "last.fm", url: (u) => `https://www.last.fm/user/${u}` },
  { name: "Disqus", domain: "disqus.com", url: (u) => `https://disqus.com/by/${u}` },
  { name: "Kaggle", domain: "kaggle.com", url: (u) => `https://www.kaggle.com/${u}` },
  { name: "CodePen", domain: "codepen.io", url: (u) => `https://codepen.io/${u}` },
  { name: "Producthunt", domain: "producthunt.com", url: (u) => `https://www.producthunt.com/@${u}` },
  { name: "Mixcloud", domain: "mixcloud.com", url: (u) => `https://www.mixcloud.com/${u}/` },
  { name: "About.me", domain: "about.me", url: (u) => `https://about.me/${u}` },
  { name: "Wattpad", domain: "wattpad.com", url: (u) => `https://www.wattpad.com/user/${u}` },
  { name: "Quora", domain: "quora.com", url: (u) => `https://www.quora.com/profile/${u}` },
  { name: "Goodreads", domain: "goodreads.com", url: (u) => `https://www.goodreads.com/${u}` },
  { name: "Imgur", domain: "imgur.com", url: (u) => `https://imgur.com/user/${u}` },
];

async function toolUsername(username: string): Promise<OsintResult> {
  const u = username.replace(/^@/, "").trim();
  // Dispara BreachDB em paralelo com as verificações de plataforma
  const dbPromise = buscaUsername(u);

  const checks = await Promise.all(USERNAME_SITES.map(async (s) => {
    const url = s.url(u);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(url, { method: "GET", redirect: "manual", signal: ctrl.signal, headers: { "user-agent": "Mozilla/5.0 NoxIntel-OSINT" } });
      clearTimeout(t);
      const found = r.status === 200;
      return { site: s, url, status: r.status, found };
    } catch {
      return { site: s, url, status: 0, found: false };
    }
  }));
  const hits = checks.filter((c) => c.found);
  const sections: Section[] = checks.map((c) => ({
    title: `${c.site.name} — ${c.site.domain}`,
    icon: `https://www.google.com/s2/favicons?domain=${c.site.domain}&sz=64`,
    collapsible: true,
    fields: [
      { label: "Status", value: c.found ? "Perfil encontrado" : c.status === 0 ? "Erro de rede" : `Não encontrado (HTTP ${c.status})`, ok: c.found, warn: c.found },
      { label: "URL", value: c.url, mono: true },
      { label: "Plataforma", value: c.site.domain, mono: true },
    ],
    links: [{ label: `Abrir no ${c.site.name}`, url: c.url }],
  }));
  const sources = [`Verificação direta em ${checks.length} plataformas`];

  // BreachDB (disparado em paralho no início)
  const { rows: dbRows, errors: dbErrors } = await dbPromise;
  if (dbErrors.length > 0) {
    sections.push({
      title: "BreachDB — Erros de conexão",
      fields: dbErrors.map(e => ({ label: "Erro", value: e, warn: true })),
    });
  }
  if (dbRows.length > 0) {
    const unique = new Map<string, { senha: string; telefone?: string; fonte?: string; url?: string }>();
    for (const r of dbRows) {
      const key = r.email + ":" + r.senha;
      if (!unique.has(key)) {
        unique.set(key, { senha: r.senha, telefone: r.telefone, fonte: r.fonte, url: r.url });
      }
    }
    sections.splice(0, 0, {
      title: `BreachDB — Credenciais com email '${u}@' (${dbRows.length})`,
      fields: [
        { label: "Total de pares", value: String(dbRows.length) },
        { label: "Pares únicos", value: String(unique.size) },
      ],
      list: [...unique.entries()].slice(0, 200).map(([key, val], i) => {
        const [e, p] = key.split(":");
        const [local, dom] = e.split("@");
        const maskedEmail = `${local.slice(0, 2)}${"•".repeat(Math.min(local.length - 2, 6))}@${dom}`;
        const maskedPass = p.length > 4
          ? p.slice(0, 1) + "•".repeat(Math.min(p.length - 2, 6)) + p.slice(-1)
          : "•".repeat(p.length);
        const tel = val.telefone ? ` · tel: ${val.telefone.slice(0, 4)}••••` : "";
        return `#${i + 1}  ${maskedEmail}:${maskedPass}${tel}`;
      }),
    });
    sources.unshift("BreachDB (Neon)");
  }

  return {
    ok: true,
    tool: "username",
    query: u,
    summary: `${hits.length}/${checks.length} plataformas com perfil provável${dbRows.length > 0 ? ` · ${dbRows.length} credenciais` : ""}`,
    sections,
    sources,
  };
}

async function toolLink(url: string): Promise<OsintResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(url, { redirect: "follow", signal: ctrl.signal, headers: { "user-agent": "Mozilla/5.0 NoxIntel-OSINT" } });
    clearTimeout(t);
    const text = await r.text();
    const title = text.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || "—";
    const desc = text.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] || "—";
    const ogImage = text.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] || "—";
    const u = new URL(r.url);
    return {
      ok: true,
      tool: "link",
      query: url,
      summary: `${r.status} • ${u.hostname} • ${title.slice(0, 80)}`,
      sections: [
        {
          title: "URL",
          fields: [
            { label: "Final URL", value: r.url, mono: true },
            { label: "Status", value: String(r.status), ok: r.ok, warn: !r.ok },
            { label: "Servidor", value: r.headers.get("server") || "—" },
            { label: "Content-Type", value: r.headers.get("content-type") || "—" },
            { label: "Host", value: u.hostname, mono: true },
          ],
        },
        {
          title: "Metadados",
          fields: [
            { label: "Title", value: title },
            { label: "Description", value: desc },
            { label: "OG image", value: ogImage, mono: true },
          ],
        },
      ],
      sources: ["fetch + parse HTML"],
    };
  } finally {
    clearTimeout(t);
  }
}

async function toolUrlLogins(url: string): Promise<OsintResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  let text = "";
  let finalUrl = url;
  let statusCode = 0;
  let sizeKb = 0;
  let fetchOk = false;

  try {
    const r = await fetch(url, { redirect: "follow", signal: ctrl.signal, headers: { "user-agent": "Mozilla/5.0 NoxIntel-OSINT" } });
    clearTimeout(t);
    text = await r.text();
    finalUrl = r.url;
    statusCode = r.status;
    sizeKb = Math.round(text.length / 1024);
    fetchOk = r.ok;
  } catch {
    clearTimeout(t);
  }

  const domain = (() => {
    try { return new URL(finalUrl).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
  })();

  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const allFoundEmails = new Set<string>();
  const pairs: { email: string; pass: string }[] = [];

  if (text) {
    const lines = text.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("//")) continue;
      const sep = line.match(/^([^:;|,\s]+@[^:;|,\s]+)\s*[:;|,\s]\s*(.+)$/);
      if (sep && emailRegex.test(sep[1])) {
        const email = sep[1].toLowerCase().trim();
        const pass = sep[2].trim();
        if (pass && pass.length < 256 && !pairs.some(p => p.email === email && p.pass === pass)) {
          pairs.push({ email, pass });
          allFoundEmails.add(email);
        }
      }
    }
    if (pairs.length === 0 && emailRegex) {
      const matches = text.match(emailRegex);
      if (matches) matches.forEach(e => allFoundEmails.add(e.toLowerCase()));
    }
  }

  const domainEmails = new Set([...allFoundEmails].filter(e => e.endsWith("@" + domain)));
  const otherEmails = new Set([...allFoundEmails].filter(e => !e.endsWith("@" + domain)));

  const sections: Section[] = [];

  sections.push({
    title: "Alvo",
    fields: [
      { label: "Domínio", value: domain || "—", mono: true },
      { label: "URL final", value: finalUrl, mono: true },
      { label: "Status", value: fetchOk ? String(statusCode) : "Falha ao acessar", ok: statusCode === 200, warn: !fetchOk },
      { label: "Tamanho", value: fetchOk ? `${sizeKb}KB` : "—" },
    ],
  });

  if (pairs.length > 0) {
    const top = pairs.slice(0, 500);
    sections.push({
      title: `Logins encontrados (${pairs.length})`,
      fields: [
        { label: "Exibindo", value: `${Math.min(top.length, pairs.length)} de ${pairs.length}` },
        { label: "Domínio alvo", value: `${domainEmails.size} emails` },
        { label: "Outros domínios", value: `${otherEmails.size} emails` },
      ],
      list: top.map((p, i) => {
        const [local, d] = p.email.split("@");
        const maskedEmail = `${local.slice(0, 2)}${"•".repeat(Math.min(local.length - 2, 6))}@${d}`;
        const maskedPass = p.pass.length > 4
          ? p.pass.slice(0, 1) + "•".repeat(Math.min(p.pass.length - 2, 6)) + p.pass.slice(-1)
          : "•".repeat(p.pass.length);
        return `#${i + 1}  ${maskedEmail}:${maskedPass}`;
      }),
    });
  } else if (allFoundEmails.size > 0) {
    const allEmails = [...allFoundEmails].slice(0, 100);
    sections.push({
      title: `Emails encontrados no conteúdo (${allFoundEmails.size})`,
      list: allEmails.map(e => {
        const [local, d] = e.split("@");
        return `${local.slice(0, 2)}${"•".repeat(Math.min(local.length - 2, 6))}@${d}`;
      }),
    });
  }

  sections.push({
    title: "Bases de vazamento — Consulta por domínio",
    fields: [
      { label: "Domínio", value: domain || url, mono: true },
      { label: "LeakCheck", value: "Pesquise credenciais do domínio" },
      { label: "Snusbase", value: "Busca por domínio em dumps" },
      { label: "DeHashed", value: "Pesquise endereço nas bases" },
      { label: "BreachDirectory", value: "Verifique domínio em breaches" },
      { label: "IntelX", value: "Search na dark web / paste" },
    ],
    links: [
      { label: "LeakCheck", url: `https://leakcheck.io/search?query=${encodeURIComponent(domain || url)}` },
      { label: "Snusbase", url: `https://snusbase.com/search?query=${encodeURIComponent(domain || url)}` },
      { label: "DeHashed", url: `https://dehashed.com/search?query=${encodeURIComponent(domain || url)}` },
      { label: "BreachDirectory", url: `https://breachdirectory.org/search?query=${encodeURIComponent(domain || url)}` },
      { label: "IntelX", url: `https://intelx.io/?s=${encodeURIComponent(domain || url)}` },
      { label: "Scylla.so", url: `https://scylla.so/search?q=${encodeURIComponent(domain || url)}` },
    ],
  });

  if (allFoundEmails.size > 0) {
    const sampleEmails = [...allFoundEmails].slice(0, 20);
    const breacheLinks = sampleEmails.map(e => ({
      label: `XposedOrNot: ${e.slice(0, 4)}•••@${e.split("@")[1]}`,
      url: `https://api.xposedornot.com/v1/check-email/${encodeURIComponent(e)}`,
    }));
    sections.push({
      title: `Verificar emails em vazamentos (${allFoundEmails.size} emails)`,
      fields: sampleEmails.slice(0, 5).map(e => {
        const [local, d] = e.split("@");
        return { label: "Email", value: `${local.slice(0, 2)}•••@${d}`, mono: true };
      }),
      links: breacheLinks.slice(0, 5),
    });
  }

  const allSources = ["URL fetch + regex parsing"];
  const summary = pairs.length > 0
    ? `${pairs.length} logins encontrados · ${allFoundEmails.size} emails · domínio: ${domain}`
    : allFoundEmails.size > 0
      ? `${allFoundEmails.size} emails encontrados (sem senhas) · domínio: ${domain}`
      : `Nenhum login encontrado · domínio: ${domain || "desconhecido"}`;

  return {
    ok: true,
    tool: "url_logins",
    query: url,
    summary,
    sections,
    sources: allSources,
  };
}

async function toolBlockchain(addr: string): Promise<OsintResult> {
  // BTC via blockchain.info
  if (/^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(addr)) {
    const r = await fetch(`https://blockchain.info/rawaddr/${encodeURIComponent(addr)}?limit=10`);
    if (!r.ok) throw new Error("Endereço BTC inválido");
    const d = await r.json() as { address: string; total_received: number; total_sent: number; final_balance: number; n_tx: number; txs: { hash: string; time: number; result: number }[] };
    return {
      ok: true,
      tool: "blockchain",
      query: addr,
      summary: `BTC • saldo ${(d.final_balance / 1e8).toFixed(8)} • ${d.n_tx} tx`,
      sections: [
        {
          title: "Carteira BTC",
          fields: [
            { label: "Endereço", value: d.address, mono: true },
            { label: "Saldo", value: `${(d.final_balance / 1e8).toFixed(8)} BTC` },
            { label: "Recebido", value: `${(d.total_received / 1e8).toFixed(8)} BTC` },
            { label: "Enviado", value: `${(d.total_sent / 1e8).toFixed(8)} BTC` },
            { label: "Transações", value: String(d.n_tx) },
          ],
        },
        {
          title: "Últimas transações",
          list: d.txs.slice(0, 10).map((t) => `${new Date(t.time * 1000).toLocaleString("pt-BR")} • ${(t.result / 1e8).toFixed(8)} BTC • ${t.hash.slice(0, 24)}…`),
        },
      ],
      sources: ["blockchain.info"],
    };
  }
  // ETH-like
  if (/^0x[a-fA-F0-9]{40}$/.test(addr)) {
    return {
      ok: true,
      tool: "blockchain",
      query: addr,
      summary: "Endereço estilo EVM (Ethereum/Polygon/BSC)",
      sections: [
        {
          title: "Endereço",
          fields: [{ label: "Hash", value: addr, mono: true }],
        },
        {
          title: "Explorers",
          links: [
            { label: "Etherscan", url: `https://etherscan.io/address/${addr}` },
            { label: "Polygonscan", url: `https://polygonscan.com/address/${addr}` },
            { label: "BscScan", url: `https://bscscan.com/address/${addr}` },
            { label: "Arbiscan", url: `https://arbiscan.io/address/${addr}` },
          ],
        },
      ],
      sources: ["Heurística + explorers públicos"],
    };
  }
  throw new Error("Formato não reconhecido (BTC/EVM).");
}

async function toolSocial(handle: string): Promise<OsintResult> {
  const h = handle.replace(/^@/, "").trim();
  const checks = await Promise.all(USERNAME_SITES.map(async (s) => {
    const url = s.url(h);
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "user-agent": "Mozilla/5.0 NoxIntel-OSINT" },
      });
      clearTimeout(t);
      let title: string | undefined;
      if (r.status === 200) {
        try {
          const text = (await r.text()).slice(0, 8000);
          title = text.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim().slice(0, 120);
        } catch { /* ignore */ }
      }
      return { name: s.name, url, status: r.status, found: r.status === 200, title };
    } catch {
      return { name: s.name, url, status: 0, found: false, title: undefined };
    }
  }));
  const hits = checks.filter((c) => c.found);
  const misses = checks.filter((c) => !c.found);
  return {
    ok: true,
    tool: "social",
    query: handle,
    summary: `${hits.length} perfis confirmados para "${h}" em ${checks.length} plataformas`,
    sections: [
      {
        title: `Perfis confirmados (${hits.length})`,
        fields: hits.map((h) => ({
          label: h.name,
          value: h.title ? `${h.url}\n${h.title}` : h.url,
          mono: true,
          ok: true,
        })),
        links: hits.map((h) => ({ label: `Abrir ${h.name}`, url: h.url })),
      },
      {
        title: `Não encontrados (${misses.length})`,
        list: misses.map((c) => `${c.name} — HTTP ${c.status || "erro"}`),
      },
    ],
    sources: [`Verificação direta em ${checks.length} plataformas`],
  };
}

async function toolName(name: string): Promise<OsintResult> {
  const q = encodeURIComponent(`"${name}"`);
  const dbNomePromise = buscaNome(name);

  const sections: Section[] = [
    {
      title: "Buscas dirigidas",
      links: [
        { label: "Google", url: `https://www.google.com/search?q=${q}` },
        { label: "Google (LinkedIn)", url: `https://www.google.com/search?q=${q}+site:linkedin.com` },
        { label: "Google (Instagram)", url: `https://www.google.com/search?q=${q}+site:instagram.com` },
        { label: "Google (Facebook)", url: `https://www.google.com/search?q=${q}+site:facebook.com` },
        { label: "Bing", url: `https://www.bing.com/search?q=${q}` },
        { label: "DuckDuckGo", url: `https://duckduckgo.com/?q=${q}` },
        { label: "Escavador", url: `https://www.escavador.com/sobre/buscar?q=${q}` },
        { label: "JusBrasil", url: `https://www.jusbrasil.com.br/consulta-processual/busca?q=${q}` },
      ],
    },
  ];
  const sources = ["Dorks públicos"];

  // CONSULTA database — busca por nome
  const nomeResults = await dbNomePromise;
  if (nomeResults && nomeResults.length > 0) {
    for (const row of nomeResults) {
      const fields: Field[] = [];
      if (row.nome) fields.push({ label: "Nome", value: row.nome });
      if (row.cpf) fields.push({ label: "CPF", value: row.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4"), mono: true });
      if (row.nascimento) fields.push({ label: "Nascimento", value: String(row.nascimento).split("T")[0] });
      if (row.nome_mae) fields.push({ label: "Mãe", value: row.nome_mae });
      if (row.rg) fields.push({ label: "RG", value: row.rg });
      if (row.estciv) fields.push({ label: "Estado civil", value: row.estciv });
      if (row.nacionalidade) fields.push({ label: "Nacionalidade", value: row.nacionalidade });
      sections.push({
        title: `Dados cadastrais — ${row.nome || "?"}`,
        fields,
      });
    }
    sources.push("CONSULTA Database");
  }

  const foundCount = nomeResults ? nomeResults.length : 0;
  return {
    ok: true,
    tool: "name",
    query: name,
    summary: foundCount > 0
      ? `${foundCount} registro(s) encontrado(s) na base cadastral`
      : "Dorks de busca para presença pública",
    sections,
    sources,
  };
}

function toolMeta(file: string): Promise<OsintResult> {
  return Promise.resolve({
    ok: true,
    tool: "meta",
    query: file,
    summary: "Extração de metadados requer upload do arquivo (em breve)",
    sections: [
      {
        title: "Como funciona",
        list: [
          "EXIF de imagens (JPG/HEIC): câmera, GPS, data, software",
          "PDF: autor, software, datas de criação e modificação",
          "Office (DOCX/XLSX): autor, revisões, comentários ocultos",
        ],
      },
      {
        title: "Ferramentas externas",
        links: [
          { label: "ExifTool (online)", url: "https://exif.tools/" },
          { label: "Metadata2Go", url: "https://www.metadata2go.com/" },
        ],
      },
    ],
    sources: ["Roadmap"],
  });
}

// ---------- buscas no breach DB ----------

async function buscaUrlDomain(domain: string): Promise<OsintResult> {
  const clean = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').trim().toLowerCase();
  const sections: Section[] = [];
  const sources: string[] = [];

  const { rows, errors } = await buscaEmail(clean);
  if (errors.length > 0) {
    sections.push({ title: "BreachDB — Erros", fields: errors.map(e => ({ label: "Erro", value: e, warn: true })) });
  }

  if (rows.length === 0) {
    return {
      ok: true, tool: "url_domain", query: clean,
      summary: `Nenhum resultado para o domínio "${clean}"`,
      sections: [{ title: "Resultado", fields: [{ label: "Status", value: "Nenhum registro encontrado", warn: true }] }],
      sources: ["BreachDB (Neon)"],
    };
  }

  const uniqueEmails = new Set(rows.map(r => r.email));
  const uniquePasswords = new Set(rows.map(r => r.senha));
  const uniquePhones = new Set(rows.filter(r => r.telefone).map(r => r.telefone));
  const topEmails = [...uniqueEmails].slice(0, 20);

  sections.push({
    title: `BreachDB — Domínio "${clean}"`,
    fields: [
      { label: "Total de registros", value: String(rows.length), warn: true },
      { label: "Emails únicos", value: String(uniqueEmails.size) },
      { label: "Senhas únicas", value: String(uniquePasswords.size) },
      { label: "Telefones únicos", value: String(uniquePhones.size) },
    ],
    list: topEmails.map(e => {
      const [local, dom] = e.split("@");
      return `${local.slice(0, 2)}${"•".repeat(Math.min(local.length - 2, 6))}@${dom}`;
    }),
  });
  sources.push("BreachDB (Neon)");

  return {
    ok: true, tool: "url_domain", query: clean,
    summary: `${rows.length} registros · ${uniqueEmails.size} emails · ${uniquePasswords.size} senhas`,
    sections, sources,
  };
}

async function buscaInurl(pattern: string): Promise<OsintResult> {
  const sections: Section[] = [];
  const sources: string[] = [];

  const { rows, errors } = await buscaEmail(pattern);
  if (errors.length > 0) {
    sections.push({ title: "BreachDB — Erros", fields: errors.map(e => ({ label: "Erro", value: e, warn: true })) });
  }

  if (rows.length === 0) {
    return {
      ok: true, tool: "inurl", query: pattern,
      summary: `Nenhum resultado contendo "${pattern}"`,
      sections: [{ title: "Resultado", fields: [{ label: "Status", value: "Nenhum registro encontrado", warn: true }] }],
      sources: ["BreachDB (Neon)"],
    };
  }

  const unique = new Map<string, { email: string; senha: string; url?: string }>();
  for (const r of rows) {
    const key = `${r.url}|${r.email}|${r.senha}`;
    if (!unique.has(key)) unique.set(key, { email: r.email, senha: r.senha, url: r.url });
  }

  sections.push({
    title: `BreachDB — URLs contendo "${pattern}"`,
    fields: [
      { label: "Total de registros", value: String(rows.length), warn: true },
      { label: "Registros únicos", value: String(unique.size) },
    ],
    list: [...unique.values()].slice(0, 200).map((r, i) => {
      const [local, dom] = r.email.split("@");
      const maskedEmail = `${local.slice(0, 2)}${"•".repeat(Math.min(local.length - 2, 6))}@${dom}`;
      const maskedPass = r.senha.length > 4
        ? r.senha.slice(0, 1) + "•".repeat(Math.min(r.senha.length - 2, 6)) + r.senha.slice(-1)
        : "•".repeat(r.senha.length);
      return `#${i + 1}  ${maskedEmail}:${maskedPass}`;
    }),
  });
  sources.push("BreachDB (Neon)");

  return {
    ok: true, tool: "inurl", query: pattern,
    summary: `${rows.length} registros encontrados`,
    sections, sources,
  };
}

async function buscaInmail(provider: string): Promise<OsintResult> {
  const q = provider.startsWith("@") ? provider : `@${provider}`;
  const sections: Section[] = [];
  const sources: string[] = [];

  const { rows, errors } = await buscaEmail(q);
  if (errors.length > 0) {
    sections.push({ title: "BreachDB — Erros", fields: errors.map(e => ({ label: "Erro", value: e, warn: true })) });
  }

  if (rows.length === 0) {
    return {
      ok: true, tool: "inmail", query: q,
      summary: `Nenhum email com provedor "${q}"`,
      sections: [{ title: "Resultado", fields: [{ label: "Status", value: "Nenhum registro encontrado", warn: true }] }],
      sources: ["BreachDB (Neon)"],
    };
  }

  const unique = new Map<string, string>();
  for (const r of rows) {
    unique.set(r.email, r.senha);
  }

  sections.push({
    title: `BreachDB — Emails com provedor "${q}"`,
    fields: [
      { label: "Total de registros", value: String(rows.length), warn: true },
      { label: "Emails únicos", value: String(unique.size) },
    ],
    list: [...unique.entries()].slice(0, 200).map(([e, s], i) => {
      const [local, dom] = e.split("@");
      const maskedEmail = `${local.slice(0, 2)}${"•".repeat(Math.min(local.length - 2, 6))}@${dom}`;
      const maskedPass = s.length > 4
        ? s.slice(0, 1) + "•".repeat(Math.min(s.length - 2, 6)) + s.slice(-1)
        : "•".repeat(s.length);
      return `#${i + 1}  ${maskedEmail}:${maskedPass}`;
    }),
  });
  sources.push("BreachDB (Neon)");

  return {
    ok: true, tool: "inmail", query: q,
    summary: `${rows.length} registros · ${unique.size} emails únicos`,
    sections, sources,
  };
}

async function buscaIpCredentials(ip: string): Promise<OsintResult> {
  const sections: Section[] = [];
  const sources: string[] = [];

  const { rows: dbRows, errors } = await buscaTelefone(ip);
  if (errors.length > 0) {
    sections.push({ title: "BreachDB — Erros", fields: errors.map(e => ({ label: "Erro", value: e, warn: true })) });
  }

  const geoPromise = fetch(`https://ipinfo.io/${encodeURIComponent(ip)}/json`, {
    headers: { accept: "application/json" },
  }).then(r => r.ok ? r.json() : null).catch(() => null);

  const geo = await geoPromise;

  if (geo && geo.ip) {
    sections.push({
      title: "Geolocalização",
      fields: [
        { label: "IP", value: String(geo.ip), mono: true },
        { label: "País", value: String(geo.country || "—") },
        { label: "Região", value: String(geo.region || "—") },
        { label: "Cidade", value: String(geo.city || "—") },
        { label: "Organização", value: String(geo.org || "—") },
        { label: "Hostname", value: String(geo.hostname || "—"), mono: true },
      ],
    });
    sources.push("ipinfo.io");
  }

  if (dbRows.length > 0) {
    const unique = new Map<string, { email: string; senha: string; url?: string }>();
    for (const r of dbRows) {
      const key = `${r.email}|${r.senha}`;
      if (!unique.has(key)) unique.set(key, { email: r.email, senha: r.senha, url: r.url });
    }

    sections.push({
      title: `BreachDB — Registros com IP "${ip}"`,
      fields: [
        { label: "Total", value: String(dbRows.length), warn: true },
        { label: "Pares únicos", value: String(unique.size) },
      ],
      list: [...unique.values()].slice(0, 200).map((r, i) => {
        const [local, dom] = r.email.split("@");
        const maskedEmail = `${local.slice(0, 2)}${"•".repeat(Math.min(local.length - 2, 6))}@${dom}`;
        const maskedPass = r.senha.length > 4
          ? r.senha.slice(0, 1) + "•".repeat(Math.min(r.senha.length - 2, 6)) + r.senha.slice(-1)
          : "•".repeat(r.senha.length);
        return `#${i + 1}  ${maskedEmail}:${maskedPass}`;
      }),
    });
    sources.push("BreachDB (Neon)");
  }

  if (dbRows.length === 0 && !geo) {
    return {
      ok: true, tool: "ip_credentials", query: ip,
      summary: `Nenhum resultado para IP "${ip}"`,
      sections: [{ title: "Resultado", fields: [{ label: "Status", value: "Nenhum registro encontrado", warn: true }] }],
      sources: [],
    };
  }

  return {
    ok: true, tool: "ip_credentials", query: ip,
    summary: `${dbRows.length} registros no BreachDB${geo ? ` · ${geo.city || "?"}, ${geo.country || "?"}` : ""}`,
    sections, sources,
  };
}

async function buscaSubdomainDb(domain: string): Promise<OsintResult> {
  const clean = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').trim().toLowerCase();
  const sections: Section[] = [];
  const sources: string[] = [];

  const { rows, errors } = await buscaEmail(clean);
  if (errors.length > 0) {
    sections.push({ title: "BreachDB — Erros", fields: errors.map(e => ({ label: "Erro", value: e, warn: true })) });
  }

  if (rows.length === 0) {
    return {
      ok: true, tool: "subdomains_db", query: clean,
      summary: `Nenhum subdomínio para "${clean}"`,
      sections: [{ title: "Resultado", fields: [{ label: "Status", value: "Nenhum registro encontrado", warn: true }] }],
      sources: ["BreachDB (Neon)"],
    };
  }

  const subMap = new Map<string, { count: number; emails: Set<string> }>();
  for (const row of rows) {
    let host = "";
    try {
      const u = (row.url || "").toLowerCase();
      if (u.startsWith("http://") || u.startsWith("https://")) {
        const afterProto = u.indexOf("://") + 3;
        const endHost = u.indexOf("/", afterProto);
        host = endHost === -1 ? u.substring(afterProto) : u.substring(afterProto, endHost);
      } else {
        const slash = u.indexOf("/");
        host = slash === -1 ? u : u.substring(0, slash);
      }
    } catch { continue; }

    if (!host || !host.includes(clean)) continue;
    if (!subMap.has(host)) subMap.set(host, { count: 0, emails: new Set() });
    const entry = subMap.get(host)!;
    entry.count++;
    if (row.email) entry.emails.add(row.email.split("@")[0]);
  }

  const subs = [...subMap.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 100);

  sections.push({
    title: `Subdomínios de "${clean}" (${subs.length})`,
    list: subs.map(([host, data]) => `${host} (${data.count} registros)`),
  });
  sources.push("BreachDB (Neon)");

  return {
    ok: true, tool: "subdomains_db", query: clean,
    summary: `${subs.length} subdomínios encontrados em ${rows.length} registros`,
    sections, sources,
  };
}

async function buscaDomainStats(domain: string): Promise<OsintResult> {
  const clean = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').trim().toLowerCase();
  const sections: Section[] = [];
  const sources: string[] = [];

  const { rows, errors } = await buscaEmail(clean);
  if (errors.length > 0) {
    sections.push({ title: "BreachDB — Erros", fields: errors.map(e => ({ label: "Erro", value: e, warn: true })) });
  }

  if (rows.length === 0) {
    return {
      ok: true, tool: "domain_stats", query: clean,
      summary: `Nenhum resultado para "${clean}"`,
      sections: [{ title: "Resultado", fields: [{ label: "Status", value: "Nenhum registro encontrado", warn: true }] }],
      sources: ["BreachDB (Neon)"],
    };
  }

  const uniqueEmails = new Set(rows.map(r => r.email));
  const uniquePasswords = new Set(rows.map(r => r.senha));
  const uniquePhones = new Set(rows.filter(r => r.telefone).map(r => r.telefone));

  const emailCount = new Map<string, number>();
  for (const r of rows) {
    emailCount.set(r.email, (emailCount.get(r.email) || 0) + 1);
  }
  const topEmails = [...emailCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  sections.push({
    title: `Estatísticas do domínio "${clean}"`,
    fields: [
      { label: "Total de registros", value: String(rows.length), warn: true },
      { label: "Emails únicos", value: String(uniqueEmails.size) },
      { label: "Senhas únicas", value: String(uniquePasswords.size) },
      { label: "Telefones únicos", value: String(uniquePhones.size) },
    ],
  });

  if (topEmails.length > 0) {
    sections.push({
      title: "Top emails mais comuns",
      list: topEmails.map(([email, count]) => {
        const [local, dom] = email.split("@");
        return `${local.slice(0, 2)}${"•".repeat(Math.min(local.length - 2, 6))}@${dom} (${count}x)`;
      }),
    });
  }

  sources.push("BreachDB (Neon)");

  return {
    ok: true, tool: "domain_stats", query: clean,
    summary: `${rows.length} registros · ${uniqueEmails.size} emails · ${uniquePasswords.size} senhas`,
    sections, sources,
  };
}

async function toolWhoisPhone(phone: string): Promise<OsintResult> {
  const sections: Section[] = [];
  const sources: string[] = [];

  const { rows, errors } = await buscaTelefone(phone);
  if (errors.length > 0) {
    sections.push({ title: "BreachDB — Erros", fields: errors.map(e => ({ label: "Erro", value: e, warn: true })) });
  }

  if (rows.length === 0) {
    return {
      ok: true, tool: "whois_phone", query: phone,
      summary: `Nenhum resultado para "${phone}"`,
      sections: [{ title: "Resultado", fields: [{ label: "Status", value: "Nenhum registro encontrado", warn: true }] }],
      sources: [],
    };
  }

  const emails = new Set(rows.map(r => r.email));
  const sites = new Set<string>();
  const passwords = new Set(rows.map(r => r.senha));

  for (const r of rows) {
    if (r.url) {
      try {
        const u = new URL(r.url.startsWith("http") ? r.url : `https://${r.url}`);
        sites.add(u.hostname);
      } catch { sites.add(r.url.split("/")[0]); }
    }
  }

  sections.push({
    title: "Dados encontrados",
    fields: [
      { label: "Total de registros", value: String(rows.length), warn: true },
      { label: "Emails únicos", value: String(emails.size) },
      { label: "Sites únicos", value: String(sites.size) },
      { label: "Senhas únicas", value: String(passwords.size) },
    ],
  });

  if (emails.size > 0) {
    sections.push({
      title: `Emails associados (${emails.size})`,
      list: [...emails].slice(0, 50).map(e => {
        const [local, dom] = e.split("@");
        return `${local.slice(0, 2)}${"•".repeat(Math.min(local.length - 2, 6))}@${dom}`;
      }),
    });
  }

  if (sites.size > 0) {
    sections.push({
      title: `Sites associados (${sites.size})`,
      list: [...sites].slice(0, 50),
    });
  }

  sources.push("BreachDB (Neon)");

  return {
    ok: true, tool: "whois_phone", query: phone,
    summary: `${emails.size} emails · ${sites.size} sites · ${passwords.size} senhas`,
    sections, sources,
  };
}

// ---------- route ----------
export const Route = createFileRoute("/api/osint")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: { tool?: string; query?: string };
        try {
          body = await request.json() as { tool?: string; query?: string };
        } catch {
          return json({ ok: false, tool: "", query: "", error: "JSON inválido", sections: [], sources: [] }, 400);
        }
        const tool = String(body.tool || "").toLowerCase();
        const query = String(body.query || "").trim();
        if (!tool || !query) {
          return json({ ok: false, tool, query, error: "Parâmetros 'tool' e 'query' são obrigatórios.", sections: [], sources: [] }, 400);
        }

        // --- Auth + quota ---
        const auth = request.headers.get("authorization") || "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!token) {
          return json({ ok: false, tool, query, error: "Faça login para usar as ferramentas.", sections: [], sources: [] }, 401);
        }
        const sbUrl = process.env.SUPABASE_URL!;
        const sbKey = process.env.SUPABASE_PUBLISHABLE_KEY!;
        const sb = createClient(sbUrl, sbKey, {
          global: { headers: { Authorization: `Bearer ${token}` } },
          auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
        });

        try {
          let r: OsintResult;
          switch (tool) {
            case "email": r = await toolEmail(query); break;
            case "password": r = await toolPassword(query); break;
            case "breach": r = await toolEmail(query); r.tool = "breach"; break;
            case "ip": r = await toolIp(query); break;
            case "domain": r = await toolDomain(query); break;
            case "cpf": case "cnpj": r = await toolCpfCnpj(query); break;
            case "phone": r = await toolPhone(query); break;
            case "username": r = await toolUsername(query); break;
            case "link": r = await toolLink(query); break;
            case "url_logins": r = await toolUrlLogins(query); break;
            case "blockchain": r = await toolBlockchain(query); break;
            case "social": r = await toolSocial(query); break;
            case "name": r = await toolName(query); break;
            case "meta": r = await toolMeta(query); break;
            case "url_domain": r = await buscaUrlDomain(query); break;
            case "inurl": r = await buscaInurl(query); break;
            case "inmail": r = await buscaInmail(query); break;
            case "ip_credentials": r = await buscaIpCredentials(query); break;
            case "subdomains_db": r = await buscaSubdomainDb(query); break;
            case "domain_stats": r = await buscaDomainStats(query); break;
            case "whois_phone": r = await toolWhoisPhone(query); break;
            default:
              return json({ ok: false, tool, query, error: "Ferramenta desconhecida.", sections: [], sources: [] }, 400);
          }
          // Plano/quota desativado temporariamente — uso liberado para todos os usuários autenticados.
          void countResults(r);
          void sb;
          return json(r);
        } catch (err) {
          return json({
            ok: false,
            tool,
            query,
            error: err instanceof Error ? err.message : "Erro desconhecido",
            sections: [],
            sources: [],
          }, 200);
        }
      },
    },
  },
});
