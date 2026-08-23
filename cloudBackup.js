const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { getFullConfig } = require('./appConfig.js');

const DEFAULT_WEBDAV_URL = 'https://dav.jianguoyun.com/dav/';
const PROVIDER = 'jianguoyun';
const DEFAULT_BACKUP_DIR = 'todo-app-backups';
const DEFAULT_TIMEOUT_MS = 30000;
const BACKUP_SCHEMA_VERSION = 2;

function getBackupConfig(extra = {}) {
  const patch = extra.webdav ? extra : { webdav: extra };
  const webdav = getFullConfig(patch).webdav;
  return {
    provider: PROVIDER,
    baseUrl: webdav.baseUrl || DEFAULT_WEBDAV_URL,
    backupDir: trimSlashes(webdav.backupDir) || DEFAULT_BACKUP_DIR,
    usernameConfigured: !!webdav.username,
    passwordConfigured: !!webdav.password,
    configured: !!(webdav.username && webdav.password && webdav.baseUrl),
    autoEnabled: !!webdav.autoEnabled,
    intervalHours: Math.max(1, Number(webdav.intervalHours) || 24),
    username: webdav.username,
    password: webdav.password,
  };
}

function publicBackupStatus(config = getBackupConfig()) {
  return {
    provider: config.provider,
    baseUrl: config.baseUrl,
    backupDir: config.backupDir,
    configured: config.configured,
    usernameConfigured: config.usernameConfigured,
    passwordConfigured: config.passwordConfigured,
    autoEnabled: config.autoEnabled,
    intervalHours: config.intervalHours,
  };
}

function trimSlashes(value) {
  return String(value || '').replace(/^\/+|\/+$/g, '');
}

function joinUrl(base, ...parts) {
  const baseUrl = new URL(base);
  const basePath = trimSlashes(decodeURIComponent(baseUrl.pathname));
  const pathParts = [basePath, ...parts.map(trimSlashes)].filter(Boolean);
  baseUrl.pathname = '/' + pathParts
    .map(part => part.split('/').map(encodeURIComponent).join('/'))
    .join('/');
  return baseUrl.toString();
}

function timestampForFile(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function gzipBuffer(buffer) {
  return zlib.gzipSync(buffer, { level: zlib.constants.Z_BEST_COMPRESSION });
}

function listNoteFiles(notesDir) {
  if (!fs.existsSync(notesDir)) return [];
  return fs.readdirSync(notesDir)
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => {
      const filepath = path.join(notesDir, name);
      const stat = fs.statSync(filepath);
      const content = fs.readFileSync(filepath);
      const hash = sha256(content);
      return {
        name,
        hash,
        size: content.length,
        mtimeMs: stat.mtimeMs,
        content,
        objectPath: `objects/notes/${hash}.md.gz`,
      };
    });
}

function buildSnapshot(paths, createdAt = new Date()) {
  const { rootDir, dbFile, notesDir } = paths;
  if (!fs.existsSync(dbFile)) throw new Error(`数据库文件不存在：${dbFile}`);

  const dbStat = fs.statSync(dbFile);
  const dbContent = fs.readFileSync(dbFile);
  const dbHash = sha256(dbContent);
  const notes = listNoteFiles(notesDir);
  const snapshotId = `${timestampForFile(createdAt)}-${crypto.randomBytes(4).toString('hex')}`;

  const manifest = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    app: 'todo-app',
    type: 'snapshot',
    snapshotId,
    createdAt: createdAt.toISOString(),
    source: {
      rootDir: path.basename(rootDir),
      dbFile: path.basename(dbFile),
      notesDir: path.basename(notesDir),
    },
    strategy: 'content-addressed-incremental',
    database: {
      name: path.basename(dbFile),
      hash: dbHash,
      objectPath: `objects/database/${dbHash}.db.gz`,
      size: dbContent.length,
      mtimeMs: dbStat.mtimeMs,
    },
    notes: notes.map(note => ({
      name: note.name,
      hash: note.hash,
      objectPath: note.objectPath,
      size: note.size,
      mtimeMs: note.mtimeMs,
    })),
  };

  return {
    manifest,
    dbContent,
    notes,
    snapshotPath: `snapshots/${snapshotId}.json`,
    latestPath: 'latest.json',
  };
}

