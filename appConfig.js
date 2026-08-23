const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_FILE = process.env.TODO_CONFIG_FILE || path.join(__dirname, 'config.local.json');
const CONFIG_KEY_FILE = process.env.TODO_CONFIG_KEY_FILE || path.join(__dirname, 'config.local.key');
const ENCRYPTED_PREFIX = 'enc:v1:';

const DEFAULT_CONFIG = {
  email: {
    enabled: false,
    checkTime: '09:00',
    host: 'smtp.163.com',
    port: 465,
    secure: true,
    user: '',
    password: '',
    fromName: 'TODO提醒',
    from: '',
    recipients: '',
  },
  webdav: {
    provider: 'jianguoyun',
    baseUrl: 'https://dav.jianguoyun.com/dav/',
    username: '',
    password: '',
    backupDir: 'todo-app-backups',
    autoEnabled: false,
    intervalHours: 24,
  },
};

function envDefaultConfig() {
  return {
    email: {
      host: process.env.TODO_SMTP_HOST || DEFAULT_CONFIG.email.host,
      port: Number(process.env.TODO_SMTP_PORT) || DEFAULT_CONFIG.email.port,
      secure: process.env.TODO_SMTP_SECURE === undefined
        ? undefined
        : /^(1|true|yes|on)$/i.test(process.env.TODO_SMTP_SECURE),
      user: process.env.TODO_SMTP_USER || '',
      password: process.env.TODO_SMTP_PASS || '',
      from: process.env.TODO_SMTP_FROM || '',
      recipients: process.env.TODO_MAIL_RECIPIENTS || process.env.TODO_DEFAULT_RECIPIENT || process.env.TODO_SMTP_TO || '',
    },
    webdav: {
      baseUrl: process.env.TODO_WEBDAV_URL || process.env.JIANGUOYUN_WEBDAV_URL || DEFAULT_CONFIG.webdav.baseUrl,
      username: process.env.TODO_WEBDAV_USERNAME || process.env.JIANGUOYUN_USERNAME || '',
      password: process.env.TODO_WEBDAV_PASSWORD || process.env.JIANGUOYUN_PASSWORD || '',
      backupDir: process.env.TODO_WEBDAV_BACKUP_DIR || process.env.JIANGUOYUN_BACKUP_DIR || DEFAULT_CONFIG.webdav.backupDir,
      autoEnabled: /^(1|true|yes|on)$/i.test(process.env.TODO_BACKUP_AUTO || ''),
      intervalHours: Number(process.env.TODO_BACKUP_INTERVAL_HOURS) || DEFAULT_CONFIG.webdav.intervalHours,
    },
  };
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function mergeDeep(...objects) {
  const result = {};
  for (const obj of objects) {
    if (!isPlainObject(obj)) continue;
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined) continue;
      if (isPlainObject(value) && isPlainObject(result[key])) {
        result[key] = mergeDeep(result[key], value);
      } else if (isPlainObject(value)) {
        result[key] = mergeDeep({}, value);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

function readJsonFile(filepath) {
  if (!fs.existsSync(filepath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) {
    throw new Error(`读取配置文件失败：${e.message}`);
  }
}

function ensureDir(filepath) {
  const dir = path.dirname(filepath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readOrCreateSecret() {
  if (process.env.TODO_CONFIG_SECRET) return process.env.TODO_CONFIG_SECRET;
  ensureDir(CONFIG_KEY_FILE);
  if (fs.existsSync(CONFIG_KEY_FILE)) return fs.readFileSync(CONFIG_KEY_FILE, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(CONFIG_KEY_FILE, secret + '\n', { mode: 0o600 });
  try { fs.chmodSync(CONFIG_KEY_FILE, 0o600); } catch (_) {}
  return secret;
}

function encryptionKey() {
  // The machine-local random secret keeps config.local.json from storing secrets in plaintext.
  // TODO_CONFIG_SECRET can be set for deterministic deploys/backups across hosts.
  const secret = readOrCreateSecret();
  return crypto.scryptSync(secret, 'todo-app-config:v1', 32);
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

function encryptSecret(value) {
  const plaintext = String(value || '');
  if (!plaintext) return '';
  if (isEncrypted(plaintext)) return plaintext;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENCRYPTED_PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

function decryptSecret(value) {
  if (!value) return '';
  if (!isEncrypted(value)) return String(value);
  try {
    const raw = Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64url');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch (e) {
    throw new Error('配置密钥不匹配，无法解密已保存的密码/授权码');
  }
}

function decryptStoredConfig(config) {
  const decrypted = mergeDeep({}, config || {});
  if (decrypted.email?.password) decrypted.email.password = decryptSecret(decrypted.email.password);
  if (decrypted.webdav?.password) decrypted.webdav.password = decryptSecret(decrypted.webdav.password);
  return decrypted;
}

function encryptStoredConfig(config) {
  const encrypted = mergeDeep({}, config || {});
  if (encrypted.email?.password) encrypted.email.password = encryptSecret(encrypted.email.password);
  if (encrypted.webdav?.password) encrypted.webdav.password = encryptSecret(encrypted.webdav.password);
  return encrypted;
}

function decryptStoredEnvelope(raw) {
  if (raw?.encrypted) {
    try {
      return JSON.parse(decryptSecret(raw.encrypted));
    } catch (e) {
      if (e.message.includes('配置密钥不匹配')) throw e;
      throw new Error(`解密配置文件失败：${e.message}`);
    }
  }
  // Legacy support: older versions stored non-secret config and, briefly, encrypted only passwords.
  return decryptStoredConfig(raw);
}

function readStoredConfig() {
  return decryptStoredEnvelope(readJsonFile(CONFIG_FILE));
}

function storedConfigNeedsMigration(raw) {
  return !!(
    fs.existsSync(CONFIG_FILE) &&
    !raw?.encrypted
  );
}

function migrateStoredConfigSecrets() {
  if (!fs.existsSync(CONFIG_FILE)) return false;
  const raw = readJsonFile(CONFIG_FILE);
  if (!storedConfigNeedsMigration(raw)) return false;
  const decrypted = decryptStoredEnvelope(raw);
  writeStoredConfig(normalizeConfig(decrypted));
  return true;
}

function normalizeConfig(config) {
  const merged = mergeDeep(DEFAULT_CONFIG, config || {});
  merged.email.enabled = !!merged.email.enabled;
  merged.email.checkTime = String(merged.email.checkTime || DEFAULT_CONFIG.email.checkTime);
  merged.email.host = String(merged.email.host || '').trim();
  merged.email.port = Number(merged.email.port) || DEFAULT_CONFIG.email.port;
  merged.email.secure = merged.email.secure === undefined ? merged.email.port === 465 : !!merged.email.secure;
  merged.email.user = String(merged.email.user || '').trim();
  merged.email.password = String(merged.email.password || '');
  merged.email.fromName = String(merged.email.fromName || DEFAULT_CONFIG.email.fromName).trim();
  merged.email.from = String(merged.email.from || '').trim();
  merged.email.recipients = String(merged.email.recipients || merged.email.defaultTo || '').trim();
  delete merged.email.defaultTo;

  merged.webdav.provider = 'jianguoyun';
  merged.webdav.baseUrl = String(merged.webdav.baseUrl || DEFAULT_CONFIG.webdav.baseUrl).trim();
  merged.webdav.username = String(merged.webdav.username || '').trim();
  merged.webdav.password = String(merged.webdav.password || '');
  merged.webdav.backupDir = String(merged.webdav.backupDir || DEFAULT_CONFIG.webdav.backupDir).trim().replace(/^\/+|\/+$/g, '') || DEFAULT_CONFIG.webdav.backupDir;
  merged.webdav.autoEnabled = !!merged.webdav.autoEnabled;
  merged.webdav.intervalHours = Math.max(1, Number(merged.webdav.intervalHours) || DEFAULT_CONFIG.webdav.intervalHours);
  return merged;
}

function getFullConfig(extra = {}) {
  return normalizeConfig(mergeDeep(DEFAULT_CONFIG, envDefaultConfig(), readStoredConfig(), extra));
}

function writeStoredConfig(config) {
  ensureDir(CONFIG_FILE);
  const tempFile = `${CONFIG_FILE}.${process.pid}.tmp`;
  const normalized = normalizeConfig(config);
  const safeConfig = {
    version: 1,
    encrypted: encryptSecret(JSON.stringify(normalized)),
  };
  fs.writeFileSync(tempFile, JSON.stringify(safeConfig, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tempFile, CONFIG_FILE);
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (_) {}
}

function saveAppConfig(patch = {}) {
  const current = getFullConfig();
  const next = normalizeConfig(mergeDeep(current, patch));
  writeStoredConfig(next);
  return next;
}

function isEmailConfigured(email = getFullConfig().email) {
  return !!(email.host && email.port && email.user && email.password);
}

function isWebdavConfigured(webdav = getFullConfig().webdav) {
  return !!(webdav.baseUrl && webdav.username && webdav.password);
}

function publicAppConfig(config = getFullConfig()) {
  return {
    email: {
      enabled: config.email.enabled,
      checkTime: config.email.checkTime,
      host: config.email.host,
      port: config.email.port,
      secure: config.email.secure,
      user: config.email.user,
      passwordConfigured: !!config.email.password,
      fromName: config.email.fromName,
      from: config.email.from,
      recipients: config.email.recipients,
      configured: isEmailConfigured(config.email),
    },
    webdav: {
      provider: config.webdav.provider,
      baseUrl: config.webdav.baseUrl,
      username: config.webdav.username,
      passwordConfigured: !!config.webdav.password,
      backupDir: config.webdav.backupDir,
      autoEnabled: config.webdav.autoEnabled,
      intervalHours: config.webdav.intervalHours,
      configured: isWebdavConfigured(config.webdav),
    },
    // Backward-compatible fields for older front-end code.
    emailEnabled: config.email.enabled,
    checkTime: config.email.checkTime,
    smtpReady: isEmailConfigured(config.email),
  };
}

module.exports = {
  CONFIG_FILE,
  CONFIG_KEY_FILE,
  getFullConfig,
  migrateStoredConfigSecrets,
  saveAppConfig,
  publicAppConfig,
  isEmailConfigured,
  isWebdavConfigured,
  mergeDeep,
  encryptSecret,
  decryptSecret,
};
