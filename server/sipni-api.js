// ══════════════════════════════════════════════════════
// SIPNI API LOCAL - Cache + Pesquisa Rápida + Fallback
// ══════════════════════════════════════════════════════

const SIPNI_CONFIG = {
  // Tenta múltiplos endpoints em paralelo
  endpoints: [
    'https://sipni.datasus.gov.br/si-pni-web/rest',
    'https://sipni.datasus.gov.br/api',
    'https://sipni.datasus.gov.br'
  ],
  user: process.env.SIPNI_USER || 'luzsantos',
  pass: process.env.SIPNI_PASS || 'LOGINDATASUS',
  timeout: 15000
};

// Cache em memória com TTL (30 minutos)
const cache = new Map();
let sipniSession = null;
let sipniSessionExpiry = 0;
let sipniCookies = ''; // Armazena cookies da sessão
let sipniAvailable = false;
let lastSIPNICheck = 0;

// Função para testar se SIPNI está disponível
async function testSIPNIAvailability() {
  // Testa apenas a cada 5 minutos
  if (Date.now() - lastSIPNICheck < 5 * 60 * 1000 && sipniAvailable !== undefined) {
    return sipniAvailable;
  }

  lastSIPNICheck = Date.now();

  for (const baseUrl of SIPNI_CONFIG.endpoints) {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        method: 'GET',
        timeout: 5000
      }).catch(() => ({ ok: false }));

      if (response.ok) {
        console.log(`✅ [SIPNI] API disponível em ${baseUrl}`);
        sipniAvailable = true;
        SIPNI_CONFIG.baseUrl = baseUrl;
        return true;
      }
    } catch (e) {
      // Continua para próximo endpoint
    }
  }

  console.warn('⚠️ [SIPNI] Nenhum endpoint disponível');
  sipniAvailable = false;
  return false;
}

// Autenticação SIPNI com fallback (Token + Cookies)
async function authenticateSIPNI() {
  // Se tem sessão válida, retorna
  if ((sipniSession || sipniCookies) && Date.now() < sipniSessionExpiry) {
    return sipniSession || 'cookies';
  }

  try {
    console.log('🔐 [SIPNI] Autenticando (Token + Cookies)...');

    const credentials = Buffer.from(`${SIPNI_CONFIG.user}:${SIPNI_CONFIG.pass}`).toString('base64');
    const baseUrl = SIPNI_CONFIG.baseUrl || SIPNI_CONFIG.endpoints[0];

    // Tenta diferentes endpoints de autenticação
    const authEndpoints = [
      { url: `${baseUrl}/autenticacao/autenticar`, method: 'POST', needsBasic: false },
      { url: `${baseUrl}/auth/login`, method: 'POST', needsBasic: false },
      { url: `${baseUrl}/login`, method: 'POST', needsBasic: false },
      { url: `${baseUrl}/autenticacao`, method: 'POST', needsBasic: false },
      { url: `${baseUrl}/si-pni-web/faces/inicio.jsf`, method: 'POST', needsBasic: true }, // Tentativa com básico
    ];

    let lastError = null;

    for (const authConfig of authEndpoints) {
      try {
        const headers = {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Sitenovo-Bot/1.0',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9',
        };

        if (authConfig.needsBasic) {
          headers['Authorization'] = `Basic ${credentials}`;
        }

        // Prepara o body - tenta diferentes formatos
        let body;
        if (authConfig.url.includes('login') && !authConfig.needsBasic) {
          // Formato JSON
          body = JSON.stringify({
            usuario: SIPNI_CONFIG.user,
            senha: SIPNI_CONFIG.pass,
            username: SIPNI_CONFIG.user,
            password: SIPNI_CONFIG.pass
          });
          headers['Content-Type'] = 'application/json';
        } else {
          // Formato URL-encoded (para login com cookies)
          body = `usuario=${encodeURIComponent(SIPNI_CONFIG.user)}&senha=${encodeURIComponent(SIPNI_CONFIG.pass)}`;
        }

        const response = await fetch(authConfig.url, {
          method: authConfig.method,
          headers,
          body,
          timeout: SIPNI_CONFIG.timeout,
          redirect: 'follow' // Segue redirecionamentos
        });

        // Extrai cookies da resposta
        const setCookieHeaders = response.headers.get('set-cookie');
        if (setCookieHeaders) {
          sipniCookies = setCookieHeaders;
          console.log('✅ [SIPNI] Cookies obtidos');
        }

        if (response.ok) {
          const result = await response.json().catch(() => ({}));

          if (result.token || result.sessionId || result.access_token) {
            sipniSession = result.token || result.sessionId || result.access_token;
            sipniSessionExpiry = Date.now() + (29 * 60 * 1000);
            console.log('✅ [SIPNI] Autenticado com token');
            return sipniSession;
          } else if (sipniCookies) {
            sipniSessionExpiry = Date.now() + (29 * 60 * 1000);
            console.log('✅ [SIPNI] Autenticado com cookies');
            return 'cookies';
          }
        }

        lastError = `Status ${response.status}`;
      } catch (e) {
        lastError = e.message;
      }
    }

    throw new Error(`Nenhum endpoint de autenticação funcionou: ${lastError}`);
  } catch (error) {
    console.error('❌ [SIPNI] Falha na autenticação:', error.message);
    sipniSession = null;
    sipniCookies = '';
    sipniAvailable = false;
    return null;
  }
}

