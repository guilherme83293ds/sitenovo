// ══════════════════════════════════════════════════════
// SIPNI API LOCAL - Cache + Pesquisa Rápida
// ══════════════════════════════════════════════════════

const SIPNI_CONFIG = {
  baseUrl: 'https://sipni.datasus.gov.br/si-pni-web/rest',
  user: process.env.SIPNI_USER || 'luzsantos',
  pass: process.env.SIPNI_PASS || 'LOGINDATASUS',
  timeout: 30000
};

// Cache em memória com TTL (30 minutos)
const cache = new Map();
let sipniSession = null;
let sipniSessionExpiry = 0;

// Função para fazer requisições HTTP
async function sipniRequest(method, endpoint, data = null) {
  try {
    const url = `${SIPNI_CONFIG.baseUrl}${endpoint}`;
    
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sipniSession}`,
        'User-Agent': 'Sitenovo-Bot/1.0'
      },
      timeout: SIPNI_CONFIG.timeout
    };

    let body = null;
    if (data) {
      body = JSON.stringify(data);
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const response = await fetch(url, { ...options, body });
    
    if (!response.ok) {
      throw new Error(`SIPNI API Error: ${response.status} ${response.statusText}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`❌ [SIPNI] Erro em ${endpoint}:`, error.message);
    throw error;
  }
}

// Autenticação SIPNI com cache de sessão
async function authenticateSIPNI() {
  // Se tem sessão válida, retorna
  if (sipniSession && Date.now() < sipniSessionExpiry) {
    return sipniSession;
  }

  try {
    console.log('🔐 [SIPNI] Autenticando...');
    const url = `${SIPNI_CONFIG.baseUrl}/autenticacao/autenticar`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Sitenovo-Bot/1.0'
      },
      body: JSON.stringify({
        usuario: SIPNI_CONFIG.user,
        senha: SIPNI_CONFIG.pass
      }),
      timeout: SIPNI_CONFIG.timeout
    });

    if (!response.ok) {
      throw new Error(`Autenticação falhou: ${response.status}`);
    }

    const result = await response.json();
    
    if (result.token) {
      sipniSession = result.token;
      // TTL de 29 minutos (SIPNI geralmente expira em 30)
      sipniSessionExpiry = Date.now() + (29 * 60 * 1000);
      console.log('✅ [SIPNI] Autenticado com sucesso');
      return sipniSession;
    } else {
      throw new Error('Nenhum token retornado');
    }
  } catch (error) {
    console.error('❌ [SIPNI] Falha na autenticação:', error.message);
    sipniSession = null;
    throw error;
  }
}

// Pesquisa com cache
async function querySIPNI(endpoint, params = {}) {
  // Gera chave de cache
  const cacheKey = `${endpoint}:${JSON.stringify(params)}`;
  
  // Verifica cache
  const cached = cache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) {
    console.log(`✅ [SIPNI] Cache hit para ${endpoint}`);
    return cached.data;
  }

  try {
    // Autentica se necessário
    if (!sipniSession) {
      await authenticateSIPNI();
    }

    // Faz a requisição
    const result = await sipniRequest('POST', endpoint, params);
    
    // Armazena no cache (15 minutos)
    cache.set(cacheKey, {
      data: result,
      expiry: Date.now() + (15 * 60 * 1000)
    });

    // Limpa cache antigo
    for (const [key, value] of cache.entries()) {
      if (Date.now() > value.expiry) {
        cache.delete(key);
      }
    }

    return result;
  } catch (error) {
    // Em caso de erro de autenticação, tenta renovar
    if (error.message.includes('401') || error.message.includes('Autenticação')) {
      sipniSession = null;
      await authenticateSIPNI();
      return await sipniRequest('POST', endpoint, params);
    }
    throw error;
  }
}

// Exporta funções
export { authenticateSIPNI, querySIPNI, SIPNI_CONFIG };
