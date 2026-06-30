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
import crypto from 'crypto';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const archiver = require('archiver');
import zlib from 'zlib';
import dns from 'dns/promises';
import { processReplyMarkup } from './emoji-helpers.js';
import { searchByEmail, searchByUsername, searchLeakCheck, searchXposedOrNot, searchIntelX, searchLeakLookup, formatHudsonRockResult } from './hudsonrock-api.js';
import { searchGitHub, checkSMTP, socialScan, checkGravatar, searchHunter, checkEmailRep, formatGitHub, formatSMTP, formatSocial, formatGravatar, formatHunter, formatEmailRep } from './osint-email.js';
import { checkWhatsApp, scanLink, reverseImage, checkPixKey, usernameScan, checkPassword, searchAddress, checkBin, formatWhatsApp, formatLink, formatReverseImage, formatPixKey, formatUsername, formatPassword, formatAddress, formatBin } from './osint-tools.js';
import { querySIPNI } from './sipni-api.js';
import { lookupShodan, formatShodanResult } from './shodan-api.js';
import { consultarPlaca, consultarCpf } from './radar-serpro.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKEN = process.env.TELEGRAM_TOKEN;
const BANNER_JPG = path.join(__dirname, 'assets', 'banner.jpg');
const BANNER_PNG = path.join(__dirname, 'assets', 'banner.png');
const BANNER_VIDEO = path.join(__dirname, 'assets', 'banner.mp4');
const BANNER_PATH = BANNER_JPG; // Para compatibilidade com código existente
const PLANOS_BANNER = path.join(__dirname, '..', 'planos.jpg');

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
function clearCachedAccess(userId) {
  userAccessCache.delete(userId);
}


// ══════════════════════════════════════════════════
// SISTEMA DE LICENÇA / TRIAL — CONFIGURAÇÃO
// ══════════════════════════════════════════════════
const OWNER_PROFILE = process.env.ADMIN_PROFILE_URL || 'https://t.me/controletotal';
const ADMIN_ID = process.env.TELEGRAM_CHAT_ID ? parseInt(process.env.TELEGRAM_CHAT_ID) : 8694124825; // Telegram ID do admin (@controletotal)
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ? parseInt(process.env.TELEGRAM_CHAT_ID) : ADMIN_ID; // Chat para notificações do Portal SISP
let maintenanceMode = false; // Modo manutenção global
const TRIAL_MAX_SEARCHES = 999999;
const TRIAL_MAX_RESULTS = 20;
const GROUP_MAX_RESULTS = 50;

function getPlanLimit(access) {
  if (access.status === 'premium' && access.plan) {
    if (access.plan === 'STARTER') return 250;
    if (access.plan === 'PREMIUM') return 500;
    if (access.plan === 'VIP') return 1000;
    if (access.plan === 'ECONOMIC') return 300;
    if (access.plan === 'ADVANCED') return 800;
    if (access.plan === 'ULTRA') return 5000;
    if (access.plan === 'ELITE') return 50000;
  }
  if (access.status === 'premium') return Infinity;
  if (access.status === 'group') return GROUP_MAX_RESULTS;
  return TRIAL_MAX_RESULTS;
}
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