// Pesquisa com cache e fallback (Token + Cookies)
async function querySIPNI(endpoint, params = {}) {
  // Gera chave de cache
  const cacheKey = `${endpoint}:${JSON.stringify(params)}`;

  // Verifica cache primeiro (mesmo sem conexão)
  const cached = cache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) {
    console.log(`✅ [SIPNI] Cache hit para ${endpoint}`);
    return cached.data;
  }

  // Se SIPNI não está disponível, retorna dados simulados
  if (!sipniAvailable) {
    const available = await testSIPNIAvailability();
    if (!available) {
      console.log(`⚠️ [SIPNI] Retornando dados simulados (SIPNI indisponível)`);
      return generateMockSIPNIResponse(endpoint, params);
    }
  }

  try {
    // Autentica se necessário (Token ou Cookies)
    if (!sipniSession && !sipniCookies) {
      await authenticateSIPNI();
    }

    if (!sipniSession && !sipniCookies) {
      // Se falhar autenticação, retorna mock
      return generateMockSIPNIResponse(endpoint, params);
    }

    // Faz a requisição
    const baseUrl = SIPNI_CONFIG.baseUrl || SIPNI_CONFIG.endpoints[0];
    const url = `${baseUrl}${endpoint}`;

    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Sitenovo-Bot/1.0',
      'Accept': 'application/json'
    };

    // Usa token ou cookies
    if (sipniSession) {
      headers['Authorization'] = `Bearer ${sipniSession}`;
    }
    if (sipniCookies) {
      headers['Cookie'] = sipniCookies;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
      timeout: SIPNI_CONFIG.timeout
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        // Invalida ambas as autenticações
        sipniSession = null;
        sipniCookies = '';
      }
      throw new Error(`SIPNI API Error: ${response.status}`);
    }

    const result = await response.json();

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
    console.error(`❌ [SIPNI] Erro em ${endpoint}:`, error.message);
    // Retorna mock para manter sistema funcionando
    return generateMockSIPNIResponse(endpoint, params);
  }
}

// Gera dados simulados quando SIPNI não está disponível
function generateMockSIPNIResponse(endpoint, params) {
  console.log(`📋 [SIPNI] Gerando resposta simulada para ${endpoint}`);

  const mockResponses = {
    'consulta/cpf': {
      status: 'OK',
      resultado: {
        cpf: params.cpf || '***',
        nome: 'João da Silva',
        situacao: 'Ativo',
        inscricao_estadual: 'Isento',
        municipio: 'São Paulo'
      },
      fonte: 'SIMULADO'
    },
    'consulta/nome': {
      status: 'OK',
      resultado: {
        nome: params.nome || '***',
        cpfs: ['12345678901', '98765432100'],
        ativo: true
      },
      fonte: 'SIMULADO'
    },
    'consulta/mae': {
      status: 'OK',
      resultado: {
        nome_mae: params.nome_mae || '***',
        pessoas_associadas: 15,
        ativo: true
      },
      fonte: 'SIMULADO'
    },
    'consulta/pai': {
      status: 'OK',
      resultado: {
        nome_pai: params.nome_pai || '***',
        pessoas_associadas: 8,
        ativo: true
      },
      fonte: 'SIMULADO'
    },
    'consulta/rg': {
      status: 'OK',
      resultado: {
        rg: params.rg || '***',
        nome: 'Maria Santos',
        data_emissao: '2015-05-20',
        orgao_expedidor: 'SSP/SP'
      },
      fonte: 'SIMULADO'
    },
    'consulta/tel': {
      status: 'OK',
      resultado: {
        telefone: params.telefone || '***',
        proprietario: 'João Silva',
        operadora: 'Claro',
        ativo: true
      },
      fonte: 'SIMULADO'
    },
    'consulta/situacao_cpf': {
      status: 'OK',
      resultado: {
        cpf: params.cpf || '***',
        situacao: 'Ativa',
        inscricao: 'Regular'
      },
      fonte: 'SIMULADO'
    },
    'consulta/cbo': {
      status: 'OK',
      resultado: {
        cbo: params.cbo || '***',
        descricao: 'Profissional de Tecnologia da Informação',
        pessoas: 1250
      },
      fonte: 'SIMULADO'
    }
  };

  return mockResponses[endpoint] || {
    status: 'OK',
    resultado: { mensagem: 'Consulta simulada' },
    fonte: 'SIMULADO'
  };
}

// Exporta funções
export { authenticateSIPNI, querySIPNI, SIPNI_CONFIG };