function webdavRequest(method, targetUrl, config, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const client = parsed.protocol === 'http:' ? http : https;
    const req = client.request({
      method,
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      timeout: DEFAULT_TIMEOUT_MS,
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`,
        ...headers,
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: res.statusCode, headers: res.headers, body: responseBody });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`WebDAV 请求超时：${method} ${targetUrl}`)));
    req.on('error', reject);
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

async function ensureRemoteDirs(config, directories = [config.backupDir]) {
  const created = [];
  for (const directory of directories) {
    const parts = directory.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const relativePath = parts.slice(0, i + 1).join('/');
      const dirUrl = joinUrl(config.baseUrl, relativePath);
      const res = await webdavRequest('MKCOL', dirUrl, config);
      if (![201, 200, 204, 405].includes(res.statusCode)) {
        throw new Error(`创建远程目录失败（HTTP ${res.statusCode}）：${relativePath}`);
      }
      if (res.statusCode === 201) created.push(relativePath);
    }
  }
  return created;
}

async function remoteExists(config, relativePath) {
  const res = await webdavRequest('HEAD', joinUrl(config.baseUrl, config.backupDir, relativePath), config);
  if ([200, 204].includes(res.statusCode)) return true;
  if (res.statusCode === 404) return false;
  throw new Error(`检查远程文件失败（HTTP ${res.statusCode}）：${relativePath}`);
}

async function putObjectIfMissing(config, relativePath, body, contentType) {
  if (await remoteExists(config, relativePath)) {
    return { uploaded: false, reused: true, bytes: 0 };
  }
  const res = await webdavRequest(
    'PUT',
    joinUrl(config.baseUrl, config.backupDir, relativePath),
    config,
    body,
    { 'Content-Type': contentType, 'Content-Length': body.length },
  );
  if (![200, 201, 204, 409].includes(res.statusCode)) {
    throw new Error(`上传备份对象失败（HTTP ${res.statusCode}）：${relativePath} ${res.body.slice(0, 160)}`);
  }
  // 409 can happen if another process uploaded the same content-addressed object first.
  return { uploaded: res.statusCode !== 409, reused: res.statusCode === 409, bytes: res.statusCode === 409 ? 0 : body.length };
}

async function getRemoteJson(config, relativePath) {
  const res = await webdavRequest('GET', joinUrl(config.baseUrl, config.backupDir, relativePath), config);
  if (res.statusCode === 404) return null;
  if (res.statusCode !== 200) {
    throw new Error(`读取远程清单失败（HTTP ${res.statusCode}）：${relativePath}`);
  }
  try {
    return JSON.parse(res.body);
  } catch (e) {
    throw new Error(`远程清单格式无效：${relativePath}`);
  }
}

async function readPreviousSnapshot(config) {
  const latest = await getRemoteJson(config, 'latest.json');
  if (!latest) return null;
  if (latest.type === 'snapshot' && Array.isArray(latest.notes)) return latest;
  if (!latest.snapshotPath) return null;
  return getRemoteJson(config, latest.snapshotPath);
}

async function testBackupConfig(config = getBackupConfig()) {
  if (!config.configured) {
    throw new Error('坚果云 WebDAV 未配置完整，请填写账号和应用密码');
  }
  const startedAt = Date.now();
  await ensureRemoteDirs(config, [
    config.backupDir,
    `${config.backupDir}/objects/database`,
    `${config.backupDir}/objects/notes`,
    `${config.backupDir}/snapshots`,
  ]);
  return {
    success: true,
    provider: config.provider,
    baseUrl: config.baseUrl,
    backupDir: config.backupDir,
    strategy: 'content-addressed-incremental',
    durationMs: Date.now() - startedAt,
  };
}

async function uploadBackup(paths, config = getBackupConfig()) {
  if (!config.configured) {
    throw new Error('坚果云 WebDAV 未配置完整，请填写账号和应用密码');
  }
  const startedAt = Date.now();
  await ensureRemoteDirs(config, [
    config.backupDir,
    `${config.backupDir}/objects/database`,
    `${config.backupDir}/objects/notes`,
    `${config.backupDir}/snapshots`,
  ]);

  const previous = await readPreviousSnapshot(config);
  const createdAt = new Date();
  const { manifest, dbContent, notes, snapshotPath, latestPath } = buildSnapshot(paths, createdAt);
  const uploaded = [];
  const reused = [];
  let bytesUploaded = 0;

  const uploadObject = async (relativePath, content) => {
    const result = await putObjectIfMissing(config, relativePath, gzipBuffer(content), 'application/gzip');
    (result.uploaded ? uploaded : reused).push(relativePath);
    bytesUploaded += result.bytes;
  };

  await uploadObject(manifest.database.objectPath, dbContent);
  for (const note of notes) await uploadObject(note.objectPath, note.content);

  const snapshotBuffer = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const snapshotRes = await webdavRequest(
    'PUT',
    joinUrl(config.baseUrl, config.backupDir, snapshotPath),
    config,
    snapshotBuffer,
    { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': snapshotBuffer.length },
  );
  if (![200, 201, 204].includes(snapshotRes.statusCode)) {
    throw new Error(`上传快照清单失败（HTTP ${snapshotRes.statusCode}）：${snapshotRes.body.slice(0, 160)}`);
  }
  bytesUploaded += snapshotBuffer.length;

  const latest = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    app: 'todo-app',
    type: 'latest-pointer',
    createdAt: manifest.createdAt,
    snapshotId: manifest.snapshotId,
    snapshotPath,
    databaseHash: manifest.database.hash,
    noteCount: manifest.notes.length,
  };
  const latestBuffer = Buffer.from(JSON.stringify(latest, null, 2) + '\n', 'utf8');
  const latestRes = await webdavRequest(
    'PUT',
    joinUrl(config.baseUrl, config.backupDir, latestPath),
    config,
    latestBuffer,
    { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': latestBuffer.length },
  );
  if (![200, 201, 204].includes(latestRes.statusCode)) {
    throw new Error(`更新最新备份指针失败（HTTP ${latestRes.statusCode}）：${latestRes.body.slice(0, 160)}`);
  }
  bytesUploaded += latestBuffer.length;

  const previousNotes = new Map((previous?.notes || []).map(note => [note.name, note]));
  const currentNotes = new Map(manifest.notes.map(note => [note.name, note]));
  const changedNotes = manifest.notes.filter(note => previousNotes.get(note.name)?.hash !== note.hash).length;
  const deletedNotes = (previous?.notes || []).filter(note => !currentNotes.has(note.name)).length;

  return {
    success: true,
    provider: config.provider,
    strategy: 'content-addressed-incremental',
    snapshotPath: `${config.backupDir}/${snapshotPath}`,
    latestPath: `${config.backupDir}/${latestPath}`,
    remotePath: `${config.backupDir}/${snapshotPath}`,
    filename: path.basename(snapshotPath),
    bytes: bytesUploaded,
    snapshotBytes: snapshotBuffer.length,
    latestBytes: latestBuffer.length,
    dbBytes: dbContent.length,
    noteCount: manifest.notes.length,
    databaseChanged: previous?.database?.hash !== manifest.database.hash,
    changedNotes,
    deletedNotes,
    uploadedObjects: uploaded.length,
    reusedObjects: reused.length,
    uploadedObjectPaths: uploaded,
    reusedObjectPaths: reused,
    durationMs: Date.now() - startedAt,
    createdAt: manifest.createdAt,
  };
}

module.exports = {
  getBackupConfig,
  publicBackupStatus,
  testBackupConfig,
  uploadBackup,
};