async function getMaxRows(chatId) {
  const inGroup = groupChats.has(chatId);
  const a = await checkUserAccess(chatId, inGroup);
  const limit = getPlanLimit(a);
  return limit === Infinity ? PREMIUM_MAX_ROWS : limit;
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

// 1. Verifica se tem sessão ativa (multi-dispositivo)
// Prioriza planos pagos sobre FREE (ordena: não-FREE primeiro, depois o mais recente)
let sessRes;
try {
  sessRes = await _writePool.query(
    `SELECT s.expires_at, s.plan FROM user_sessions s
     WHERE s.telegram_id = $1
     ORDER BY CASE WHEN s.plan = 'FREE' THEN 1 ELSE 0 END, s.id DESC
     LIMIT 1`,
    [telegramId]
  );
} catch (err) {
  // If user_sessions table doesn't exist, set empty result to fall back to legacy logic
  if (err.code === '42P01' || err.message?.includes('does not exist') || err.message?.includes('undefined_table')) {
    sessRes = { rows: [] }; // Empty result will trigger fallback
  } else {
    // Re-throw other errors to be caught by outer handler
    throw err;
  }
}

if (sessRes.rows.length > 0) {
  const expiresAt = sessRes.rows[0].expires_at;
  if (expiresAt && new Date(expiresAt) < new Date()) {
    // Sessão expirada
  } else {
    const plan = sessRes.rows[0].plan || 'FREE';
    if (plan === 'FREE') {
      const result = { status: 'free', searchesLeft: 999999, plan: 'FREE', expiresAt: null };
      setCachedAccess(telegramId, result);
      return result;
    }
    const result = { status: 'premium', searchesLeft: Infinity, expiresAt, plan };
    setCachedAccess(telegramId, result);
    return result;
  }
}

    // 1b. Fallback: verifica license_keys antiga (pré-sessões) e cria sessão automaticamente
    const oldRes = await _writePool.query(
      `SELECT id, key, duration_seconds, expires_at FROM license_keys WHERE telegram_id = $1 AND activated_at IS NOT NULL LIMIT 1`,
      [telegramId]
    );
    if (oldRes.rows.length > 0) {
      const r = oldRes.rows[0];
      const expiresAt = r.expires_at;
      if (!expiresAt || new Date(expiresAt) > new Date()) {
        const durSec = r.duration_seconds;
        let plan = 'POWER';
        if (durSec && durSec > 0) {
          const days = durSec / 86400;
          plan = days <= 30 ? 'STARTER' : 'PRO';
        }
        const existingSess = await _writePool.query(
          `SELECT id FROM user_sessions WHERE telegram_id = $1 AND key = $2 LIMIT 1`,
          [telegramId, r.key]
        );
        if (existingSess.rows.length === 0) {
          if (durSec && durSec > 0) {
            await _writePool.query(
              `INSERT INTO user_sessions (telegram_id, key, plan, expires_at) VALUES ($1, $2, $3, $4)`,
              [telegramId, r.key, plan, expiresAt]
            ).catch(() => {});
          } else {
            await _writePool.query(
              `INSERT INTO user_sessions (telegram_id, key, plan) VALUES ($1, $2, $3)`,
              [telegramId, r.key, plan]
            ).catch(() => {});
          }
        }
        const result = { status: 'premium', searchesLeft: Infinity, expiresAt, plan };
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
      `SELECT id, duration_seconds, expires_days FROM license_keys WHERE key = $1 LIMIT 1`,
      [key.trim().toUpperCase()]
    );
    if (res.rows.length === 0) {
      return { success: false, message: '❌ *Key Inválida*\n\nVerifique e tente novamente.' };
    }

    // Calcula duração total em segundos
    const durSec = res.rows[0].duration_seconds != null
      ? Number(res.rows[0].duration_seconds)
      : (res.rows[0].expires_days ? Number(res.rows[0].expires_days) * 86400 : null);

    // Define o nome do plano
    let plan = 'POWER';
    if (durSec && durSec > 0) {
      const days = durSec / 86400;
      if (days <= 30) plan = 'STARTER';
      else plan = 'PRO';
    }

    // Verifica se já tem sessão para este telegram_id com esta key
    const existing = await _writePool.query(
      `SELECT id FROM user_sessions WHERE telegram_id = $1 AND key = $2 LIMIT 1`,
      [telegramId, key.trim().toUpperCase()]
    );
    if (existing.rows.length > 0) {
      return { success: false, message: '⚠️ *Você já está logado com esta key!*\n\nUse /start para acessar o menu.' };
    }

    // Remove sessões FREE anteriores (evita conflito com sessão premium)
    await _writePool.query(
      `DELETE FROM user_sessions WHERE telegram_id = $1 AND plan = 'FREE'`,
      [telegramId]
    ).catch(() => {});

    // Atualiza license_keys com telegram_id (para compatibilidade com login email+senha)
    await _writePool.query(
      `UPDATE license_keys SET telegram_id = $1, activated_at = COALESCE(activated_at, NOW()) WHERE key = $2`,
      [telegramId, key.trim().toUpperCase()]
    ).catch(() => {});

    // Limpa cache de acesso
    clearCachedAccess(telegramId);

    // Cria sessão (permite mesma key em múltiplos telegram_ids)
    if (durSec && durSec > 0) {
      await _writePool.query(
        `INSERT INTO user_sessions (telegram_id, key, plan, expires_at) VALUES ($1, $2, $3, now() + ($4::bigint || ' seconds')::INTERVAL)`,
        [telegramId, key.trim().toUpperCase(), plan, durSec]
      );
      const label = formatDuration(durSec);
      return { success: true, message: `✅ *Login realizado!*\n\n👤 *Plano:* ${plan}\n⏳ Válido por *${label}*\n\nAproveite o acesso premium!` };
    } else {
      await _writePool.query(
        `INSERT INTO user_sessions (telegram_id, key, plan) VALUES ($1, $2, $3)`,
        [telegramId, key.trim().toUpperCase(), plan]
      );
      return { success: true, message: `✅ *Login realizado!*\n\n👤 *Plano:* ${plan}\n♾️ *Vitalício*\n\nAproveite o acesso premium!` };
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

function formatRowJson(row) {
  return JSON.stringify({
    url: row.url || '',
    email: row.email || '',
    senha: row.senha || '',
    ip: row.ip || '',
    data: row.data || ''
  });
}

function formatRowCsv(row) {
  const esc = v => `"${(v || '').replace(/"/g, '""')}"`;
  return [esc(row.url), esc(row.email), esc(row.senha), esc(row.ip), esc(row.data)].join(',');
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

    // Filtra sites .gov.br (só para não-premium)
    if (!isPremium && url && /\.gov\.br/i.test(url)) continue;
    if (!isPremium && email && /\.gov\.br/i.test(email)) continue;

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
      key = `${url.trim()}`;
    } else {
      key = `${url.trim()}`;
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
const pendingSearch = new Map(); // `${chatId}_${userId}` -> fieldName
const pendingConsulta = new Map(); // `${chatId}_${userId}` -> apiKey
const pendingConfig = new Map(); // chatId -> 'api_key' | 'max_results'
const pendingLogin = new Map();  // chatId -> { email? }
const pendingRegister = new Map(); // chatId -> { email? }

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
  titulo:  { name: '🗳️ Título Eleitor',      url: `${BASE_URL}/api/consulta/busca/titulo?q=`, param: 'q' },
};

const SIPNI_CONSULTAS = {
  cpf:     { endpoint: 'consulta/cpf',      param: 'cpf', name: '🔢 CPF' },
  nome:    { endpoint: 'consulta/nome',     param: 'nome', name: '👤 Nome' },
  mae:     { endpoint: 'consulta/mae',      param: 'mae', name: '👩 Nome da Mãe' },
  pai:     { endpoint: 'consulta/pai',      param: 'pai', name: '👨 Nome do Pai' },
  rg:      { endpoint: 'consulta/rg',       param: 'rg', name: '🆔 RG' },
  tel:     { endpoint: 'consulta/tel',      param: 'tel', name: '📞 Telefone' },
  sit_cpf: { endpoint: 'consulta/situacao', param: 'cpf', name: '✅ Situação CPF' },
  titulo:  { endpoint: 'consulta/titulo',   param: 'titulo', name: '🗳️ Título Eleitor' },
};

const CONSULTA_CACHE_PATH = path.join(TMP_DIR, 'consulta_cache.json');
let consultaCache = {};
try { consultaCache = JSON.parse(fs.readFileSync(CONSULTA_CACHE_PATH, 'utf8')); } catch (_) {}
function saveConsultaCache() {
  try { fs.writeFileSync(CONSULTA_CACHE_PATH, JSON.stringify(consultaCache), 'utf8'); } catch (_) {}
}

// ══════════════════════════════════════════════════════
// SIPNI DATASUS - INTEGRAÇÃO VIA API LOCAL
// (As funções de autenticação e query estão em sipni-api.js)
// ══════════════════════════════════════════════════════

function escV2(s) { return s.replace(/([\(\)\.\!\-\#\=\+\{\}\[\]\|])/g, '\\$1'); }

const newSearchBtn = { inline_keyboard: [[{ text: '🔍 NOVA BUSCA', callback_data: 'search_menu', style: 'primary' }], [{ text: '🏠 MENU PRINCIPAL', callback_data: 'back_start', style: 'primary' }], [{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] };
const noResultBtn = { inline_keyboard: [[{ text: '🔍 NOVA BUSCA', callback_data: 'search_menu', style: 'primary' }], [{ text: '🏠 MENU PRINCIPAL', callback_data: 'back_start', style: 'primary' }]] };
const cancelSearchBtn = { inline_keyboard: [[{ text: '🔴 CANCELAR BUSCA', callback_data: 'cancel_search', style: 'primary' }]] };
const novaBtn = { inline_keyboard: [[{ text: '🔍 FAZER OUTRA', callback_data: 'fazer_outra', style: 'primary' }], [{ text: '🏠 MENU PRINCIPAL', callback_data: 'back_start', style: 'primary' }], [{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] };
const runningSearches = new Map(); // chatId -> { cancelled: boolean }
const groupChats = new Set(); // chatId de grupos onde o bot já validou o owner
const groupChatsLogged = new Set(); // chatId já logado (evita spam no console)
const groupOwners = new Map(); // chatId -> userId do owner/admin
const monitoringStates = new Map(); // chatId -> { type: 'email'|'username' }
const dailySearchCounts = new Map(); // chatId -> { date: 'YYYY-MM-DD', count: 0 }

function getDailyLimit(plan) {
  const limits = { STARTER: 15, PREMIUM: 50, VIP: 200, ECONOMIC: 50, ADVANCED: 100, ULTRA: 500, ELITE: Infinity };
  return limits[plan] || Infinity;
}

function getRemainingSearches(chatId, plan) {
  const limit = getDailyLimit(plan);
  if (limit === Infinity) return { remaining: Infinity, resetIn: null };
  const today = new Date().toISOString().split('T')[0];
  const entry = dailySearchCounts.get(chatId);
  let used = 0;
  if (entry && entry.date === today) used = entry.count;
  const remaining = Math.max(0, limit - used);
  const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);
  const msLeft = endOfDay - Date.now();
  const hours = Math.floor(msLeft / 3600000);
  const mins = Math.floor((msLeft % 3600000) / 60000);
  return { remaining, resetIn: `${hours}h ${mins}min` };
}

// ══════════════════════════════════════════════════
// FORMATA RESULTADOS COM LIMITE DE TRIAL
// ══════════════════════════════════════════════════
async function formatRowsWithLimit(rows, format, chatId) {
  const inGroup = groupChats.has(chatId);
  const access = await checkUserAccess(chatId, inGroup);
  const isPremium = access.status === 'premium';
  const isGroup = access.status === 'group';
  const formatLabel = { chk: 'USER:PASS', chk2: 'URL:USER:PASS', json: 'JSON', csv: 'CSV', full: 'FULL' }[format] || format.toUpperCase();
  const formatter = format === 'chk' ? formatRowChk : format === 'chk2' ? formatRowChk2 : format === 'json' ? formatRowJson : format === 'csv' ? formatRowCsv : formatRow;
  const limit = getPlanLimit(access);
  const limited = rows.slice(0, limit);
  const header = `📁 Formato: ${formatLabel}\n━━━━━━━━━━━━━━━━━━━━━━\n`;
  const content = format === 'json' ? '[' + limited.map(formatter).join(',\n') + ']' : format === 'csv' ? 'url,email,senha,ip,data\n' + limited.map(formatter).join('\n') : header + limited.map(formatter).join('\n');
  return { content, count: limited.length, total: rows.length, limited: rows.length > limit };
}

// ══════════════════════════════════════════════════
// BUSCA POR CAMPO ESPECÍFICO (url, email, senha, telefone)
// ══════════════════════════════════════════════════
async function sendResults(chatId, field, query, pool, threadId, format = 'full', username = '') {
  const opts = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;

  // DB5 (último pool) é admin-only
  if (_publicPool && chatId !== ADMIN_ID) pool = _publicPool;

  if (!query || query.trim().length < 2) {
    return bot.sendMessage(chatId, `❌ Uso: \`/${field} <valor>\``, opts({ parse_mode: 'Markdown' }));
  }

  const q = query.trim();
  const fieldEmoji = { url: '🌐', email: '📧', senha: '🔑', telefone: '📱' }[field] || '🔍';
  const doPartial = q.length >= 6;
  const inGroup = groupChats.has(chatId);

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

    const buscadoPor = username ? `\n👤 *Buscado por* — ${username}` : '';
    if (rows.length === 0) {
      const hint = field === 'url'
        ? `\n\n💡 _Tente sem http:// ex: \`/inurl site.gov.br\`_`
        : !doPartial ? `\n\n💡 _Termo curto: só busca exata._` : '';
      return bot.sendMessage(chatId, `❌ Nenhum resultado para \`${q}\`${hint}${buscadoPor}`, opts({ parse_mode: 'Markdown', reply_markup: inGroup ? undefined : noResultBtn }));
    }

    const cleanedRows = await getUniqueValidRows(rows, format, chatId);
    if (cleanedRows.length === 0) {
      if (loadingMsg) bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
      if (cleanedRows.govBlocked) {
        return bot.sendMessage(chatId, `❌ Usuários Trial não tem permissão para acessar órgãos governamentais`, opts({ parse_mode: 'Markdown' }));
      }
      return bot.sendMessage(chatId, `❌ Nenhum resultado válido (com usuário e senha) encontrado para \`${q}\`${buscadoPor}`, opts({ parse_mode: 'Markdown' }));
    }

    const { content, count, total, limited } = await formatRowsWithLimit(cleanedRows, format, chatId);
    const safeQuery = q.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 40);
    const formatTag = format === 'chk' ? 'CHK' : format === 'chk2' ? 'CHK2' : format === 'json' ? 'JSON' : format === 'csv' ? 'CSV' : field.toUpperCase();
    const limitNote = rows.length >= MAX_ROWS ? `\n⚠️ _Limite de ${MAX_ROWS.toLocaleString('pt-BR')} resultados atingido_` : '';
    const trialNote = limited ? `\n⚠️ _Modo teste: apenas ${count.toLocaleString('pt-BR')} resultados exibidos_` : '';
    const access = await checkUserAccess(chatId, inGroup);
    const isPremium = access.status === 'premium';
    const isGroup = access.status === 'group';
    const totalNote = (isPremium || isGroup) && total > count ? `\n📊 _Total de logins encontrados: ${total.toLocaleString('pt-BR')}_` : '';
    const formatLabel = format === 'chk' ? 'USER:PASS' : format === 'chk2' ? 'URL:USER:PASS' : format === 'full' ? 'FULL' : format === 'json' ? 'JSON' : format === 'csv' ? 'CSV' : field.toUpperCase();

    const fileExt = format === 'json' ? 'json' : format === 'csv' ? 'csv' : 'txt';
    const contentType = format === 'json' ? 'application/json' : format === 'csv' ? 'text/csv' : 'text/plain';

    const btn = inGroup ? undefined : newSearchBtn;
    const niceIcon = { url: '🌐', email: '📧', senha: '🔑', telefone: '📱', SENHA: '🔑', TELEFONE: '📱' }[field] || '📁';
    await bot.sendDocument(chatId, Buffer.from(content, 'utf8'), opts({
      caption: `${niceIcon} *${formatLabel}* — \`${q}\`\n📁 *Formato:* ${formatLabel}\n📂 *${count.toLocaleString('pt-BR')}* logins encontrados${limitNote}${trialNote}${totalNote}${buscadoPor}`,
      parse_mode: 'Markdown',
      reply_markup: btn
    }), { filename: `BREACH_${formatLabel}_${safeQuery}.${fileExt}`, contentType });

    if (field === 'email') {
      try {
        const [hrData, lcData, xonData, ixData, llData] = await Promise.all([
          searchByEmail(q),
          searchLeakCheck(q).catch(() => null),
          searchXposedOrNot(q).catch(() => null),
          searchIntelX(q).catch(() => null),
          searchLeakLookup(q).catch(() => null)
        ]);
        if (hrData && hrData.stealers && hrData.stealers.length > 0) {
          const msg = formatHudsonRockResult(hrData, 'email', q);
          await bot.sendMessage(chatId, '```\n' + msg.replace(/```/g, '') + '\n```', opts({ parse_mode: 'Markdown' })).catch(() => {});
        }
        let breachSources = [];
        let totalFound = 0;
        if (lcData && lcData.success && lcData.found > 0) {
          totalFound += lcData.found;
          breachSources = breachSources.concat((lcData.sources || []).map(s => `${s.name}${s.date ? ' (' + s.date + ')' : ''}`));
        }
        if (xonData && xonData.breaches && xonData.breaches.length > 0) {
          const names = xonData.breaches.flat().filter(Boolean);
          totalFound += names.length;
          breachSources = breachSources.concat(names);
        }
        // IntelX: só extrai IPs separadamente, não polui a lista de vazamentos
        if (llData && llData.error === false && llData.message) {
          const names = Object.keys(llData.message).slice(0, 20);
          if (names.length > 0) {
            totalFound += names.length;
            breachSources = breachSources.concat(names);
          }
        }
        if (breachSources.length > 0) {
          const unique = [...new Set(breachSources)].slice(0, 25);
          await bot.sendMessage(chatId, `📋 *Vazamentos encontrados:* ${totalFound}\n\n${unique.map(s => `• ${s}`).join('\n')}`, opts({ parse_mode: 'Markdown' })).catch(() => {});
        }

        // ── Extrai IPs e Emails do IntelX ──
        if (ixData && ixData.records && ixData.records.length > 0) {
          const ipSet = new Set();
          const emailSet = new Set();
          const ipRegex = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
          const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
          for (const rec of ixData.records) {
            const text = [rec.name, rec.value, rec.key, rec.content, rec.date, rec.bucket, rec.media_name, JSON.stringify(rec)].filter(Boolean).join(' ');
            const ipMatches = text.match(ipRegex);
            if (ipMatches) ipMatches.forEach(ip => ipSet.add(ip));
            const emailMatches = text.match(emailRegex);
            if (emailMatches) emailMatches.forEach(e => emailSet.add(e.toLowerCase()));
          }
          if (ipSet.size > 0) {
            const ips = [...ipSet].filter(ip => {
              const parts = ip.split('.').map(Number);
              return parts.every(p => p >= 0 && p <= 255) && parts[0] !== 127 && !ip.startsWith('10.') && !ip.startsWith('192.168.') && !(parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
            });
            if (ips.length > 0) {
              await bot.sendMessage(chatId, `🌐 *IPs encontrados:* ${ips.length}\n\`\`\`\n${ips.slice(0, 30).join('\n')}\n\`\`\`` + (ips.length > 30 ? `\n...e mais ${ips.length - 30}` : ''), opts({ parse_mode: 'Markdown' })).catch(() => {});
              for (let i = 0; i < ips.length; i++) {
                if (i > 0) await new Promise(r => setTimeout(r, 500));
                const ipData = await lookupShodan(ips[i]);
                const formatted = formatShodanResult(ipData);
                if (formatted) {
                  await bot.sendMessage(chatId, `🔍 *${ips[i]}*\n${formatted}`, opts({ parse_mode: 'Markdown' })).catch(() => {});
                }
                try {
                  const geoRes = await fetch(`http://ip-api.com/json/${encodeURIComponent(ips[i])}?fields=status,country,regionName,city,lat,lon,isp,org,as`, { signal: AbortSignal.timeout(4000) });
                  if (geoRes.ok) {
                    const geo = await geoRes.json();
                    if (geo.status === 'success') {
                      await bot.sendMessage(chatId, `📍 *${ips[i]}*\n🌍 ${geo.city}, ${geo.regionName} - ${geo.country}\n📡 ${geo.isp || geo.org || '?'}\n🔄 ${geo.as || ''}`, opts({ parse_mode: 'Markdown' })).catch(() => {});
                    }
                  }
                } catch {}
              }
            }
          }
          if (emailSet.size > 0) {
            emailSet.delete(q.toLowerCase());
            if (emailSet.size > 0) {
              await bot.sendMessage(chatId, `📧 *Emails encontrados:* ${emailSet.size}\n\`\`\`\n${[...emailSet].slice(0, 30).join('\n')}\n\`\`\`` + (emailSet.size > 30 ? `\n...e mais ${emailSet.size - 30}` : ''), opts({ parse_mode: 'Markdown' })).catch(() => {});
            }
          }
        }

        // ── OSINT Extras ──
        const [gitData, smtpData, socialData, gravData, hunterData, repData] = await Promise.all([
          searchGitHub(q).catch(() => null),
          checkSMTP(q).catch(() => null),
          socialScan(q).catch(() => null),
          checkGravatar(q).catch(() => null),
          searchHunter(q).catch(() => null),
          checkEmailRep(q).catch(() => null)
        ]);
        const osintParts = [
          gitData ? formatGitHub(gitData) : null,
          smtpData ? formatSMTP(smtpData) : null,
          socialData ? formatSocial(socialData) : null,
          hunterData ? formatHunter(hunterData) : null,
          repData ? formatEmailRep(repData) : null
        ].filter(Boolean);
        if (gravData && gravData.exists) {
          await bot.sendPhoto(chatId, gravData.avatarUrl, opts({
            caption: `👤 *Gravatar — ${q}*\n[Ver perfil completo](${gravData.profileUrl})`,
            parse_mode: 'Markdown'
          })).catch(() => {});
        }
        if (osintParts.length > 0) {
          await bot.sendMessage(chatId, `🔎 *OSINT — ${q}*\n\n${osintParts.join('\n\n')}`,
            opts({ parse_mode: 'Markdown' })).catch(() => {});
        }

        // ── Busca emails associados no DB ──
        if (cleanedRows.length > 0) {
          const pws = [...new Set(cleanedRows.map(r => r.senha?.trim()).filter(p => p && p.length >= 4))];
          if (pws.length > 0) {
            try {
              const results = [];
              for (let i = 0; i < pws.length; i += 10) {
                const batch = pws.slice(i, i + 10).map(pw =>
                  pool.query(`SELECT email FROM credentials WHERE senha = $1 AND email IS NOT NULL AND email != '' LIMIT 200`, [pw])
                    .catch(() => ({ rows: [] }))
                );
                results.push(...await Promise.all(batch));
              }
              const cleanDomains = ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'yahoo.com.br', 'bol.com.br', 'uol.com.br', 'icloud.com', 'protonmail.com', 'mail.com', 'live.com', 'msn.com', 'aol.com'];
              const allEmails = [...new Set(results.flatMap(r => r.rows.map(rr => rr.email.trim().toLowerCase()).filter(e => e && e !== q.trim().toLowerCase() && cleanDomains.some(d => e.endsWith('@' + d)))))];
              if (allEmails.length > 0) {
                bot.sendMessage(chatId, `📧 *Emails associados:* ${allEmails.length}\n\`\`\`\n${allEmails.join('\n')}\n\`\`\``, opts({ parse_mode: 'Markdown' })).catch(() => {});
                try {
                  const ipResults = await pool.query(`SELECT DISTINCT ip FROM credentials WHERE email = ANY($1) AND ip IS NOT NULL AND ip != '' LIMIT 100`, [allEmails]);
                  const ips = [...new Set(ipResults.rows.map(r => r.ip.trim()).filter(Boolean))];
                  if (ips.length > 0) {
                    bot.sendMessage(chatId, `🌐 *IPs dos emails associados:* ${ips.length}\n\`\`\`\n${ips.join('\n')}\n\`\`\``, opts({ parse_mode: 'Markdown' })).catch(() => {});
                  }
                } catch (e) { console.error('[EMAIL IPS]', e?.message); }
              }
            } catch (e) { console.error('[ASSOC EMAILS]', e?.message); }
          }
        }
      } catch (e) { console.error('[OSINT ENRICH]', e?.message); }
    }

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
    return sendResults(chatId, tipo, q, pool, threadId, 'full', '');
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
        return bot.sendMessage(chatId, `❌ Usuários Trial não tem permissão para acessar órgãos governamentais`, opts({ parse_mode: 'Markdown' }));
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
        return bot.sendMessage(chatId, `❌ Usuários Trial não tem permissão para acessar órgãos governamentais`, opts({ parse_mode: 'Markdown' }));
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

    try {
      const [hrData, lcData, xonData, ixData, llData] = await Promise.all([
        searchByUsername(q),
        searchLeakCheck(q).catch(() => null),
        searchXposedOrNot(q).catch(() => null),
        searchIntelX(q).catch(() => null),
        searchLeakLookup(q).catch(() => null)
      ]);
      if (hrData && hrData.stealers && hrData.stealers.length > 0) {
        const msg = formatHudsonRockResult(hrData, 'username', q);
        await bot.sendMessage(chatId, '```\n' + msg.replace(/```/g, '') + '\n```', opts({ parse_mode: 'Markdown' })).catch(() => {});
      }
      let breachSources = [];
      let totalFound = 0;
      if (lcData && lcData.success && lcData.found > 0) {
        totalFound += lcData.found;
        breachSources = breachSources.concat((lcData.sources || []).map(s => `${s.name}${s.date ? ' (' + s.date + ')' : ''}`));
      }
        if (xonData && xonData.breaches && xonData.breaches.length > 0) {
          const names = xonData.breaches.flat().filter(Boolean);
          totalFound += names.length;
          breachSources = breachSources.concat(names);
        }
      if (ixData && ixData.records && ixData.records.length > 0) {
        totalFound += ixData.records.length;
        breachSources = breachSources.concat(...ixData.records.map(r => r.name ? [r.name] : []));
      }
      if (llData && llData.error === false && llData.message) {
        const names = Object.keys(llData.message).slice(0, 20);
        if (names.length > 0) {
          totalFound += names.length;
          breachSources = breachSources.concat(names);
        }
      }
      if (breachSources.length > 0) {
        const unique = [...new Set(breachSources)].slice(0, 25);
        await bot.sendMessage(chatId, `📋 *Vazamentos encontrados:* ${totalFound}\n\n${unique.map(s => `• ${s}`).join('\n')}`, opts({ parse_mode: 'Markdown' })).catch(() => {});
      }
    } catch (e) {}

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
        return bot.sendMessage(chatId, `❌ Usuários Trial não tem permissão para acessar órgãos governamentais`, opts({ parse_mode: 'Markdown' }));
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

    try {
      const lcData = await searchLeakCheck(q).catch(() => null);
      if (lcData && lcData.success && lcData.found > 0) {
        const src = (lcData.sources || []).slice(0, 15).map(s => `• ${s.name}${s.date ? ' (' + s.date + ')' : ''}`).join('\n');
        await bot.sendMessage(chatId, `📋 *Vazamentos encontrados para IP:* ${lcData.found}\n\n${src}`, opts({ parse_mode: 'Markdown' })).catch(() => {});
      }
    } catch (e) {}

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
        return bot.sendMessage(chatId, `❌ Usuários Trial não tem permissão para acessar órgãos governamentais`, opts({ parse_mode: 'Markdown' }));
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
        return bot.sendMessage(chatId, `❌ Usuários Trial não tem permissão para acessar órgãos governamentais`, opts({ parse_mode: 'Markdown' }));
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
        return bot.sendMessage(chatId, `❌ Usuários Trial não tem permissão para acessar órgãos governamentais`, opts({ parse_mode: 'Markdown' }));
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
        return bot.sendMessage(chatId, `❌ Usuários Trial não tem permissão para acessar órgãos governamentais`, opts({ parse_mode: 'Markdown' }));
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
  const isPremium = groupChats.has(chatId) || ((await checkUserAccess(chatId, groupChats.has(chatId)))?.status === 'premium');
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
    const rowLimit = getPlanLimit(cachedAccess);
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
      `\n\n_Use \`/inurl ${q}\` para baixar registros_`,
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

export async function setupBot(app, pool, writePool, publicPool) {
  if (!TOKEN) {
    console.warn('⚠️ TELEGRAM_TOKEN não definido. Bot desativado.');
    return;
  }

  // Atribui pool de escrita para funções de licença/trial
  _writePool = writePool;
  _publicPool = publicPool || pool;



// Cria tabela de sessões se não existir
   await _writePool.query(`
     CREATE TABLE IF NOT EXISTS user_sessions (
       id SERIAL PRIMARY KEY,
       telegram_id BIGINT NOT NULL,
       key TEXT NOT NULL,
       plan TEXT,
       activated_at TIMESTAMPTZ DEFAULT NOW(),
       expires_at TIMESTAMPTZ
     )
   `).catch(err => {
     console.warn('⚠️ [BOT] Falha ao criar tabela user_sessions:', err.message);
   });
   await _writePool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_tg ON user_sessions(telegram_id)`).catch(err => {
     console.warn('⚠️ [BOT] Falha ao criar índice idx_sessions_tg:', err.message);
   });

// Cria tabela de monitoramento
   await _writePool.query(`
     CREATE TABLE IF NOT EXISTS monitored_items (
       id SERIAL PRIMARY KEY,
       chat_id BIGINT NOT NULL,
       type TEXT NOT NULL CHECK (type IN ('email', 'username')),
       value TEXT NOT NULL,
       last_check TIMESTAMPTZ,
       created_at TIMESTAMPTZ DEFAULT NOW(),
       UNIQUE(chat_id, type, value)
     )
   `).catch(err => {
     console.warn('⚠️ [BOT] Falha ao criar tabela monitored_items:', err.message);
   });

// ── Funções de monitoramento ──
   async function addMonitoredItem(chatId, type, value) {
     try {
       await _writePool.query(
         `INSERT INTO monitored_items (chat_id, type, value) VALUES ($1, $2, $3) ON CONFLICT (chat_id, type, value) DO NOTHING`,
         [chatId, type, value.toLowerCase().trim()]
       );
       return true;
     } catch (e) { console.error('[MONITOR] add error:', e.message); return false; }
   }
   async function removeMonitoredItem(chatId, type, value) {
     try {
       await _writePool.query(`DELETE FROM monitored_items WHERE chat_id = $1 AND type = $2 AND value = $3`, [chatId, type, value.toLowerCase().trim()]);
       return true;
     } catch (e) { console.error('[MONITOR] remove error:', e.message); return false; }
   }
   async function listMonitoredItems(chatId) {
     try {
       const r = await _writePool.query(`SELECT type, value FROM monitored_items WHERE chat_id = $1 ORDER BY created_at DESC`, [chatId]);
       return r.rows;
     } catch (e) { console.error('[MONITOR] list error:', e.message); return []; }
   }
   async function getAllMonitoredItems() {
     try {
       const r = await _writePool.query(`SELECT id, chat_id, type, value FROM monitored_items ORDER BY created_at`);
       return r.rows;
     } catch (e) { console.error('[MONITOR] getAll error:', e.message); return []; }
   }
   async function updateLastCheck(id) {
     try { await _writePool.query(`UPDATE monitored_items SET last_check = NOW() WHERE id = $1`, [id]); } catch {}
   }

// Migração: adiciona coluna last_reset na tabela bot_trials
   await _writePool.query(`ALTER TABLE bot_trials ADD COLUMN IF NOT EXISTS last_reset TIMESTAMPTZ DEFAULT NOW()`).catch(err => {
     console.warn('⚠️ [BOT] Falha ao adicionar coluna last_reset na tabela bot_trials:', err.message);
   });
   // Migração: adiciona coluna max_results na tabela users
   await _writePool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS max_results INT DEFAULT 100`).catch(err => {
     console.warn('⚠️ [BOT] Falha ao adicionar coluna max_results na tabela users:', err.message);
   });

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
    { command: 'inurl', description: '🔗 Buscar por termo na URL' },
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

  // ── Função reutilizável: /conta — Gerenciar conta ──
  async function handleContaCommand(chatId, threadId) {
    const opts = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;
    try {
      const user = await _writePool.query(
        `SELECT s.expires_at, s.plan, s.key FROM user_sessions s WHERE s.telegram_id = $1 ORDER BY CASE WHEN s.plan = 'FREE' THEN 1 ELSE 0 END, s.id DESC LIMIT 1`,
        [chatId]
      );
      const row = user.rows[0];
      const isActive = row && (!row.expires_at || new Date(row.expires_at) > new Date());
      const expires = row?.expires_at ? new Date(row.expires_at).toLocaleDateString('pt-BR') : (row ? 'Vitalício' : 'Não ativado');
      const plan = row?.plan || '—';
      const key = row?.key || '—';
      const status = isActive ? '💎 Premium' : '🟢 Free';
      const maxResults = plan === 'STARTER' ? '5.000' : plan === 'PRO' ? '20.000' : plan === 'POWER' ? 'Ilimitado' : '100';
      const keyLine = plan !== 'FREE' && plan !== '—' ? `\n🔑 Key: \`${key}\`` : '';
      const contaText = `👤 *MINHA CONTA*\n\n🆔 ID: \`${chatId}\`\n📊 Status: ${status}\n📋 Plano: ${escV2(plan)}${keyLine}\n📅 Expira: ${escV2(expires)}\n📈 Limite: ${escV2(maxResults)}\n\n💎 *Planos disponíveis mediante pagamento*\n_Consulte o admin para adquirir uma key._`;
      return bot.sendMessage(chatId, contaText,
        opts({
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [[{ text: '💎 PLANOS', callback_data: 'show_plans', style: 'primary' }, { text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }]]
          }
        })
      );
    } catch (e) {
      return bot.sendMessage(chatId, `❌ Erro: ${e.message}`, opts());
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
        const userKey = `${chatId}_${msg.from?.id || ''}`;
        const pendingField = pendingSearch.get(userKey) || pendingSearch.get(chatId);

        if (doc.file_name && (doc.file_name.endsWith('.txt') || doc.file_name.endsWith('.csv') || doc.file_name.endsWith('.json'))) {
          // Limite do Telegram Bot API: 20MB
          const maxSize = 20 * 1024 * 1024;
          if (doc.file_size && doc.file_size > maxSize) {
            const sizeMB = (doc.file_size / 1024 / 1024).toFixed(1);
            return bot.sendMessage(chatId, `❌ Arquivo muito grande: *${sizeMB}MB*\n\nLimite do Telegram: *20MB*\n\n💡 _Divida o arquivo em partes menores._`, opts({ parse_mode: 'Markdown' }));
          }
          const tmpPath = await bot.downloadFile(doc.file_id, TMP_DIR);
          return handleFileCheck(chatId, doc, pool, threadId, tmpPath);
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
      let command = isCommand ? text.split(' ')[0].toLowerCase().split('@')[0] : null;
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

        // Busca total de registros em tempo real (com timeout)
        let totalRecords = 0;
        try {
          const results = await Promise.allSettled(
            pool.pools.map(p => Promise.race([
              p.query(`SELECT reltuples::bigint AS count FROM pg_class WHERE relname = 'credentials'`),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
            ]))
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

        // ── NÃO LOGADO: mostra tela de login/cadastro (exceto grupos) ──
        if (userAccess.status !== 'premium' && userAccess.status !== 'group' && userAccess.status !== 'free') {
          const loginText =
            `🔐 *ASSEMBLY LOGS*\n\n` +
            `Você ainda não está logado\\.\n\n` +
            `• 🔑 *Já tem uma chave?* Faça login\n` +
            `• 📝 *Não tem chave?* Cadastre\\-se abaixo\n\n` +
            `_Use os botões abaixo para continuar\\._`;

return bot.sendMessage(chatId, loginText,
             opts({
               parse_mode: 'MarkdownV2',
               reply_markup: {
                 inline_keyboard: [
                   [{ text: '🔑 FAZER LOGIN', callback_data: 'login_start', style: 'primary' }],
                   [{ text: '📝 FAZER CADASTRO', callback_data: 'register_start', style: 'primary' }],
                   [{ text: '🎧 SUPORTE', callback_data: 'support_menu', style: 'primary' }]
                 ]
               }
             })
           );
        }

        // ── LOGADO: mostra menu principal ──
        let statusLine, previewText;

        if (userAccess.expiresAt) {
          const d = new Date(userAccess.expiresAt);
          statusLine = `✅ *PREMIUM* — Expira ${d.toLocaleDateString('pt-BR')}`;
        } else {
          statusLine = `✅ *PREMIUM* — Vitalício 🎉`;
        }

        previewText = `✅ Acesso premium ativo.\nUse os botões abaixo para navegar.`;

        const inGroup = groupChats.has(chatId);
        const helpText =
          `💀 ASSEMBLY LOGS\n\n` +
          `🟢 *MENU PRINCIPAL*\n\n` +
          `${statusLine}\n` +
          `📊 *Total records (305.384.239.394 B)*\n\n` +
          `${previewText}\n\n` +
          `📌 *Navegue usando os botões abaixo:*\n` +
          `🔓 /LOGIN - Acessar com credenciais\n` +
          `🛠️ /FERRAMENTAS - Ver todas as tools\n` +
          `🔎 /CONSULTARDADOS - Consultas avançadas`;

const mainMenuButtons = [
              [{ text: '🛠️ FERRAMENTAS', callback_data: 'tool_buscas', style: 'primary' }],
              [{ text: '🚀 PUXAR LOGINS', callback_data: 'puxar_logins', style: 'primary' }],
              [{ text: '📊 PUXAR DADOS', callback_data: 'puxar_dados', style: 'primary' }],
              [{ text: '👤 MINHA CONTA', callback_data: 'cmd_conta', style: 'primary' }],
              [{ text: '🎧 SUPORTE', callback_data: 'support_menu', style: 'primary' }],
              [{ text: '📜 COMANDOS', callback_data: 'list_commands', style: 'primary' }],
              [{ text: '🔔 MONITORAR', callback_data: 'monitor_menu', style: 'primary' }],
              [{ text: '💎 PLANOS', callback_data: 'show_plans', style: 'primary' }],
              [{ text: '⚙️ CONFIGURAÇÕES', callback_data: 'config_menu', style: 'primary' }, { text: '🌐 IDIOMA', callback_data: 'language_menu', style: 'primary' }],
              [{ text: '📚 REFERÊNCIAS', url: 'https://t.me/+9oaCkNF_klpmMzUx', style: 'primary' }, { text: '🚪 LOGOUT', callback_data: 'logout', style: 'primary' }]
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
                [{ text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]
              ]
            }
          })
        );
      }

      // ── /buscas — Módulos de busca ──
      if (command === '/buscas') {
        pendingSearch.set(userKey, 'smart');
        return bot.sendMessage(chatId,
          `🔍 *BUSCAS*\n\nEnvie o termo que deseja buscar\n(email, url, telefone, usuário):`,
          opts({
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]]
            }
          })
        );
      }

      // ── /puxarlogins — Extrair dados de login ──
      if (command === '/puxarlogins') {
        const mockMsg = { data: 'puxar_logins', message: msg, chat: msg.chat, from: msg.from };
        // Reuse callback logic by emitting the callback
        bot.emit('callback_query', { data: 'puxar_logins', message: msg, from: msg.from, id: Date.now() });
        return;
      }

      // ── /puxardados — Consultas avançadas ──
      if (command === '/puxardados') {
        return showConsultaMenu(chatId, threadId);
      }

      // ── /conta — Gerenciar conta ──
      if (command === '/conta') {
        return handleContaCommand(chatId, threadId);
      }

      // ── /ajuda — alias para /help ──
      if (command === '/ajuda') {
        return bot.sendMessage(chatId,
          `❓ *AJUDA*\n\nComandos disponíveis via botões no menu principal.\n\n💬 *Suporte:* @controletotal`,
          opts({
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[{ text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }]]
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
          const plan = (args || '').trim().toLowerCase();
          let days = null;
          let validSeconds = null;
          let planLabel = '';

          if (plan === 'starter') {
            days = 7;
            validSeconds = days * 86400;
            planLabel = '🚀 STARTER';
          } else if (plan === 'premium') {
            days = 15;
            validSeconds = days * 86400;
            planLabel = '⭐ PREMIUM';
          } else if (plan === 'vip') {
            days = 30;
            validSeconds = days * 86400;
            planLabel = '👑 VIP';
          } else if (plan === 'economic') {
            days = 1;
            validSeconds = days * 86400;
            planLabel = '💎 ECONOMIC';
          } else if (plan === 'advanced') {
            days = 7;
            validSeconds = days * 86400;
            planLabel = '🔹 ADVANCED';
          } else if (plan === 'ultra15') {
            days = 15;
            validSeconds = days * 86400;
            planLabel = '🔹 ULTRA 15D';
          } else if (plan === 'ultra30' || plan === 'ultra') {
            days = 30;
            validSeconds = days * 86400;
            planLabel = '🔹 ULTRA 30D';
          } else if (plan === 'elite') {
            validSeconds = null;
            planLabel = '👑 ELITE';
          } else if (plan === 'elite15') {
            days = 15;
            validSeconds = days * 86400;
            planLabel = '👑 ELITE 15D';
          } else {
            return bot.sendMessage(chatId,
              `❌ *Uso:* \`/genkey starter\`, \`/genkey premium\`, \`/genkey vip\`, \`/genkey economic\`, \`/genkey advanced\`, \`/genkey ultra15\` (15d) ou \`/genkey ultra30\` (30d) ou \`/genkey elite\` ou \`/genkey elite15\` (15d)\n\n` +
              `💎 *PLANOS DISPONÍVEIS*\n\n` +
              `🚀 *STARTER* · R\$ 4,12\n` +
              `   ⏳ 7 dias · 🔍 15/dia · 📄 250\n\n` +
              `⭐ *PREMIUM* · R\$ 8,20\n` +
              `   ⏳ 15 dias · 🔍 50/dia · 📄 500\n\n` +
              `👑 *VIP* · R\$ 13,70\n` +
              `   ⏳ 30 dias · 🔍 200/dia · 📄 1000\n\n` +
              `💎 *ECONOMIC* · R\$ 5,45\n` +
              `   ⏳ 1 dia · 🔍 50/dia · 📄 300\n\n` +
              `🔹 *ADVANCED* · R\$ 10,95\n` +
              `   ⏳ 7 dias · 🔍 100/dia · 📄 800\n\n` +
              `🔹 *ULTRA 15D* · R\$ 19,20\n` +
              `   ⏳ 15 dias · 🔍 500/dia · 📄 5000\n\n` +
              `🔹 *ULTRA 30D* · R\$ 19,20\n` +
              `   ⏳ 30 dias · 🔍 500/dia · 📄 5000\n\n` +
              `👑 *ELITE 15D* · R\$ 45,00\n` +
              `   ⏳ 15 dias · 🔍 Ilimitadas · 📄 50000\n\n` +
              `👑 *ELITE* · R\$ 82,50\n` +
              `   ♾️ Vitalício · 🔍 Ilimitadas · 📄 50000`,
              opts({ parse_mode: 'Markdown' })
            );
          }

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
          const durationText = validSeconds ? `⏳ *Duração:* ${days} dias` : `♾️ *Duração:* Vitalícia`;
          await bot.sendMessage(chatId,
            `✅ *Key ${planLabel} gerada com sucesso!*\n\n` +
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
        if (access.status !== 'premium' && access.status !== 'group' && access.status !== 'free') {
          await registerTrial(chatId);
          await incrementTrialSearch(chatId);
        }
        if (access.status === 'premium' || access.status === 'free') {
          const today = new Date().toISOString().split('T')[0];
          const entry = dailySearchCounts.get(chatId) || { date: today, count: 0 };
          if (entry.date !== today) { entry.date = today; entry.count = 0; }
          entry.count++;
          dailySearchCounts.set(chatId, entry);
        }
      }

      if (command === '/url' || command === '/inurl' || command === '/pesquisar' || command === '/search') {
        if (!args || args.trim().length < 2) {
          pendingSearch.set(userKey, 'url');
          return bot.sendMessage(chatId, `🔗 Buscar INURL\n\nEnvie o *termo* que deseja buscar na URL:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
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
                { text: '🌐 SUBDOMÍNIOS', callback_data: `sub_${queryId}` },
                { text: '📊 JSON', callback_data: `json_${queryId}` }, { text: '📊 CSV', callback_data: `csv_${queryId}` }
              ],
              [{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]
            ]
          }
        }));
      }

      if (command === '/email') {
        if (!args || args.trim().length < 2) {
          pendingSearch.set(userKey, 'email');
          return bot.sendMessage(chatId, `✉️ Buscar por E-mail\n\nEnvie o *E-mail* que deseja buscar:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        return sendResults(chatId, 'email', args, pool, threadId, 'full', username);
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
          return bot.sendMessage(chatId, `👤 Buscar por Usuário\n\nEnvie o *Usuário* que deseja buscar:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        return sendUserResults(chatId, args, pool, threadId);
      }

      // /ip — busca por endereço IP na URL
      if (command === '/ip') {
        if (!args || args.trim().length < 2) {
          pendingSearch.set(userKey, 'ip');
          return bot.sendMessage(chatId, `📍 Buscar por IP\n\nEnvie o *IP* que deseja buscar:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        return sendIpResults(chatId, args, pool, threadId);
      }

      // /inurl — busca URLs que contenham o padrão (ex: wp-admin, login, admin)
      if (command === '/inurl') {
        if (!args || args.trim().length < 2) {
          pendingSearch.set(userKey, 'INURL');
          return bot.sendMessage(chatId, `🔗 Buscar InUrl\n\nEnvie o *termo* que deve conter na URL:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        return sendInurlResults(chatId, args, pool, threadId);
      }

      if (command === '/senha' || command === '/pass' || command === '/password') {
        if (!args || args.trim().length < 2) {
          pendingSearch.set(userKey, 'SENHA');
          return bot.sendMessage(chatId, `🔒 Buscar por Senha\n\nEnvie a *Senha* que deseja buscar:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        return sendResults(chatId, 'SENHA', args, pool, threadId, 'full', username);
      }

      if (command === '/telefone' || command === '/tel' || command === '/phone') {
        if (!args || args.trim().length < 2) {
          pendingSearch.set(userKey, 'TELEFONE');
          return bot.sendMessage(chatId, `📞 Buscar por Telefone\n\nEnvie o *Telefone* que deseja buscar:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        return sendResults(chatId, 'TELEFONE', args, pool, threadId, 'full', username);
      }

      // /inmail — busca por provedor de email
      if (command === '/inmail') {
        if (!args || args.trim().length < 2) {
          pendingSearch.set(userKey, 'INMAIL');
          return bot.sendMessage(chatId, `📨 Buscar InMail\n\nEnvie o *provedor de e-mail*:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        return sendInmailResults(chatId, args, pool, threadId);
      }

      // /cpf — busca por CPF
      if (command === '/cpf') {
        if (!args || args.trim().length < 2) {
          pendingSearch.set(userKey, 'cpf');
          return bot.sendMessage(chatId, `📋 Buscar por CPF\n\nEnvie o *CPF* que deseja buscar:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        return sendCpfResults(chatId, args, pool, threadId);
      }

      // /cnpj — busca por CNPJ
      if (command === '/cnpj') {
        if (!args || args.trim().length < 2) {
          pendingSearch.set(userKey, 'cnpj');
          return bot.sendMessage(chatId, `🏢 Buscar por CNPJ\n\nEnvie o *CNPJ* que deseja buscar:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        return sendCnpjResults(chatId, args, pool, threadId);
      }

      // /checkdomain — resumo completo de um domínio
      if (command === '/checkdomain' || command === '/domain') {
        if (!args || args.trim().length < 2) {
          pendingSearch.set(userKey, 'domain');
          return bot.sendMessage(chatId, `🌍 Buscar por Domínio\n\nEnvie o *Domínio* que deseja buscar:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
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

      // /subdominios — busca logins por subdomínios
      if (command === '/subdominios') {
        if (!args || args.trim().length < 3) {
          pendingSearch.set(userKey, 'subdominios');
          return bot.sendMessage(chatId, `🌐 Buscar Subdomínios\n\nEnvie o *Domínio* para buscar subdomínios:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
        }
        return sendSubdomainResults(chatId, args.trim(), pool, threadId);
      }
      // /whois — OSINT de telefone
      if (command === '/whois') {
        if (!args || args.trim().length < 7) {
          pendingSearch.set(userKey, 'WHOIS');
          return bot.sendMessage(chatId, `🔍 Buscar Whois\n\nEnvie o *Telefone* para consultar (ex: +5511999999999):`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
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
          return bot.sendMessage(chatId, `📍 Buscar GeoIP\n\nEnvie o *IP* ou *Domínio* para geolocalizar:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
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

          if (geo.status !== 'success') {
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
            `📦 Baixar Página (ZIP)\n\nEnvie a *URL* (https://site.com):`,
            opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } })
          );
        }
        return performCopyUrl(chatId, args.trim(), threadId);
      }


      // /cancelar — sai do fluxo de buscas
      if (command === '/cancelar') {
        const userId = msg.from?.id;
        const userKey = `${chatId}_${userId}`;
        pendingSearch.delete(chatId);
        pendingSearch.delete(userKey);
        pendingConsulta.delete(chatId);
        pendingConsulta.delete(userKey);
        pendingLogin.delete(chatId);
        pendingRegister.delete(chatId);
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

      // Verifica se está aguardando configuração
      const configType = pendingConfig.get(chatId);
      if (configType) {
        pendingConfig.delete(chatId);
        
        if (configType === 'api_key') {
          const key = text.trim();
          if (!key || key.length < 5) {
            return bot.sendMessage(chatId, `❌ Chave inválida. Digite uma chave com mínimo 5 caracteres.`, opts());
          }
          
          try {
            // Verificar se a chave é válida no banco
            const keyCheck = await _writePool.query(
              `SELECT duration_seconds FROM license_keys WHERE key = $1 AND activated_at IS NULL`,
              [key]
            );
            
            if (!keyCheck.rows || keyCheck.rows.length === 0) {
              return bot.sendMessage(chatId, `❌ Chave inválida ou já utilizada. Verifique sua chave.`, opts());
            }
            
            // Ativar a chave
            const duration = keyCheck.rows[0].duration_seconds;
            
            if (duration && duration > 0) {
              await _writePool.query(
                `UPDATE license_keys SET telegram_id = $1, activated_at = NOW(), expires_at = NOW() + ($2::bigint || ' seconds')::INTERVAL WHERE key = $3`,
                [chatId, duration, key]
              );
            } else {
              await _writePool.query(
                `UPDATE license_keys SET telegram_id = $1, activated_at = NOW() WHERE key = $2`,
                [chatId, key]
              );
            }
            
            const expiresAt = duration ? new Date(Date.now() + duration * 1000) : null;
            
            await _writePool.query(
              `UPDATE users SET premium_until = $1, max_results = 100000 WHERE telegram_id = $2`,
              [expiresAt, chatId]
            );
            
            const expiresText = expiresAt 
              ? `📅 Expira em: ${expiresAt.toLocaleDateString('pt-BR')}`
              : `📅 Acesso vitalício`;
            
            return bot.sendMessage(chatId,
              `✅ *Plano Ativado com Sucesso!*\n\n` +
              `${expiresText}\n` +
              `📊 Máximo de resultados: 100.000\n\n` +
              `🎉 Aproveite seu acesso premium!`,
              opts({ parse_mode: 'Markdown' })
            );
          } catch (e) {
            console.error('[API KEY ERROR]', e.message);
            return bot.sendMessage(chatId, `❌ Erro ao ativar chave: ${e.message}`, opts());
          }
        }
        
        if (configType === 'max_results') {
          const value = parseInt(text.trim());
          
          if (isNaN(value) || value < 0) {
            return bot.sendMessage(chatId, `❌ Valor inválido. Digite um número.`, opts());
          }
          
          try {
            const user = await _writePool.query('SELECT expires_at FROM user_sessions WHERE telegram_id = $1 ORDER BY CASE WHEN plan = \'FREE\' THEN 1 ELSE 0 END, id DESC LIMIT 1', [chatId]);
            const row = user.rows[0];
            const isPremium = row && (!row.expires_at || new Date(row.expires_at) > new Date());
            const maxLimit = isPremium ? 100000 : 100;
            
            if (value > maxLimit) {
              return bot.sendMessage(chatId,
                `❌ Limite excedido!\n\n` +
                `${isPremium ? '💎 Premium: máx 100.000' : '🟢 Free: máx 100'}`,
                opts()
              );
            }
            
            await _writePool.query(
              `UPDATE users SET max_results = $1 WHERE telegram_id = $2`,
              [value, chatId]
            );
            
            return bot.sendMessage(chatId,
              `✅ *Máximo de resultados atualizado!*\n\n` +
              `📊 Novo limite: ${value.toLocaleString('pt-BR')} resultados`,
              opts({ parse_mode: 'Markdown' })
            );
          } catch (e) {
            console.error('[MAX RESULTS ERROR]', e.message);
            return bot.sendMessage(chatId, `❌ Erro: ${e.message}`, opts());
          }
        }
        return;
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
        
        const value = text.trim();
        if (!value || value.length < 2) return bot.sendMessage(chatId, `❌ Valor inválido.`, opts());
        
        // Consulta SERPRO Radar (placa / cnh)
        if (pendingConsultaKey === 'placa' || pendingConsultaKey === 'cnh') {
          bot.sendChatAction(chatId, 'typing', opts()).catch(() => {});
          try {
            const dados = pendingConsultaKey === 'placa'
              ? await consultarPlaca(value)
              : await consultarCpf(value);
            if (dados.error) {
              return bot.sendMessage(chatId, `❌ ${dados.error}`, opts());
            }
            let msg;
            if (pendingConsultaKey === 'placa') {
              msg = `🚗 *PLACA*\n\n`;
              msg += `🔢 *Placa:* ${dados.placa || '---'}\n`;
              msg += `🔩 *Chassi:* ${dados.chassi || '---'}\n`;
              msg += `📋 *Renavam:* ${dados.codigoRenavam || '---'}\n`;
              msg += `🚘 *Marca/Modelo:* ${dados.descricaoMarcaModelo || '---'}\n`;
              if (dados.descricaoCor) msg += `🎨 *Cor:* ${dados.descricaoCor}\n`;
              if (dados.anoModelo) msg += `📅 *Ano Modelo:* ${dados.anoModelo}\n`;
              if (dados.anoFabricacao) msg += `🏭 *Ano Fab:* ${dados.anoFabricacao}\n`;
              if (dados.descricaoCombustivel) msg += `⛽ *Combustível:* ${dados.descricaoCombustivel}\n`;
              if (dados.descricaoTipoVeiculo) msg += `🚙 *Tipo:* ${dados.descricaoTipoVeiculo}\n`;
              if (dados.descricaoEspecieVeiculo) msg += `📌 *Espécie:* ${dados.descricaoEspecieVeiculo}\n`;
              if (dados.descricaoCategoria) msg += `🏷️ *Categoria:* ${dados.descricaoCategoria}\n`;
              if (dados.situacao) msg += `✅ *Situação:* ${dados.situacao}\n`;
              if (dados.descricaoMunicipioEmplacamento) msg += `📍 *Município:* ${dados.descricaoMunicipioEmplacamento}/${dados.ufJurisdicao || ''}\n`;
              if (dados.nomeProprietario) msg += `👤 *Proprietário:* ${dados.nomeProprietario} (${dados.numeroIdentificacaoProprietario || '---'})\n`;
              if (dados.descricaoTipoProprietario) msg += `👥 *Tipo:* ${dados.descricaoTipoProprietario}\n`;
              if (dados.lotacao) msg += `👥 *Lotação:* ${dados.lotacao} passageiros\n`;
              if (dados.potencia) msg += `⚡ *Potência:* ${dados.potencia} CV\n`;
              if (dados.procedencia) msg += `🌍 *Procedência:* ${dados.procedencia}\n`;
              if (dados.dataEmissaoCrv) msg += `📄 *Emissão CRV:* ${dados.dataEmissaoCrv}\n`;
              if (dados.indicadorRouboFurto) msg += `🚨 *Roubo/Furto:* ${dados.indicadorRouboFurto}\n`;
              if (dados.indicadorLeilao) msg += `🔨 *Leilão:* ${dados.indicadorLeilao}\n`;
            } else {
              msg = `👤 *CNH/CPF*\n\n`;
              msg += `👤 *Nome:* ${dados.nome || '---'}\n`;
              msg += `📋 *CPF:* ${dados.cpf || '---'}\n`;
              if (dados.dataNascimento) msg += `🎂 *Nasc:* ${dados.dataNascimento}\n`;
              if (dados.descricaoSexo) msg += `⚤ *Sexo:* ${dados.descricaoSexo}\n`;
              if (dados.nomeMae) msg += `👩 *Mãe:* ${dados.nomeMae}\n`;
              if (dados.nomePai) msg += `👨 *Pai:* ${dados.nomePai}\n`;
              if (dados.numeroDocumento) msg += `🆔 *RG:* ${dados.numeroDocumento} ${dados.orgaoExpedidorDocumento ? `(${dados.orgaoExpedidorDocumento}/${dados.ufExpedidorDocumento})` : ''}\n`;
              msg += `\n📌 *Endereço:*\n`;
              msg += `${dados.enderecoLogradouro || ''}, ${dados.enderecoNumero || ''}${dados.enderecoComplemento ? ' - '+dados.enderecoComplemento : ''}\n`;
              msg += `${dados.enderecoBairro ? dados.enderecoBairro+', ' : ''}${dados.descricaoEnderecoMunicipio || ''}/${dados.enderecoUf || ''}\n`;
              msg += `CEP: ${dados.enderecoCep || '---'}\n`;
              msg += `\n🚗 *CNH:*\n`;
              if (dados.numeroRegistro) msg += `🔢 *Registro:* ${dados.numeroRegistro}\n`;
              if (dados.categoriaAtual) msg += `📋 *Categoria:* ${dados.categoriaAtual}\n`;
              if (dados.descricaoSituacaoCnh) msg += `✅ *Situação:* ${dados.descricaoSituacaoCnh}\n`;
              if (dados.dataValidadeCnh) msg += `📅 *Validade:* ${dados.dataValidadeCnh}\n`;
              if (dados.dataPrimeiraHabilitacao) msg += `🕐 *1ª Habilitação:* ${dados.dataPrimeiraHabilitacao} (${dados.ufPrimeiraHabilitacao || ''})\n`;
            }
            msg += `\n@controletotal`;
            return bot.sendMessage(chatId, msg, opts({
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: [[{ text: '🔍 NOVA BUSCA', callback_data: 'fazer_outra', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] }
            }));
          } catch (e) {
            console.error(`Erro SERPRO ${pendingConsultaKey}:`, e.message);
            return bot.sendMessage(chatId, `❌ Erro: ${e.message}`, opts());
          }
        }
        
        // Tratamento original para outras consultas
        const api = CONSULTA_APIS[pendingConsultaKey];
        if (!api) return bot.sendMessage(chatId, `❌ API inválida.`, opts());
        
        // Consulta SIPNI direta (sem Express)
        if (SIPNI_CONSULTAS[pendingConsultaKey]) {
          const sipniQuery = SIPNI_CONSULTAS[pendingConsultaKey];
          bot.sendChatAction(chatId, 'typing', opts()).catch(() => {});
          
          try {
            const dados = await querySIPNI(sipniQuery.endpoint, { [sipniQuery.param]: value });
            
            if (dados.error) {
              return bot.sendMessage(chatId, `❌ ${dados.error}`, opts());
            }
            
            let msg = ``;
            if (dados.nome) msg += `👤 *Nome:* ${dados.nome}\n`;
            if (dados.cpf) msg += `🔢 *CPF:* \`${dados.cpf}\`\n`;
            if (dados.sexo) msg += `⚤ *Sexo:* ${dados.sexo}\n`;
            if (dados.dataNascimento) msg += `🎂 *Nasc:* ${dados.dataNascimento}\n`;
            if (dados.nomeMae) msg += `👩 *Mãe:* ${dados.nomeMae}\n`;
            if (dados.nomePai) msg += `👨 *Pai:* ${dados.nomePai}\n`;
            if (dados.nacionalidade) msg += `🌍 *Nacionalidade:* ${dados.nacionalidade}\n`;
            if (dados.rg) msg += `🆔 *RG:* ${dados.rg}${dados.orgaoEmissor ? ` (${dados.orgaoEmissor}${dados.ufEmissao ? '/'+dados.ufEmissao : ''})` : ''}\n`;
            if (dados.tituloEleitor) msg += `🗳️ *Título:* ${dados.tituloEleitor}\n`;
            if (dados.estCivil) msg += `💍 *EstCivil:* ${dados.estCivil}\n`;
            if (dados.renda) msg += `💰 *Renda:* R$ ${dados.renda}\n`;
            if (dados.faixaRenda) msg += `📊 *Faixa Renda:* ${dados.faixaRenda}\n`;
            if (dados.cbo) msg += `💼 *CBO:* ${dados.cbo}\n`;
            if (dados.situacao) msg += `✅ *Situação:* ${dados.situacao}\n`;
            if (dados.situacaoCadastro) msg += `📋 *Sit Cad:* ${dados.situacaoCadastro}\n`;
            if (dados.dataSituacaoCad) msg += `📅 *Dt Sit Cad:* ${dados.dataSituacaoCad}\n`;
            if (dados.obito) msg += `💀 *Óbito:* ${dados.obito.data || 'Sim'}\n`;
            
            if (Array.isArray(dados.telefones) && dados.telefones.length > 0) {
              msg += `📞 *Telefones:*\n`;
              dados.telefones.slice(0, 10).forEach(t => {
                if (typeof t === 'string') {
                  msg += `${t.replace(/[\s()]/g, '')}\n`;
                } else {
                  const ddd = t.DDD || '';
                  const num = t.TELEFONE || t.telefone || t.numero || '';
                  msg += `${ddd}${num}\n`;
                }
              });
              if (dados.telefones.length > 10) msg += `   _+${dados.telefones.length-10} telefones_\n`;
            }
            if (Array.isArray(dados.emails) && dados.emails.length > 0) {
              msg += `✉️ *Emails:*\n`;
              dados.emails.slice(0, 5).forEach(e => {
                msg += `${e.EMAIL || e.email || e}\n`;
              });
              if (dados.emails.length > 5) msg += `   _+${dados.emails.length-5} emails_\n`;
            }
            if (Array.isArray(dados.enderecos) && dados.enderecos.length > 0) {
              msg += `📍 *Endereços:*\n`;
              dados.enderecos.slice(0, 5).forEach(addr => {
                if (!addr) return;
                let addrStr = `${addr.LOGR_NOME || addr.logradouro || ''}, ${addr.LOGR_NUMERO || addr.numero || ''}`;
                if (addr.BAIRRO || addr.bairro) addrStr += ` - ${addr.BAIRRO || addr.bairro}`;
                if (addr.CIDADE || addr.cidade) addrStr += `, ${addr.CIDADE || addr.cidade}`;
                if (addr.UF || addr.uf) addrStr += `/${addr.UF || addr.uf}`;
                if (addr.CEP || addr.cep) addrStr += ` (${addr.CEP || addr.cep})`;
                msg += `${addrStr}\n`;
              });
              if (dados.enderecos.length > 5) msg += `   _+${dados.enderecos.length-5} endereços_\n`;
            }
            if (Array.isArray(dados.score) && dados.score.length > 0) {
              const s = dados.score[0];
              if (s.CSB8) msg += `📊 *Score:* ${s.CSB8} (${s.CSB8_FAIXA})\n`;
              if (s.CSB8_PONTOS) msg += `📊 *Score Pontos:* ${s.CSB8_PONTOS}\n`;
            }
            if (Array.isArray(dados.pis) && dados.pis.length > 0) {
              const p = dados.pis[0];
              msg += `🔢 *PIS:* ${p.PIS || p.pis || JSON.stringify(p)}\n`;
            }
            if (Array.isArray(dados.tse) && dados.tse.length > 0) {
              const t = dados.tse[0];
              msg += `🗳️ *TSE:* ${t.TSE || t.tse || JSON.stringify(t)}\n`;
            }
            if (Array.isArray(dados.poderAquisitivo) && dados.poderAquisitivo.length > 0) {
              const pa = dados.poderAquisitivo[0];
              msg += `💰 *Poder Aquisitivo:* ${pa.PODERAQUISITIVO || ''} | Renda: R$ ${pa.RENDAPODERAQUISITIVO || ''} | Faixa: ${pa.FXPODERAQUISITIVO || ''}\n`;
            }
            if (dados.parentes) {
              const parentesArr = Array.isArray(dados.parentes) ? dados.parentes : (dados.parentes.NOME ? [dados.parentes] : []);
              if (parentesArr.length > 0) {
                const parentes = parentesArr.slice(0, 3).map(p => p.NOME || p.nome || JSON.stringify(p)).join(', ');
                msg += `👪 *Parentes:* ${parentes}${parentesArr.length > 3 ? ` (+${parentesArr.length-3})` : ''}\n`;
              }
            }
            if (dados.info_telefone) {
              const t = dados.info_telefone;
              msg += `📞 *Info Telefone:* ${t.OPERADORA || t.operadora || ''} ${t.TIPO_LINHA || t.tipo_linha || ''} ${t.UF || t.uf || ''}\n`;
            }
            
            if (!msg.trim()) {
              msg = `_Dados encontrados, mas sem campos formatáveis._\n\`\`\`json\n${JSON.stringify(dados).substring(0, 500)}\n\`\`\``;
            }
            
            msg += `\n@controletotal`;
            
            // Replace single \n with \n\n to add blank lines between fields
            msg = msg.replace(/\n(?!\n)/g, '\n\n');
            
            return bot.sendMessage(chatId, msg, opts({
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔍 NOVA BUSCA', callback_data: 'fazer_outra', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]
                ]
              }
            }));
          } catch (e) {
            console.error(`Erro ao consultar SIPNI ${pendingConsultaKey}:`, e.message);
            return bot.sendMessage(chatId, `❌ Erro: ${e.message}`, opts());
          }
        }
        
        // Tratamento para APIs locais
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

      // Fluxo de LOGIN (email+senha)
      if (pendingLogin.has(chatId)) {
        const state = pendingLogin.get(chatId);
        if (!state.email) {
          const email = text.trim().toLowerCase();
          if (!email.includes('@') || !email.includes('.')) {
            return bot.sendMessage(chatId, `❌ *Email inválido!*\n\nDigite um email válido:\n_Exemplo: \`usuario@email.com\`_`, opts({ parse_mode: 'Markdown' }));
          }
          state.email = email;
          return bot.sendMessage(chatId,
            `📧 Email recebido: \`${email}\`\n\nAgora digite sua *senha*:\n\nOu /cancelar para voltar.`,
            opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 CANCELAR', callback_data: 'cancel_search', style: 'primary' }]] } })
          );
        } else {
          pendingLogin.delete(chatId);
          const password = text.trim();
          if (password.length < 3) {
            return bot.sendMessage(chatId, `❌ Senha muito curta. Use /login novamente ou /cancelar.`, opts());
          }
          try {
            const hashed = crypto.createHash('sha256').update(password).digest('hex');
            const res = await _writePool.query(
              `SELECT id, email FROM users WHERE LOWER(email) = $1 AND password = $2 LIMIT 1`,
              [state.email.toLowerCase(), hashed]
            );
            if (res.rows.length === 0) {
              return bot.sendMessage(chatId,
                `❌ *Email ou senha incorretos!*\n\nVerifique suas credenciais e tente novamente.\n\nUse /login para tentar novamente.`,
                opts({ parse_mode: 'Markdown' })
              );
            }
            // Login bem-sucedido — verifica se já tem sessão
            const existingSess = await _writePool.query(
              `SELECT id, plan FROM user_sessions WHERE telegram_id = $1 ORDER BY CASE WHEN plan = 'FREE' THEN 1 ELSE 0 END, id DESC LIMIT 1`, [chatId]
            );
            if (existingSess.rows.length > 0) {
              return bot.sendMessage(chatId,
                `✅ *Login realizado!*\n\nBem-vindo de volta. Use /start para acessar o menu.`,
                opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🏠 IR AO MENU', callback_data: 'cmd_menu', style: 'primary' }]] } })
              );
            }

            // Verifica se já tem key ativa em license_keys (pré-sessões)
            const oldKey = await _writePool.query(
              `SELECT key, duration_seconds, expires_at FROM license_keys WHERE telegram_id = $1 AND activated_at IS NOT NULL LIMIT 1`,
              [chatId]
            );
            if (oldKey.rows.length > 0) {
              const r = oldKey.rows[0];
              if (!r.expires_at || new Date(r.expires_at) > new Date()) {
                const durSec = r.duration_seconds;
                let plan = 'POWER';
                if (durSec && durSec > 0) {
                  const days = durSec / 86400;
                  plan = days <= 30 ? 'STARTER' : 'PRO';
                }
                if (durSec && durSec > 0) {
                  await _writePool.query(
                    `INSERT INTO user_sessions (telegram_id, key, plan, expires_at) VALUES ($1, $2, $3, $4)`,
                    [chatId, r.key, plan, r.expires_at]
                  ).catch(() => {});
                } else {
                  await _writePool.query(
                    `INSERT INTO user_sessions (telegram_id, key, plan) VALUES ($1, $2, $3)`,
                    [chatId, r.key, plan]
                  ).catch(() => {});
                }
                clearCachedAccess(chatId);
                return bot.sendMessage(chatId,
                  `✅ *Login realizado!*\n\nSua key antiga foi migrada para a nova sessão.\n\n👤 Plano: *${plan}*\n\nUse /start para acessar o menu.`,
                  opts({
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '🏠 IR AO MENU', callback_data: 'cmd_menu', style: 'primary' }]] }
                  })
                );
              }
            }

            // Cria sessão FREE (sem key)
            await _writePool.query(
              `INSERT INTO user_sessions (telegram_id, key, plan) VALUES ($1, $2, $3)`,
              [chatId, `user_${res.rows[0].id}_${Date.now()}`, 'FREE']
            ).catch(() => {});
            clearCachedAccess(chatId);
            return bot.sendMessage(chatId,
              `✅ *Login realizado com sucesso!*\n\n👤 Email: \`${state.email}\`\n📋 Plano: FREE\n📊 Limite: 100 resultados\n\nUse /start para acessar o menu ou entre em contato para adquirir um plano premium.`,
              opts({
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '🏠 IR AO MENU', callback_data: 'cmd_menu', style: 'primary' }],
                    [{ text: '💎 VER PLANOS', callback_data: 'show_plans', style: 'primary' }]
                  ]
                }
              })
            );
          } catch (e) {
            return bot.sendMessage(chatId, `❌ Erro interno: ${e.message}`, opts());
          }
        }
      }

      // Fluxo de CADASTRO (email+senha)
      if (pendingRegister.has(chatId)) {
        const state = pendingRegister.get(chatId);
        if (!state.email) {
          const email = text.trim().toLowerCase();
          if (!email.includes('@') || !email.includes('.')) {
            return bot.sendMessage(chatId, `❌ *Email inválido!*\n\nDigite um email válido:\n_Exemplo: \`usuario@email.com\`_`, opts({ parse_mode: 'Markdown' }));
          }
          try {
            const existing = await _writePool.query(`SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1`, [email]);
            if (existing.rows.length > 0) {
              return bot.sendMessage(chatId,
                `❌ *Email já cadastrado!*\n\nEste email já possui uma conta.\nUse /login para acessar ou digite outro email.`,
                opts({ parse_mode: 'Markdown' })
              );
            }
          } catch (e) {
            return bot.sendMessage(chatId, `❌ Erro ao verificar email: ${e.message}`, opts());
          }
          state.email = email;
          return bot.sendMessage(chatId,
            `📧 Email recebido: \`${email}\`\n\nAgora crie uma *senha* (mínimo 6 caracteres):\n\nOu /cancelar para voltar.`,
            opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 CANCELAR', callback_data: 'cancel_search', style: 'primary' }]] } })
          );
        } else {
          pendingRegister.delete(chatId);
          const password = text.trim();
          if (password.length < 6) {
            return bot.sendMessage(chatId, `❌ Senha muito curta (mínimo 6 caracteres). Digite novamente:\n\nOu /cancelar para voltar.`, opts());
          }
          try {
            const hashed = crypto.createHash('sha256').update(password).digest('hex');
            const res = await _writePool.query(
              `INSERT INTO users (email, password, telegram_id) VALUES ($1, $2, $3) RETURNING id`,
              [state.email.toLowerCase(), hashed, chatId]
            );
            // Cria sessão
            await _writePool.query(
              `INSERT INTO user_sessions (telegram_id, key, plan) VALUES ($1, $2, $3)`,
              [chatId, `user_${res.rows[0].id}_${Date.now()}`, 'FREE']
            ).catch(() => {});
            clearCachedAccess(chatId);
            return bot.sendMessage(chatId,
              `✅ *Cadastro realizado com sucesso!*\n\n👤 Email: \`${state.email}\`\n📋 Plano: FREE\n📊 Limite: 100 resultados\n\nUse /start para acessar o menu ou entre em contato para adquirir um plano premium.`,
              opts({
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '🏠 IR AO MENU', callback_data: 'cmd_menu', style: 'primary' }],
                    [{ text: '💎 VER PLANOS', callback_data: 'show_plans', style: 'primary' }]
                  ]
                }
              })
            );
          } catch (e) {
            return bot.sendMessage(chatId, `❌ Erro ao cadastrar: ${e.message}`, opts());
          }
        }
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
      // ── FERRAMENTAS: handlers ──
      const toolRunners = {
        whois_query: async (v) => { await sendWhoisResults(chatId, v, threadId); },
        geoip_query: async (v) => { await sendGeoIpResults(chatId, v, threadId); },
        whatsapp_check: async (v) => {
          const data = await checkWhatsApp(v);
          bot.sendMessage(chatId, formatWhatsApp(data), opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🛠️ FERRAMENTAS', callback_data: 'tool_buscas', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } })).catch(() => {});
        },
        linkscan_check: async (v) => {
          const data = await scanLink(v);
          bot.sendMessage(chatId, formatLink(data), opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🛠️ FERRAMENTAS', callback_data: 'tool_buscas', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } })).catch(() => {});
          if (data && data.url) {
            try {
              const hostname = new URL(data.url).hostname;
              const ips = await dns.resolve4(hostname);
              const targetIp = ips?.[0];
              if (targetIp) {
                const ipData = await lookupShodan(targetIp);
                const formatted = formatShodanResult(ipData);
                if (formatted) {
                  await bot.sendMessage(chatId, `🔍 *${targetIp}*\n${formatted}`, opts({ parse_mode: 'Markdown' })).catch(() => {});
                }
              }
            } catch {}
          }
        },
        revimg_check: async (v) => {
          const data = await reverseImage(v);
          bot.sendMessage(chatId, formatReverseImage(data), opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🛠️ FERRAMENTAS', callback_data: 'tool_buscas', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } })).catch(() => {});
        },
        pixkey_check: async (v) => {
          try {
            console.log(`[PIXKEY] checkPixKey("${v}")`);
            const data = checkPixKey(v);
            console.log(`[PIXKEY] result:`, data);
            const msg = formatPixKey(data);
            console.log(`[PIXKEY] sending to ${chatId}: ${msg}`);
            await bot.sendMessage(chatId, msg, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🛠️ FERRAMENTAS', callback_data: 'tool_buscas', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } }));
            console.log(`[PIXKEY] sent OK`);
          } catch (e) {
            console.error(`[PIXKEY] ERROR:`, e);
            bot.sendMessage(chatId, `❌ Erro: ${e.message}`, opts()).catch(() => {});
          }
        },
        username_check: async (v) => {
          bot.sendMessage(chatId, `👤 *Buscando username...*`, opts({ parse_mode: 'Markdown' })).catch(() => {});
          const data = await usernameScan(v);
          bot.sendMessage(chatId, formatUsername(data), opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🛠️ FERRAMENTAS', callback_data: 'tool_buscas', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } })).catch(() => {});
        },
        checkpass_check: async (v) => {
          bot.sendMessage(chatId, `🔐 *Verificando senha...*`, opts({ parse_mode: 'Markdown' })).catch(() => {});
          const data = await checkPassword(v);
          bot.sendMessage(chatId, formatPassword(data), opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🛠️ FERRAMENTAS', callback_data: 'tool_buscas', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } })).catch(() => {});
        },
        endereco_check: async (v) => {
          const data = await searchAddress(v);
          bot.sendMessage(chatId, formatAddress(data), opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🛠️ FERRAMENTAS', callback_data: 'tool_buscas', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } })).catch(() => {});
        },
        bin_check: async (v) => {
          const data = await checkBin(v);
          bot.sendMessage(chatId, formatBin(data, v.replace(/\D/g, '').substring(0, 6)), opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🛠️ FERRAMENTAS', callback_data: 'tool_buscas', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] } })).catch(() => {});
        }
      };
      if (toolRunners[pendingField]) {
        pendingSearch.delete(userKey);
        pendingSearch.delete(chatId);
        await toolRunners[pendingField](searchValue).catch(e => console.error(`[TOOLRUNNER] ${pendingField} error:`, e));
        return;
      }

      // Verifica se está aguardando valor para monitoramento (antes do fallback genérico)
      const monitoringState = monitoringStates.get(chatId);
      if (monitoringState) {
        const monitorValue = text.trim();
        if (monitorValue.length < 1) {
          bot.sendMessage(chatId, `❌ Valor inválido. Por favor, digite um valor válido.`, opts());
          return;
        }
        monitoringStates.delete(chatId);
        const type = monitoringState.type;
        if (type === 'email') {
          await bot.sendMessage(chatId, `📧 *Verificando email...*\n\n⏳ Consultando bases de dados...`, opts({ parse_mode: 'Markdown' }));
          try {
            const data = await searchByEmail(monitorValue);
            await addMonitoredItem(chatId, 'email', monitorValue);
            if (!data || !data.stealers || data.stealers.length === 0) {
              return bot.sendMessage(chatId, `✅ *Email não encontrado em breaches*\n\nO email \`${monitorValue}\` aparentemente está seguro.\n\n🔔 *Monitoramento ativado!* Você será notificado se aparecer em novos vazamentos.`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔔 MONITORAR OUTRO', callback_data: 'monitor_menu' }], [{ text: '📋 MEUS MONITORADOS', callback_data: 'list_monitored' }], [{ text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu' }]] } }));
            }
            let totalDevices = data.stealers.length;
            let totalCorporate = data.total_corporate_services || 0;
            let totalUser = data.total_user_services || 0;
            let msg = `⚠️ *Informações encontradas para:* \`${monitorValue}\`\n\n`;
            msg += `📱 *Dispositivos infectados:* ${totalDevices}\n`;
            msg += `🏢 *Serviços corporativos:* ${totalCorporate}\n`;
            msg += `👤 *Serviços de usuário:* ${totalUser}\n\n`;
            const recent = data.stealers.slice(0, 3);
            recent.forEach((s, i) => {
              const compDate = s.date_compromised ? new Date(s.date_compromised).toLocaleDateString('pt-BR') : 'N/A';
              msg += `*Dispositivo ${i + 1}:* ${s.computer_name || 'N/A'}\n`;
              msg += `  🖥 OS: ${s.operating_system || 'N/A'}\n`;
              msg += `  🌐 IP: ${s.ip || 'N/A'}\n`;
              msg += `  📅 Data: ${compDate}\n`;
              if (s.top_logins && s.top_logins.length > 0) {
                msg += `  🔑 Logins: ${s.top_logins.slice(0, 3).join(', ')}\n`;
              }
              msg += `\n`;
            });
            if (data.stealers.length > 3) {
              msg += `... e mais ${data.stealers.length - 3} dispositivo(s)\n\n`;
            }
            await addMonitoredItem(chatId, 'email', monitorValue);
            return bot.sendMessage(chatId, msg + `\n🔔 *Monitoramento ativado!* Você será notificado se aparecer em novos vazamentos.`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔔 MONITORAR OUTRO', callback_data: 'monitor_menu' }], [{ text: '📋 MEUS MONITORADOS', callback_data: 'list_monitored' }], [{ text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu' }]] } }));
          } catch (e) {
            return bot.sendMessage(chatId, `❌ Erro ao verificar: ${e.message}`, opts({ reply_markup: { inline_keyboard: [[{ text: '🔔 TENTAR NOVAMENTE', callback_data: 'monitor_menu' }], [{ text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu' }]] } }));
          }
        }
        if (type === 'username') {
          await bot.sendMessage(chatId, `👤 *Verificando username...*\n\n⏳ Consultando bases de dados...`, opts({ parse_mode: 'Markdown' }));
          try {
            const data = await searchByUsername(monitorValue);
            await addMonitoredItem(chatId, 'username', monitorValue);
            if (!data || !data.stealers || data.stealers.length === 0) {
              return bot.sendMessage(chatId, `✅ *Username não encontrado em breaches*\n\nO username \`${monitorValue}\` aparentemente está seguro.\n\n🔔 *Monitoramento ativado!* Você será notificado se aparecer em novos vazamentos.`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔔 MONITORAR OUTRO', callback_data: 'monitor_menu' }], [{ text: '📋 MEUS MONITORADOS', callback_data: 'list_monitored' }], [{ text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu' }]] } }));
            }
            let totalDevices = data.stealers.length;
            let msg = `⚠️ *Informações encontradas para:* \`${monitorValue}\`\n\n`;
            msg += `📱 *Dispositivos infectados:* ${totalDevices}\n\n`;
            const recent = data.stealers.slice(0, 3);
            recent.forEach((s, i) => {
              const compDate = s.date_compromised ? new Date(s.date_compromised).toLocaleDateString('pt-BR') : 'N/A';
              msg += `*Dispositivo ${i + 1}:* ${s.computer_name || 'N/A'}\n`;
              msg += `  🖥 OS: ${s.operating_system || 'N/A'}\n`;
              msg += `  🌐 IP: ${s.ip || 'N/A'}\n`;
              msg += `  📅 Data: ${compDate}\n`;
              if (s.top_logins && s.top_logins.length > 0) {
                msg += `  🔑 Logins: ${s.top_logins.slice(0, 3).join(', ')}\n`;
              }
              msg += `\n`;
            });
            if (data.stealers.length > 3) {
              msg += `... e mais ${data.stealers.length - 3} dispositivo(s)\n\n`;
            }
            await addMonitoredItem(chatId, 'username', monitorValue);
            return bot.sendMessage(chatId, msg + `\n🔔 *Monitoramento ativado!* Você será notificado se aparecer em novos vazamentos.`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔔 MONITORAR OUTRO', callback_data: 'monitor_menu' }], [{ text: '📋 MEUS MONITORADOS', callback_data: 'list_monitored' }], [{ text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu' }]] } }));
          } catch (e) {
            return bot.sendMessage(chatId, `❌ Erro ao verificar: ${e.message}`, opts({ reply_markup: { inline_keyboard: [[{ text: '🔔 TENTAR NOVAMENTE', callback_data: 'monitor_menu' }], [{ text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu' }]] } }));
          }
        }
        
        return bot.sendMessage(chatId, `❌ Tipo de monitoramento inválido.`, opts());
      }

      const fieldRoutes = {
          url: () => {
            const queryId = Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
            queryStore.set(queryId, { query: searchValue, field: 'url', threadId });
            if (queryStore.size > 1000) { const firstKey = queryStore.keys().next().value; queryStore.delete(firstKey); }
            return bot.sendMessage(chatId, `🔍 *Busca INURL:* \`${searchValue}\`\n\nEscolha o formato:`, opts({
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: [[{ text: '📋 USER:PASS (PREMIUM)', callback_data: `chk_${queryId}` }, { text: '📋 URL:USER:PASS (PREMIUM)', callback_data: `chk2_${queryId}` }, { text: '📄 FULL', callback_data: `full_${queryId}` }, { text: '🌐 SUBDOMÍNIOS', callback_data: `sub_${queryId}` }], [{ text: '📊 JSON', callback_data: `json_${queryId}` }, { text: '📊 CSV', callback_data: `csv_${queryId}` }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] }
            }));
          },
          email: () => sendResults(chatId, 'email', searchValue, pool, threadId, 'full', username),
          inurl: () => sendInurlResults(chatId, searchValue, pool, threadId),
          inmail: () => sendResults(chatId, 'email', `%${searchValue}%`, pool, threadId, 'full', username),
          user: () => sendUserResults(chatId, searchValue, pool, threadId),
          senha: () => sendResults(chatId, 'SENHA', searchValue, pool, threadId, 'full', username),
          telefone: () => sendResults(chatId, 'TELEFONE', searchValue, pool, threadId, 'full', username),
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
    const msg = lines.join('\n') + '\n\n@controletotal';
    if (msg.length > 4000) return bot.sendMessage(chatId, msg.substring(0, 3950) + '\n\n_...truncado_\n\n@controletotal', optsFn({ parse_mode: 'Markdown', reply_markup: novaBtn }));
    return bot.sendMessage(chatId, msg, optsFn({ parse_mode: 'Markdown', reply_markup: novaBtn }));
  }

  // ── Menu de Consultas Externas ──
  async function showConsultaMenu(chatId, threadId) {
    const opts2 = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;
    return bot.sendMessage(chatId,
      `🔎 CONSULTAS AVANCADAS\n\nSelecione o tipo de consulta:`,
      opts2({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '🔢 CPF',     callback_data: 'consultar_cpf',     style: 'primary' }, { text: '👤 Nome', callback_data: 'consultar_nome', style: 'primary' }],
        [{ text: '👩 Nome da Mãe', callback_data: 'consultar_mae', style: 'primary' }, { text: '👨 Nome do Pai', callback_data: 'consultar_pai', style: 'primary' }],
        [{ text: '🆔 RG',  callback_data: 'consultar_rg',  style: 'primary' }, { text: '📞 Telefone', callback_data: 'consultar_tel', style: 'primary' }],
        [{ text: '✅ Situação CPF', callback_data: 'consultar_sit_cpf', style: 'primary' }, { text: '🗳️ Título Eleitor', callback_data: 'consultar_titulo', style: 'primary' }],
        [{ text: '🚗 Placa', callback_data: 'consultar_placa', style: 'primary' }, { text: '🆔 CNH/CPF', callback_data: 'consultar_cnh', style: 'primary' }],
        [{ text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]
      ]}})
    );
  }

  bot.on('callback_query', async (callbackQuery) => {
    // Answer immediately so Telegram removes the loading state
    bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
    
    const data = callbackQuery.data;
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const threadId = msg.message_thread_id;
    const userId = callbackQuery.from.id;
    const userKey = `${chatId}_${userId}`;
    const opts = (o = {}) => threadId ? { message_thread_id: threadId, ...o } : o;
    const cbIsGroup = msg.chat && (msg.chat.type === 'group' || msg.chat.type === 'supergroup');
    const cbUsername = callbackQuery.from.username ? `@${callbackQuery.from.username}` : (callbackQuery.from.first_name || 'Anon');

    // ── MODO GRUPO: todos do grupo podem usar ──
    if (cbIsGroup) {
      groupChats.add(chatId);
    }

    if (data.startsWith('chk_') || data.startsWith('chk2_') || data.startsWith('full_') || data.startsWith('json_') || data.startsWith('csv_')) {
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
          return bot.sendMessage(chatId, '⚠️ Exportar nos formatos USER:PASS e URL:USER:PASS é exclusivo para usuários *Premium*!', opts({ parse_mode: 'Markdown' }));
        }
      }

      return sendResults(chatId, stored.field, stored.query, pool, stored.threadId, format, cbUsername);
    }

    // Botão VOLTAR AO MENU PRINCIPAL
    if (data === 'cmd_menu') {
      bot.editMessageText('💀 *ASSEMBLY LOGS*\n\n🟢 *MENU PRINCIPAL*\n\n📌 *Navegue usando os botões abaixo:*', {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🛠️ FERRAMENTAS', callback_data: 'tool_buscas', style: 'primary' }],
            [{ text: '🚀 PUXAR LOGINS', callback_data: 'puxar_logins', style: 'primary' }],
            [{ text: '📊 PUXAR DADOS', callback_data: 'puxar_dados', style: 'primary' }],
            [{ text: '👤 MINHA CONTA', callback_data: 'cmd_conta', style: 'primary' }],
            [{ text: '🎧 SUPORTE', callback_data: 'support_menu', style: 'primary' }],
            [{ text: '🔔 MONITORAR', callback_data: 'monitor_menu', style: 'primary' }],
            [{ text: '💎 PLANOS', callback_data: 'show_plans', style: 'primary' }],
            [{ text: '⚙️ CONFIGURAÇÕES', callback_data: 'config_menu', style: 'primary' }, { text: '🌐 IDIOMA', callback_data: 'language_menu', style: 'primary' }],
            [{ text: '📚 REFERÊNCIAS', url: 'https://t.me/+9oaCkNF_klpmMzUx', style: 'primary' }, { text: '🚪 LOGOUT', callback_data: 'logout', style: 'primary' }]
          ]
        }
      }).catch(() => {});
      return;
    }

    // Botão MONITORAR — Monitoramento em tempo real
    if (data === 'monitor_menu') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      return bot.sendMessage(chatId,
        `🔔 *MONITORAMENTO EM TEMPO REAL*\n\n` +
        `Escolha o que deseja consultar:\n\n` +
        `📧 *EMAIL* - Verificar vazamentos\n` +
        `👤 *USERNAME* - Verificar vazamentos`,
        opts({
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📧 MONITORAR EMAIL', callback_data: 'mon_email', style: 'primary' }],
              [{ text: '👤 MONITORAR USERNAME', callback_data: 'mon_username', style: 'primary' }],
              [{ text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]
            ]
          }
        })
      );
    }

    // Handler para monitorar EMAIL
    if (data === 'mon_email') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      monitoringStates.set(chatId, { type: 'email' });
      return bot.sendMessage(chatId,
        `📧 *MONITORAR EMAIL*\n\n` +
        `Digite o email que deseja verificar:`,
        opts({ parse_mode: 'Markdown' })
      );
    }

    // Handler para monitorar USERNAME
    if (data === 'mon_username') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      monitoringStates.set(chatId, { type: 'username' });
      return bot.sendMessage(chatId,
        `👤 *MONITORAR USERNAME*\n\n` +
        `Digite o username que deseja verificar:`,
        opts({ parse_mode: 'Markdown' })
      );
    }

    // Handler para listar monitorados
    if (data === 'list_monitored') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      const items = await listMonitoredItems(chatId);
      if (items.length === 0) {
        return bot.sendMessage(chatId, `📋 *Nenhum item monitorado.*\n\nUse o menu MONITORAR para adicionar.`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔔 MONITORAR', callback_data: 'monitor_menu', style: 'primary' }], [{ text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }]] } }));
      }
      const keyboard = items.map(item => [{
        text: `${item.type === 'email' ? '📧' : '👤'} ${item.value}`,
        callback_data: `remove_mon_${item.type}_${Buffer.from(item.value).toString('base64')}`,
        style: 'primary'
      }]);
      keyboard.push([{ text: '🔔 MONITORAR NOVO', callback_data: 'monitor_menu', style: 'primary' }, { text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }]);
      return bot.sendMessage(chatId, `📋 *ITENS MONITORADOS*\n\nToque para remover:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }));
    }

    // Handler para remover monitorado
    if (data.startsWith('remove_mon_')) {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      const parts = data.split('_');
      const remType = parts[2];
      const remValue = Buffer.from(parts.slice(3).join('_'), 'base64').toString('utf8');
      if (remType && remValue) {
        await removeMonitoredItem(chatId, remType, remValue);
        bot.editMessageText(`✅ *Removido:* ${remValue}`, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown' }).catch(() => {});
        const items = await listMonitoredItems(chatId);
        if (items.length > 0) {
          const keyboard = items.map(item => [{
            text: `${item.type === 'email' ? '📧' : '👤'} ${item.value}`,
            callback_data: `remove_mon_${item.type}_${Buffer.from(item.value).toString('base64')}`,
            style: 'primary'
          }]);
          keyboard.push([{ text: '🔔 MONITORAR NOVO', callback_data: 'monitor_menu', style: 'primary' }, { text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }]);
          return bot.sendMessage(chatId, `📋 *ITENS MONITORADOS*\n\nToque para remover:`, opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }));
        }
      }
    }

    // Botão SUPORTE
    if (data === 'support_menu') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      return bot.sendMessage(chatId, 
        `🎧 *SUPORTE E AJUDA*\n\n` +
        `Precisando de assistência? Entre em contato diretamente com o suporte:\n\n` +
        `👨‍💻 *Suporte Técnico:* ${OWNER_PROFILE}\n\n` +
        `📝 *Como usar o bot:*\n` +
        `• Use /start para acessar o menu principal\n` +
        `• Use /login para acessar com credenciais\n` +
        `• Use /register para criar uma conta\n` +
        `• Use /key SUA-CHAVE para ativar acesso premium\n\n` +
        `⚠️ *Horário de suporte:* 24/7\n` +
        `💬 *Resposta geralmente em menos de 1 hora*`,
        opts({ 
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '💬 CONVERSAR COM SUPORTE', url: OWNER_PROFILE }],
              [{ text: '🏠 VOLTAR AO MENU', callback_data: 'cmd_menu' }]
            ]
          }
        })
      );
      return;
    }

    // Botão MINHA CONTA
    if (data === 'cmd_conta') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      return handleContaCommand(chatId, threadId);
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
              [{ text: '🟢 WhatsApp', callback_data: 'tool_whatsapp', style: 'primary' }, { text: '🔗 Link Scan', callback_data: 'tool_linkscan', style: 'primary' }],
              [{ text: '📸 Reverse Img', callback_data: 'tool_revimg', style: 'primary' }, { text: '💳 Pix Key', callback_data: 'tool_pixkey', style: 'primary' }],
              [{ text: '👤 Username', callback_data: 'tool_username', style: 'primary' }, { text: '🔐 Check Pass', callback_data: 'tool_checkpass', style: 'primary' }],
              [{ text: '🗺️ Endereço', callback_data: 'tool_endereco', style: 'primary' }, { text: '🔢 BIN Lookup', callback_data: 'tool_bincheck', style: 'primary' }],
              [{ text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]
            ]
          }
        })
      );
    }

    // ── FERRAMENTAS: callback handlers ──
    const toolHandlers = {
      srch_whois: { prompt: '🔍 *WHOIS*\n\nEnvie o domínio para consultar:', pending: 'whois_query' },
      srch_geoip: { prompt: '📍 *GEOIP*\n\nEnvie o IP para localizar:', pending: 'geoip_query' },
      tool_whatsapp: { prompt: '🟢 *WhatsApp Check*\n\nEnvie o número de telefone (com DDD):', pending: 'whatsapp_check' },
      tool_linkscan: { prompt: '🔗 *Link Scanner*\n\nEnvie a URL para analisar:', pending: 'linkscan_check' },
      tool_revimg: { prompt: '📸 *Reverse Image*\n\nEnvie a URL da imagem:', pending: 'revimg_check' },
      tool_pixkey: { prompt: '💳 *Pix Key*\n\nEnvie a chave Pix (CPF, CNPJ, email, telefone, aleatória):', pending: 'pixkey_check' },
      tool_username: { prompt: '👤 *Username Check*\n\nEnvie o username para buscar:', pending: 'username_check' },
      tool_checkpass: { prompt: '🔐 *Password Check*\n\nEnvie a senha para verificar:', pending: 'checkpass_check' },
      tool_endereco: { prompt: '🗺️ *Endereço OSINT*\n\nEnvie o CEP ou endereço para buscar:', pending: 'endereco_check' },
      tool_bincheck: { prompt: '🔢 *BIN Lookup*\n\nEnvie os 6 primeiros dígitos do cartão:', pending: 'bin_check' }
    };
    if (toolHandlers[data]) {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      const h = toolHandlers[data];
      pendingSearch.set(userKey, h.pending);
      pendingSearch.set(chatId, h.pending);
      return bot.sendMessage(chatId, h.prompt,
        opts({ parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: '🔴 CANCELAR', callback_data: 'cancel_search', style: 'primary' }]] } })
      );
    }

    // Botão COMANDOS — Lista de comandos disponíveis
    if (data === 'list_commands') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      return bot.sendMessage(chatId,
        `📜 *COMANDOS DISPONÍVEIS*\n\n` +
        `🔓 /LOGIN - Acessar com credenciais\n` +
        `🛠️ /FERRAMENTAS - Ferramentas avançadas (WHOIS, GEOIP)\n` +
        `🔍 /BUSCAS - Módulos de busca (INURL, Emails, Usuários, Telefones, Dominios, Protocolos)\n` +
        `🚀 /PUXARLOGINS - Extrair dados de login\n` +
        `📊 /PUXARDADOS - Dados avançados e consultas\n` +
        `💳 /PLANOS - Ver planos disponíveis\n` +
        `👤 /CONTA - Gerenciar sua conta\n` +
        `❓ /AJUDA - Exibir esta mensagem\n\n` +
        `💡 *Dica:* Use os botões abaixo para navegar mais rápido!`,
        opts({
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]
            ]
          }
        })
      );
    }

    // Botão PLANOS — Redireciona para o admin
    if (data === 'show_plans') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      const inGroup = groupChats.has(chatId);
      const plansMsg = inGroup
        ? `💬 *Comprar Key Premium*\n\nEntre em contato no privado para adquirir sua key.`
        : `💬 *Comprar Key Premium*\n\nEntre em contato com o admin para adquirir sua key:\n${OWNER_PROFILE}`;
      const plansMarkup = inGroup
        ? { inline_keyboard: [] }
        : { inline_keyboard: [[{ text: '👨‍💻 FALAR COM ADMIN', url: OWNER_PROFILE }]] };
      return bot.sendMessage(chatId, plansMsg, opts({ parse_mode: 'Markdown', reply_markup: plansMarkup }));
    }

    // Botão CONFIGURAÇÕES
    if (data === 'config_menu') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      
      try {
        const user = await _writePool.query('SELECT expires_at, plan FROM user_sessions WHERE telegram_id = $1 ORDER BY CASE WHEN plan = \'FREE\' THEN 1 ELSE 0 END, id DESC LIMIT 1', [chatId]);
        const userData = user.rows[0];
        const isPremium = userData && (!userData.expires_at || new Date(userData.expires_at) > new Date());
        const expiresIn = userData?.expires_at ? new Date(userData.expires_at).toLocaleDateString('pt-BR') : (userData ? 'Vitalício' : 'Não ativado');
        const plan = userData?.plan || '—';
        const maxResults = plan === 'STARTER' ? '5.000' : plan === 'PRO' ? '20.000' : plan === 'POWER' ? 'Ilimitado' : '100';
        
        const cfgEsc = (s) => s.replace(/([\(\)\.\!\-])/g, '\\$1');
        const statusText = isPremium 
          ? `✅ *Plano Ativo*\n📋 Plano: ${cfgEsc(plan)}\n📅 Expira em: ${cfgEsc(expiresIn)}\n📊 Limite: ${cfgEsc(maxResults)}`
          : `❌ *Plano Não Ativado*\n📊 Limite: ${cfgEsc(maxResults)}`;
        
        return bot.sendMessage(chatId,
          `⚙️ *CONFIGURAÇÕES*\n\n${statusText}\n\n💎 *Planos disponíveis:*\n_Consulte o admin para adquirir uma key._\n\nEscolha uma opção:`,
          opts({
            parse_mode: 'MarkdownV2',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔑 INSERIR API KEY', callback_data: 'config_api_key', style: 'primary' }],
                [{ text: '📊 MÁXIMO DE RESULTADOS', callback_data: 'config_max_results', style: 'primary' }],
                [{ text: '🏠 MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]
              ]
            }
          })
        );
      } catch (e) {
        console.error('[CONFIG ERROR]', e.message);
        return bot.sendMessage(chatId, `❌ Erro ao carregar configurações: ${e.message}`, opts());
      }
    }

    // Handler para INSERIR API KEY
    if (data === 'config_api_key') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      pendingConfig.set(chatId, 'api_key');
      
      return bot.sendMessage(chatId,
        `🔑 *INSERIR API KEY*\n\n` +
        `Digite sua chave de ativação (ou /cancelar para voltar):\n\n` +
        `_Exemplo: KEY-ABC123DEF456_`,
        opts({
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔴 CANCELAR', callback_data: 'config_menu', style: 'primary' }]
            ]
          }
        })
      );
    }

    // Handler para MÁXIMO DE RESULTADOS
    if (data === 'config_max_results') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      
      try {
        const user = await _writePool.query('SELECT expires_at FROM user_sessions WHERE telegram_id = $1 ORDER BY CASE WHEN plan = \'FREE\' THEN 1 ELSE 0 END, id DESC LIMIT 1', [chatId]);
        const row = user.rows[0];
        const isPremium = row && (!row.expires_at || new Date(row.expires_at) > new Date());
        const maxLimit = isPremium ? 100000 : 100;
        
        pendingConfig.set(chatId, 'max_results');
        
        return bot.sendMessage(chatId,
          `📊 *MÁXIMO DE RESULTADOS*\n\n` +
          `${isPremium ? '💎 Você é Premium' : '🟢 Você é Free'}\n` +
          `📊 Limite: 0 a ${maxLimit.toLocaleString('pt-BR')}\n\n` +
          `Digite um número ou /cancelar:\n\n` +
          `_Exemplo: 1000_`,
          opts({
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔴 CANCELAR', callback_data: 'config_menu', style: 'primary' }]
              ]
            }
          })
        );
      } catch (e) {
        console.error('[MAX RESULTS CONFIG ERROR]', e.message);
        return bot.sendMessage(chatId, `❌ Erro: ${e.message}`, opts());
      }
    }

    // IDIOMA — mostra opções de idioma
    if (data === 'language_menu') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      return bot.sendMessage(chatId,
        `🌐 *IDIOMA*\n\nSelecione seu idioma:`,
        opts({
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🇧🇷 Português (BR)', callback_data: 'cmd_menu', style: 'primary' }],
              [{ text: '🇺🇸 English (US)', callback_data: 'cmd_menu', style: 'primary' }],
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
        `🔍 MÓDULOS DE BUSCA\n\nEscolha uma categoria:`,
        opts({
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔗 URLS', callback_data: 'mod_urls', style: 'primary' }],
              [{ text: '✉️ EMAILS', callback_data: 'mod_emails', style: 'primary' }],
              [{ text: '👤 USUÁRIOS', callback_data: 'mod_usuarios', style: 'primary' }],
              [{ text: '📞 TELEFONE', callback_data: 'mod_telefone', style: 'primary' }],
              [{ text: '🔎 CONSULTAS AVANCADAS', callback_data: 'puxar_dados', style: 'primary' }],
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
        `🔗 MÓDULO URLS\n\nEscolha a busca:`,
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
        `✉️ MÓDULO EMAILS\n\nEscolha a busca:`,
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
        `👤 MÓDULO USUÁRIOS\n\nEscolha a busca:`,
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
        `📞 MÓDULO TELEFONE\n\nEscolha a busca:`,
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
        `📋 MÓDULO DADOS\n\nEscolha a busca:`,
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
        `🌍 MÓDULO DOMÍNIOS\n\nEscolha a busca:`,
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
        `🔌 MÓDULO PROTOCOLOS\n\nEscolha a busca:`,
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

    // Botões do menu de consulta — cada um pergunta o valor
    const consultaButtons = {
      consultar_cpf:     { key: 'cpf',    label: 'CPF',            example: '03140433735' },
      consultar_nome:    { key: 'nome',   label: 'Nome',           example: 'João Silva' },
      consultar_mae:     { key: 'mae',    label: 'Nome da Mãe',    example: 'Maria Santos' },
      consultar_pai:     { key: 'pai',    label: 'Nome do Pai',    example: 'José Santos' },
      consultar_rg:      { key: 'rg',     label: 'RG',             example: '123456789' },
      consultar_tel:     { key: 'tel',    label: 'Telefone',       example: '11987654321' },
      consultar_sit_cpf: { key: 'sit_cpf', label: 'CPF',           example: '03140433735' },
      consultar_titulo:  { key: 'titulo', label: 'Título Eleitor', example: '123456789012' },
      consultar_placa:   { key: 'placa',  label: 'Placa',          example: 'ABC1D23' },
      consultar_cnh:     { key: 'cnh',    label: 'CNH/CPF',        example: '03140433735' },
    };

    if (consultaButtons[data]) {
      const btn = consultaButtons[data];
      bot.answerCallbackQuery(callbackQuery.id, { text: `Digite o ${btn.label}...` }).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      pendingConsulta.set(userKey, btn.key);
      const replyMarkup2 = cbIsGroup
        ? { force_reply: true, selective: true }
        : { inline_keyboard: [[{ text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]] };
      const extraText2 = cbIsGroup ? `_Responda a esta mensagem com o valor ou digite /cancelar para sair._` : `_Ou clique no botão abaixo para sair._`;

      return bot.sendMessage(chatId,
        `🔍 *Buscar por ${btn.label}*\n\nEnvie o *${btn.label}* que deseja consultar:\n\n` +
        `_Exemplo: \`${btn.example}\`_\n\n` + extraText2,
        opts({ parse_mode: 'Markdown', reply_markup: replyMarkup2 })
      );
    }

    // Botão PUXAR DADOS (GRÁTIS) — abre menu de consulta
    
    // Botão PUXAR LOGINS — Menu de busca por logins
    if (data === 'puxar_logins') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      return bot.sendMessage(chatId,
        `🚀 PUXAR LOGINS\n\nEscolha o módulo de busca:`,
        opts({
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔗 URLS', callback_data: 'mod_urls', style: 'primary' }],
              [{ text: '✉️ EMAILS', callback_data: 'mod_emails', style: 'primary' }],
              [{ text: '👤 USUÁRIOS', callback_data: 'mod_usuarios', style: 'primary' }],
              [{ text: '📞 TELEFONE', callback_data: 'mod_telefone', style: 'primary' }],
              [{ text: '🚀 SUBDOMÍNIOS', callback_data: 'srch_subdominios', style: 'primary' }],
              [{ text: ' MENU PRINCIPAL', callback_data: 'cmd_menu', style: 'primary' }, { text: '🔴 FECHAR', callback_data: 'cancel_search', style: 'primary' }]
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

    // ── LOGOUT ──
    if (data === 'logout') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      try {
        await _writePool.query(
          `DELETE FROM user_sessions WHERE telegram_id = $1`,
          [chatId]
        );
        clearCachedAccess(chatId);
        bot.editMessageText(
          `🚪 *LOGOUT REALIZADO*\n\nVocê saiu da sua conta.\n\nPara entrar novamente, use /start e entre com sua chave.`,
          {
            chat_id: chatId,
            message_id: msg.message_id,
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔑 FAZER LOGIN', callback_data: 'login_start', style: 'primary' }],
                [{ text: '📝 FAZER CADASTRO', callback_data: 'register_start', style: 'primary' }]
              ]
            }
          }
        ).catch(() => {});
      } catch (e) {
        bot.sendMessage(chatId, `❌ Erro ao fazer logout: ${e.message}`, opts());
      }
      return;
    }

    // Botão CANCELAR BUSCA
    if (data === 'cancel_search') {
      const run = runningSearches.get(chatId);
      if (run) {
        run.cancelled = true;
        runningSearches.delete(chatId);
      }
      pendingSearch.delete(chatId);
      pendingConsulta.delete(chatId);
      bot.answerCallbackQuery(callbackQuery.id, { text: '⏹ Busca cancelada' }).catch(() => {});
      bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      return bot.sendMessage(chatId,
        '💀 *ASSEMBLY LOGS*\n\n🟢 *MENU PRINCIPAL*\n\n📌 *Navegue usando os botões abaixo:*',
        opts({
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🛠️ FERRAMENTAS', callback_data: 'tool_buscas', style: 'primary' }],
              [{ text: '🚀 PUXAR LOGINS', callback_data: 'puxar_logins', style: 'primary' }],
            [{ text: '📊 PUXAR DADOS', callback_data: 'puxar_dados', style: 'primary' }],
            [{ text: '👤 MINHA CONTA', callback_data: 'cmd_conta', style: 'primary' }],
              [{ text: '🔔 MONITORAR', callback_data: 'monitor_menu', style: 'primary' }],
              [{ text: '💎 PLANOS', callback_data: 'show_plans', style: 'primary' }],
              [{ text: '⚙️ CONFIGURAÇÕES', callback_data: 'config_menu', style: 'primary' }, { text: '🌐 IDIOMA', callback_data: 'language_menu', style: 'primary' }],
              [{ text: '📚 REFERÊNCIAS', url: 'https://t.me/+9oaCkNF_klpmMzUx', style: 'primary' }, { text: '🚪 LOGOUT', callback_data: 'logout', style: 'primary' }]
            ]
          }
        })
      );
    }

    // Botão VOLTAR ao start
    if (data === 'back_start') {
      bot.editMessageText('💀 *ASSEMBLY LOGS*\n\n🟢 *MENU PRINCIPAL*\n\n📌 *Navegue usando os botões abaixo:*', {
        chat_id: chatId,
        message_id: msg.message_id,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🛠️ FERRAMENTAS', callback_data: 'tool_buscas', style: 'primary' }],
            [{ text: '🚀 PUXAR LOGINS', callback_data: 'puxar_logins', style: 'primary' }],
            [{ text: '📊 PUXAR DADOS', callback_data: 'puxar_dados', style: 'primary' }],
            [{ text: '👤 MINHA CONTA', callback_data: 'cmd_conta', style: 'primary' }],
            [{ text: '🔔 MONITORAR', callback_data: 'monitor_menu', style: 'primary' }],
            [{ text: '💎 PLANOS', callback_data: 'show_plans', style: 'primary' }],
            [{ text: '⚙️ CONFIGURAÇÕES', callback_data: 'config_menu', style: 'primary' }, { text: '🌐 IDIOMA', callback_data: 'language_menu', style: 'primary' }],
            [{ text: '📚 REFERÊNCIAS', url: 'https://t.me/+9oaCkNF_klpmMzUx', style: 'primary' }, { text: '🚪 LOGOUT', callback_data: 'logout', style: 'primary' }]
          ]
        }
      }).catch(() => {});
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

    // Botão FAZER LOGIN (email+senha)
    if (data === 'login_start') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      pendingLogin.set(chatId, {});
      return bot.sendMessage(chatId,
        `🔑 *FAZER LOGIN*\n\nDigite seu *email* de cadastro:\n\n_Exemplo: \`usuario@email.com\`_\n\nOu /cancelar para voltar.`,
        opts({
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🔴 CANCELAR', callback_data: 'cancel_search', style: 'primary' }]]
          }
        })
      );
    }

    // Botão FAZER CADASTRO
    if (data === 'register_start') {
      bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
      pendingRegister.set(chatId, {});
      return bot.sendMessage(chatId,
        `📝 *FAZER CADASTRO*\n\nDigite seu *email* para cadastro:\n\n_Exemplo: \`usuario@email.com\`_\n\nOu /cancelar para voltar.`,
        opts({
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🔴 CANCELAR', callback_data: 'cancel_search', style: 'primary' }]]
          }
        })
      );
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



  });

  app.get('/api/bot', (req, res) => {
    res.send('🤖 Bot Assembly Leak ONLINE (POLLING)');
  });

  console.log('🤖 Bot iniciado. Apenas comandos / são processados.');

  // ── Monitoramento periódico em tempo real ──
  async function checkMonitoredItems() {
    try {
      const items = await getAllMonitoredItems();
      if (!items || items.length === 0) return;
      for (const item of items) {
        try {
          const data = item.type === 'email' ? await searchByEmail(item.value) : await searchByUsername(item.value);
          if (data && data.stealers && data.stealers.length > 0) {
            const total = data.stealers.length;
            await bot.sendMessage(item.chat_id,
              `🔔 *ALERTA — ${item.type === 'email' ? 'Email' : 'Username'} monitorado!*\n\n` +
              `📌 *${item.value}*\n📱 *Dispositivos infectados:* ${total}\n\n` +
              `_Última verificação: ${new Date().toLocaleString('pt-BR')}_`,
              { parse_mode: 'Markdown' }
            ).catch(() => {});
          }
          await updateLastCheck(item.id);
        } catch {}
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) { console.error('[MONITOR] check error:', e.message); }
  }
  setInterval(checkMonitoredItems, 15 * 60 * 1000);
  setTimeout(checkMonitoredItems, 10 * 1000);
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
    if (data.status !== 'success') throw new Error(data.message || 'falha na consulta');
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

