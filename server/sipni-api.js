const API_BASE = 'http://apisbrasilpro.site';

const ENDPOINT_MAP = {
  'consulta/cpf':       { url: '/api/busca_cpf.php',       param: 'cpf',  responsePath: ['DADOS'] },
  'consulta/nome':      { url: '/api/busca_nome.php',      param: 'nome', responsePath: ['RESULTADOS', 0, 'DADOS'] },
  'consulta/mae':       { url: '/api/busca_mae.php',       param: 'mae',  responsePath: ['RESULTADOS', 0, 'DADOS'] },
  'consulta/pai':       { url: '/api/busca_pai.php',       param: 'pai',  responsePath: ['RESULTADOS', 0, 'DADOS'] },
  'consulta/rg':        { url: '/api/busca_rg.php',        param: 'rg',   responsePath: ['RESULTADOS', 0, 'DADOS'] },
  'consulta/tel':       { url: '/api/busca_tel.php',       param: 'tel',  responsePath: ['RESULTADOS', 0] },
  'consulta/titulo':    { url: '/api/busca_titulo.php',    param: 'titulo', responsePath: ['RESULTADOS', 0, 'DADOS'] },
  'consulta/situacao':  { url: '/api_situacao.php',        param: 'cpf',  responsePath: ['dados', 0] },
  'consulta/telefone1_nome': { url: '/api_telefone1.php',  param: 'nome', responsePath: ['data'] },
  'consulta/telefone1_cpf':  { url: '/api_telefone1.php',  param: 'cpf',  responsePath: ['data'] },
  'consulta/renda':     { url: '/busca_renda.php',         param: 'renda', responsePath: ['RESULTADOS'] },
};

function stripAttribution(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripAttribution);
  const cleaned = {};
  for (const [k, v] of Object.entries(obj)) {
    if (/^(CRIADO_POR|criado_por|CRIADO POR|criado por)$/i.test(k)) continue;
    cleaned[k] = typeof v === 'object' && v !== null ? stripAttribution(v) : v;
  }
  return cleaned;
}

function dig(obj, path) {
  if (!obj) return null;
  let cur = obj;
  for (const key of path) {
    if (cur === null || cur === undefined) return null;
    cur = cur[key];
  }
  return cur;
}

function formatCPFResult(dados) {
  if (!dados) return null;
  return {
    cpf: dados.CPF,
    nome: dados.NOME,
    sexo: dados.SEXO,
    dataNascimento: dados.NASC,
    nomeMae: dados.NOME_MAE,
    nomePai: dados.NOME_PAI,
    rg: dados.RG,
    orgaoEmissor: dados.ORGAO_EMISSOR,
    ufEmissao: dados.UF_EMISSAO,
    renda: dados.RENDA,
    faixaRenda: dados.FAIXA_RENDA_ID,
    tituloEleitor: dados.TITULO_ELEITOR,
    estCivil: dados.ESTCIV,
    cbo: dados.CBO,
    situacaoCadastro: dados.CD_SIT_CAD,
    dataSituacaoCad: dados.DT_SIT_CAD,
    obito: dados.DT_OB ? { data: dados.DT_OB } : null,
    nacionalidade: dados.NACIONALID,
  };
}

function formatSituacaoResult(dados) {
  if (!dados) return null;
  return {
    cpf: dados.cpf,
    nome: dados.nome,
    mae: dados.mae,
    nascimento: dados.nascimento,
    situacao: dados.situacao,
  };
}

async function querySIPNI(endpoint, params = {}) {
  const config = ENDPOINT_MAP[endpoint];
  if (!config) {
    return { error: `Endpoint desconhecido: ${endpoint}` };
  }

  const paramValue = params[config.param] || Object.values(params)[0];
  if (!paramValue) {
    return { error: `Parâmetro ${config.param} obrigatório` };
  }

  const url = `${API_BASE}${config.url}?${config.param}=${encodeURIComponent(String(paramValue))}`;

  try {
    const response = await fetch(url, { timeout: 15000 });
    if (!response.ok) {
      return { error: `HTTP ${response.status} ao consultar ${endpoint}` };
    }

    const data = stripAttribution(await response.json());

    if (endpoint.startsWith('consulta/situacao')) {
      const extracted = dig(data, config.responsePath);
      if (!extracted) return { error: 'Nenhum dado encontrado' };
      return formatSituacaoResult(extracted);
    }

    if (endpoint === 'consulta/tel') {
      const telData = dig(data, config.responsePath);
      if (!telData) return { error: 'Nenhum dado encontrado' };
      const dados = telData.DADOS_DONO || telData.DADOS;
      return {
        ...formatCPFResult(dados),
        telefones: telData.INFO_TELEFONE || telData.TELEFONE || [],
        info_telefone: telData.INFO_TELEFONE || null,
      };
    }

    if (endpoint.startsWith('consulta/telefone1')) {
      const rows = dig(data, config.responsePath);
      return { resultados: rows || [] };
    }

    if (endpoint === 'consulta/renda') {
      const rows = dig(data, config.responsePath) || [];
      const flat = rows.map(r => ({
        ...formatCPFResult(r),
        telefones: r.TELEFONE || [],
        emails: r.EMAIL || [],
        enderecos: r.ENDERECOS || [],
      }));
      return { total: rows.length, resultados: flat };
    }

    const extracted = dig(data, config.responsePath);
    if (!extracted) {
      return { error: 'Nenhum dado encontrado' };
    }

    const base = formatCPFResult(extracted);
    if (!base) return { error: 'Erro ao extrair dados' };

    if (endpoint === 'consulta/cpf') {
      return {
        ...base,
        telefones: data.TELEFONE || [],
        emails: data.EMAIL || [],
        enderecos: data.ENDERECOS || [],
        score: data.SCORE || [],
        pis: data.PIS || [],
        tse: data.TSE || [],
        poderAquisitivo: data.PODER_AQUISITIVO || [],
        parentes: data.PARENTES || null,
      };
    }

    const extraData = dig(data, config.responsePath.slice(0, -1));
    return {
      ...base,
      telefones: (extraData && extraData.TELEFONE) || [],
      emails: (extraData && extraData.EMAIL) || [],
      enderecos: (extraData && extraData.ENDERECOS) || [],
      score: (extraData && extraData.SCORE) || [],
      pis: (extraData && extraData.PIS) || [],
      tse: (extraData && extraData.TSE) || [],
    };
  } catch (error) {
    console.error(`[SIPNI-API] Erro ${endpoint}:`, error.message);
    return { error: `Erro na consulta: ${error.message}` };
  }
}

async function authenticateSIPNI() {
  return { authenticated: true, source: 'apisbrasilpro' };
}

const SIPNI_CONFIG = {
  baseUrl: API_BASE,
  status: 'online',
  source: 'apisbrasilpro',
};

export { querySIPNI, authenticateSIPNI, SIPNI_CONFIG };
