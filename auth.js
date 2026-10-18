/**
 * 访问控制：单用户密码登录
 *
 * - 密码使用 Node 内置 crypto.scrypt 哈希后存入 config.auth.json（文件 0600），
 *   不引入额外依赖，也不在配置回显中暴露任何与密码相关的内容。
 * - 会话是 HMAC-SHA256 签名的自包含令牌（无服务端状态，重启和换容器不失效）。
 *   令牌记录 epoch 授权代际：改密、启用或关闭登录都会推进 epoch，
 *   使所有已发出的旧令牌立即失效，用于"修改密码后踢掉所有设备"。
 * - 登录尝试按来源 IP 限流：连续失败达到上限后锁定一段时间。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_DIR = process.env.TODO_CONFIG_DIR || __dirname;
const AUTH_FILE = process.env.TODO_AUTH_FILE || path.join(CONFIG_DIR, 'config.auth.json');
const AUTH_KEY_FILE = process.env.TODO_AUTH_KEY_FILE || path.join(CONFIG_DIR, 'config.auth.key');
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const MIN_PASSWORD_CHARS = 6;
const MAX_PASSWORD_CHARS = 200;
const MAX_FAILED_LOGINS = 5;
const LOGIN_LOCK_MS = 10 * 60 * 1000;
const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_MS = 12 * 60 * 60 * 1000;
const COOKIE_NAME = 'todo_session';
const TOKEN_VERSION = 1;

let cachedState = null;
let authKey = null;
const loginAttempts = new Map();

// ── 状态存取 ─────────────────────────────────────────────
function defaultState() {
  return { version: 1, enabled: false, epoch: 1, credentials: '' };
}

function isValidNormalizedState(state) {
  return state && typeof state === 'object' && !Array.isArray(state) &&
    typeof state.enabled === 'boolean' && Number.isInteger(state.epoch) && state.epoch >= 0 &&
    (typeof state.credentials === 'string' || typeof state.credentials === 'undefined');
}

function readState() {
  if (cachedState) return cachedState;
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch (_) {
    state = null;
  }
  cachedState = isValidNormalizedState(state) ? state : defaultState();
  return cachedState;
}

function saveState(state) {
  const tempFile = `${AUTH_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tempFile, AUTH_FILE);
  try { fs.chmodSync(AUTH_FILE, 0o600); } catch (_) {}
  cachedState = state;
}

function authSecret() {
  if (authKey) return authKey;
  if (process.env.TODO_AUTH_KEY) {
    authKey = Buffer.from(process.env.TODO_AUTH_KEY, 'base64url');
    return authKey;
  }
  if (fs.existsSync(AUTH_KEY_FILE)) return fs.readFileSync(AUTH_KEY_FILE);
  const key = crypto.randomBytes(32);
  fs.writeFileSync(AUTH_KEY_FILE, key, { mode: 0o600 });
  try { fs.chmodSync(AUTH_KEY_FILE, 0o600); } catch (_) {}
  return key;
}

// ── 密码哈希 ─────────────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(SCRYPT_KEYLEN / 2);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
  });
  return [
    `scrypt`, `N=${SCRYPT_N}`, `r=${SCRYPT_R}`, `p=${SCRYPT_P}`,
    salt.toString('hex'), hash.toString('hex'),
  ].join('$');
}

function verifyPassword(password, credentials) {
  if (typeof credentials !== 'string' || !credentials.startsWith('scrypt$')) return false;
  const parts = credentials.split('$');
  if (parts.length !== 6) return false;
  const salt = Buffer.from(parts[4], 'hex');
  const expected = Buffer.from(parts[5], 'hex');
  try {
    const actual = crypto.scryptSync(String(password), salt, expected.length, {
      N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

// ── 会话令牌 ─────────────────────────────────────────────
function hmacSign(payload) {
  return crypto.createHmac('sha256', authSecret()).update(payload).digest('base64url');
}

function createToken(epoch, expiresAtMs) {
  const payload = Buffer.from(JSON.stringify({ v: TOKEN_VERSION, e: epoch, x: expiresAtMs }), 'utf8');
  return `${payload.toString('base64url')}.${hmacSign(payload)}`;
}

function verifyToken(token, epoch) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const payload = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
  let data;
  try {
    data = JSON.parse(payload);
  } catch (_) {
    return false;
  }
  if (!data || data.v !== TOKEN_VERSION || data.e !== epoch) return false;
  if (typeof data.x !== 'number' || data.x < Date.now()) return false;
  const expected = hmacSign(Buffer.from(payload, 'utf8'));
  const expectedBuf = Buffer.from(expected, 'base64url');
  const actualBuf = Buffer.from(token.slice(dot + 1).split('.')[0], 'base64url');
  return expectedBuf.length === actualBuf.length &&
    crypto.timingSafeEqual(expectedBuf, actualBuf);
}

function readSessionCookie(req) {
  const header = req.headers?.cookie;
  if (!header) return '';
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === COOKIE_NAME) return pair.slice(eq + 1).trim();
  }
  return '';
}

function secureCookieFlag(req) {
  return !!(req?.socket?.encrypted) || /^(1|true|yes|on)$/i.test(process.env.TODO_AUTH_SECURE_COOKIES || '');
}

function cookieHeader(token, maxAgeMs = null, secure = false) {
  const parts = [`${COOKIE_NAME}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (typeof maxAgeMs === 'number' && maxAgeMs > 0) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearCookieHeader(secure = false) {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// ── 登录限流 ─────────────────────────────────────────────
function loginAttemptState(ip, now) {
  let entry = loginAttempts.get(ip);
  if (!entry || (entry.lockedUntil && entry.lockedUntil <= now)) {
    entry = { fails: entry?.fails || 0, lockedUntil: 0 };
    loginAttempts.set(ip, entry);
  }
  return entry;
}

function expectLoginAttempt(ip) {
  const now = Date.now();
  const entry = loginAttemptState(ip, now);
  if (entry.lockedUntil > now) {
    return { ok: false, retryAfterMs: entry.lockedUntil - now };
  }
  return { ok: true, retryAfterMs: 0 };
}

function noteLoginResult(ip, succeeded) {
  if (succeeded) {
    loginAttempts.delete(ip);
    return;
  }
  const entry = loginAttemptState(ip, Date.now());
  entry.fails += 1;
  if (entry.fails >= MAX_FAILED_LOGINS) {
    entry.lockedUntil = Date.now() + LOGIN_LOCK_MS;
    entry.fails = 0;
  }
}

function clearRateLimits() {
  loginAttempts.clear();
}

function trimLoginAttempts(now = Date.now()) {
  if (loginAttempts.size <= 512) return;
  for (const [ip, entry] of loginAttempts) {
    if (!entry.lockedUntil || entry.lockedUntil <= now) loginAttempts.delete(ip);
  }
}

// ── 对外接口 ─────────────────────────────────────────────
function enabled() {
  const state = readState();
  return state.enabled && !!state.credentials;
}

function isRequestAuthenticated(req) {
  if (!enabled()) return true;
  const state = readState();
  return verifyToken(readSessionCookie(req), state.epoch);
}

function publicStatus(req) {
  const authed = isRequestAuthenticated(req);
  const base = { enabled: enabled(), authed };
  if (!authed) {
    trimLoginAttempts();
    const attempt = loginAttemptState(req?.socket?.remoteAddress || 'unknown', Date.now());
    if (attempt.lockedUntil > Date.now()) {
      base.cooldown = { retryAfterMs: attempt.lockedUntil - Date.now() };
    }
  }
  return base;
}

function validatePassword(value, label = '密码') {
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`);
  if (value.length < MIN_PASSWORD_CHARS) throw new Error(`${label}长度至少 ${MIN_PASSWORD_CHARS} 个字符`);
  if (value.length > MAX_PASSWORD_CHARS) throw new Error(`${label}长度最多 ${MAX_PASSWORD_CHARS} 个字符`);
  return value;
}

function setPassword(newPassword, { secure = false } = {}) {
  const state = readState();
  validatePassword(newPassword);
  const next = { ...state, enabled: true, epoch: state.epoch + 1, credentials: hashPassword(newPassword) };
  saveState(next);
  return {
    success: true,
    enabled: true,
    authed: true,
    cookie: cookieHeader(createToken(next.epoch, Date.now() + REMEMBER_MS), REMEMBER_MS, secure),
  };
}

function changePassword(currentPassword, newPassword, { secure = false } = {}) {
  const state = readState();
  if (state.enabled && state.credentials) {
    if (!verifyPassword(currentPassword, state.credentials)) {
      throw new Error('当前密码不正确');
    }
  }
  validatePassword(newPassword);
  const next = { ...state, enabled: true, epoch: state.epoch + 1, credentials: hashPassword(newPassword) };
  saveState(next);
  return {
    success: true,
    enabled: true,
    cookie: cookieHeader(createToken(next.epoch, Date.now() + REMEMBER_MS), REMEMBER_MS, secure),
  };
}

function disable(password) {
  const state = readState();
  if (state.enabled && !verifyPassword(password, state.credentials)) {
    throw new Error('当前密码不正确');
  }
  const next = { ...state, enabled: false, epoch: state.epoch + 1 };
  saveState(next);
  return { success: true, enabled: false };
}

// 不修改密码，只推进 epoch：使所有已登录设备立即失效并要求重新登录。
function forceLogoutAll() {
  const state = readState();
  const next = { ...state, epoch: state.epoch + 1 };
  saveState(next);
  return { success: true, epoch: next.epoch, enabled: !!state.credentials && state.enabled };
}

function login(password, remember, { secure = false } = {}) {
  const state = readState();
  if (!verifyPassword(password, state.credentials)) {
    return { ok: false, error: '密码错误' };
  }
  const maxAgeMs = remember ? REMEMBER_MS : null;
  const expiresAt = remember ? Date.now() + REMEMBER_MS : Date.now() + SESSION_MS;
  return {
    ok: true,
    authed: true,
    cookie: cookieHeader(createToken(state.epoch, expiresAt), maxAgeMs, secure),
  };
}

function bootstrapFromEnv() {
  const envPassword = process.env.TODO_AUTH_PASSWORD;
  if (!enabled() && typeof envPassword === 'string' && envPassword.length >= MIN_PASSWORD_CHARS) {
    const result = setPassword(envPassword);
    console.log('[AUTH] 已通过 TODO_AUTH_PASSWORD 启用访问保护');
    return result.ok || result.success;
  }
  return false;
}

module.exports = {
  AUTH_FILE,
  AUTH_KEY_FILE,
  COOKIE_NAME,
  bootstrapFromEnv,
  changePassword,
  clearRateLimits,
  clearCookieHeader,
  disable,
  enabled,
  expectLoginAttempt,
  forceLogoutAll,
  isRequestAuthenticated,
  login,
  noteLoginResult,
  publicStatus,
  secureCookieFlag,
  setPassword,
};
