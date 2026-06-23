import pg from "pg";

const { Pool } = pg;

type Row = { email: string; senha: string; telefone?: string; fonte?: string; url?: string; db: string };

const pools = new Map<string, pg.Pool>();

function getPool(url: string, name: string): pg.Pool {
  let p = pools.get(name);
  if (!p) {
    p = new Pool({ connectionString: url, max: 2, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 });
    pools.set(name, p);
  }
  return p;
}

function getUrls(): string[] {
  return [process.env.BREACH_DB1, process.env.BREACH_DB2, process.env.BREACH_DB3, process.env.BREACH_DB4].filter(Boolean) as string[];
}

function getConsultaUrl(): string | undefined {
  return process.env.CONSULTA_DATABASE_URL;
}

async function queryAll(sql: string, params: any[]): Promise<{ rows: Row[]; errors: string[] }> {
  const urls = getUrls();
  if (urls.length === 0) {
    const status = ["BREACH_DB1","BREACH_DB2","BREACH_DB3","BREACH_DB4"]
      .map(k => `${k}=${process.env[k as keyof typeof process.env] ? 'definida' : 'undefined'}`).join(', ');
    return { rows: [], errors: [`Nenhuma conexão — ${status}`] };
  }
  const errors: string[] = [];
  const results = await Promise.all(urls.map(async (url, i) => {
    const name = `DB${i + 1}`;
    const pool = getPool(url, name);
    try {
      const client = await pool.connect();
      try {
        const res = await client.query(sql, params);
        return (res.rows || []).map((r: any) => ({ ...r, db: name }));
      } finally { client.release(); }
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      return [] as Row[];
    }
  }));
  const rows: Row[] = [];
  for (const r of results) rows.push(...r);
  return { rows, errors };
}

// Busca exata primeiro; se 0 resultados, tenta ILIKE parcial (igual ao bot)
async function exactThenPartial(
  exactSql: string,
  exactParams: any[],
  partialSql: string,
  partialParams: any[],
): Promise<{ rows: Row[]; errors: string[] }> {
  const { rows, errors } = await queryAll(exactSql, exactParams);
  if (rows.length > 0) return { rows, errors };
  const fallback = await queryAll(partialSql, partialParams);
  return { rows: fallback.rows, errors: [...errors, ...fallback.errors] };
}

export async function buscaEmail(email: string) {
  return exactThenPartial(
    "SELECT email, senha, telefone, fonte, url FROM credentials WHERE LOWER(email) = LOWER($1) LIMIT 200",
    [email],
    "SELECT email, senha, telefone, fonte, url FROM credentials WHERE email ILIKE '%' || $1 || '%' LIMIT 200",
    [email],
  );
}

export async function buscaTelefone(telefone: string) {
  const num = telefone.replace(/\D/g, "");
  // Igual ao bot: busca em telefone, url, email
  const exactSql = `SELECT email, senha, telefone, fonte, url FROM credentials WHERE telefone = $1 OR url = $1 OR email = $1 LIMIT 200`;
  const partialSql = `SELECT email, senha, telefone, fonte, url FROM credentials WHERE telefone ILIKE '%' || $1 || '%' OR url ILIKE '%' || $1 || '%' OR email ILIKE '%' || $1 || '%' LIMIT 200`;
  return exactThenPartial(exactSql, [num], partialSql, [num]);
}

export async function buscaSenha(senha: string) {
  return exactThenPartial(
    "SELECT email, senha, telefone, fonte, url FROM credentials WHERE senha = $1 LIMIT 200",
    [senha],
    "SELECT email, senha, telefone, fonte, url FROM credentials WHERE senha ILIKE '%' || $1 || '%' LIMIT 200",
    [senha],
  );
}

export async function buscaEmailSenha(email: string, senha: string) {
  return exactThenPartial(
    "SELECT email, senha, telefone, fonte, url FROM credentials WHERE LOWER(email) = LOWER($1) AND senha = $2 LIMIT 100",
    [email, senha],
    "SELECT email, senha, telefone, fonte, url FROM credentials WHERE email ILIKE '%' || $1 || '%' AND senha ILIKE '%' || $2 || '%' LIMIT 100",
    [email, senha],
  );
}

export async function buscaUsername(username: string) {
  const u = username.replace(/^@/, "").toLowerCase().trim();
  if (!u) return { rows: [], errors: [] };
  return exactThenPartial(
    "SELECT email, senha, telefone, fonte, url FROM credentials WHERE LOWER(email) = LOWER($1) LIMIT 200",
    [u],
    "SELECT email, senha, telefone, fonte, url FROM credentials WHERE email ILIKE '%' || $1 || '%' OR url ILIKE '%' || $1 || '%' LIMIT 200",
    [u],
  );
}

export async function buscaNome(nome: string) {
  const url = getConsultaUrl();
  if (!url) return null;
  const pool = getPool(url, "CONSULTA");
  try {
    const client = await pool.connect();
    try {
      const res = await client.query("SELECT cpf, nome, nascimento, nome_mae, rg, estciv, nacionalidade FROM cpf_cache WHERE LOWER(nome) LIKE '%' || $1 || '%' LIMIT 20", [nome.toLowerCase().trim()]);
      return res.rows.length > 0 ? res.rows : null;
    } finally { client.release(); }
  } catch { return null; }
}

export async function buscaCPF(cpf: string) {
  const url = getConsultaUrl();
  if (!url) return null;
  const pool = getPool(url, "CONSULTA");
  const digits = cpf.replace(/\D/g, "");
  try {
    const client = await pool.connect();
    try {
      const res = await client.query("SELECT * FROM cpf_cache WHERE cpf = $1 LIMIT 1", [digits]);
      return res.rows.length > 0 ? res.rows[0] : null;
    } finally { client.release(); }
  } catch { return null; }
}

function maskLocal(local: string): string {
  return local.length <= 2 ? local + "•".repeat(3) : local.slice(0, 2) + "•".repeat(Math.min(local.length - 2, 6));
}

function maskPass(pass: string): string {
  return pass.length > 4
    ? pass.slice(0, 1) + "•".repeat(Math.min(pass.length - 2, 6)) + pass.slice(-1)
    : "•".repeat(pass.length);
}

export function formatPairs(pairs: { email: string; senha: string }[]): string[] {
  return pairs.map((p, i) => {
    const [local, domain] = p.email.split("@");
    return `#${i + 1}  ${maskLocal(local)}@${domain}:${maskPass(p.senha)}`;
  });
}
