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
const DEFAULT_MAX_RESTORE_BYTES = 128 * 1024 * 1024;
const configuredRestoreLimit = Number(process.env.TODO_RESTORE_MAX_BYTES);
const MAX_RESTORE_OBJECT_BYTES = Number.isSafeInteger(configuredRestoreLimit) && configuredRestoreLimit > 0
  ? configuredRestoreLimit
  : DEFAULT_MAX_RESTORE_BYTES;

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

function snapshotMonthFor(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) throw new Error(`快照时间无效：${date}`);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
}

function snapshotPathFor(date, snapshotId) {
  return `snapshots/${snapshotMonthFor(date)}/${snapshotId}.json`;
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
    snapshotPath: snapshotPathFor(createdAt, snapshotId),
    latestPath: 'latest.json',
  };
}

function webdavRequest(method, targetUrl, config, body = null, headers = {}, options = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
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
      let responseBytes = 0;
      const failResponse = error => {
        if (settled) return;
        settled = true;
        if (typeof res.resume === 'function') res.resume();
        reject(error);
      };
      res.on('data', chunk => {
        if (settled) return;
        responseBytes += chunk.length;
        if (options.maxResponseBytes && responseBytes > options.maxResponseBytes) {
          failResponse(new Error(`WebDAV 响应过大：${options.maxResponseBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        const responseBuffer = Buffer.concat(chunks);
        const responseBody = options.binary ? responseBuffer : responseBuffer.toString('utf8');
        resolve({ statusCode: res.statusCode, headers: res.headers, body: responseBody });
      });
      res.on('error', error => failResponse(new Error(`WebDAV 响应中断：${error.message}`)));
      res.on('aborted', () => failResponse(new Error(`WebDAV 响应被中止：${method} ${targetUrl}`)));
    });
    req.on('timeout', () => req.destroy(new Error(`WebDAV 请求超时：${method} ${targetUrl}`)));
    req.on('error', fail);
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}

function safeRemotePath(value, label = '远程路径') {
  const relativePath = String(value || '').replace(/^\/+|\/+$/g, '');
  const parts = relativePath.split('/');
  if (!relativePath || relativePath.length > 500 || relativePath.includes('\\') ||
      parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error(`${label}无效：${value}`);
  }
  return relativePath;
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
    if (!(await remoteObjectMatches(config, relativePath, body))) {
      throw new Error(`远程备份对象已存在但内容无法校验：${relativePath}`);
    }
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
  if (res.statusCode === 409) {
    // A concurrent WebDAV create may return 409. Do not treat HEAD/409 as
    // proof that the object is complete; reuse only after hash-validating it.
    if (!(await remoteObjectMatches(config, relativePath, body))) {
      throw new Error(`上传备份对象冲突且远程内容不匹配：${relativePath}`);
    }
    return { uploaded: false, reused: true, bytes: 0 };
  }
  return { uploaded: true, reused: false, bytes: body.length };
}

async function getRemoteJson(config, relativePath) {
  const safePath = safeRemotePath(relativePath, '远程清单路径');
  const res = await webdavRequest(
    'GET',
    joinUrl(config.baseUrl, config.backupDir, safePath),
    config,
    null,
    {},
    { maxResponseBytes: MAX_RESTORE_OBJECT_BYTES },
  );
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

async function getRemoteBuffer(config, relativePath) {
  const safePath = safeRemotePath(relativePath, '远程对象路径');
  const res = await webdavRequest(
    'GET',
    joinUrl(config.baseUrl, config.backupDir, safePath),
    config,
    null,
    {},
    { binary: true, maxResponseBytes: MAX_RESTORE_OBJECT_BYTES },
  );
  if (res.statusCode === 404) return null;
  if (res.statusCode !== 200) {
    throw new Error(`读取远程备份对象失败（HTTP ${res.statusCode}）：${safePath}`);
  }
  if (!Buffer.isBuffer(res.body) || res.body.length > MAX_RESTORE_OBJECT_BYTES) {
    throw new Error(`远程备份对象过大或格式无效：${safePath}`);
  }
  return res.body;
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function snapshotNameFromHref(config, href) {
  let target;
  let snapshotsUrl;
  try {
    snapshotsUrl = new URL(joinUrl(config.baseUrl, config.backupDir, 'snapshots'));
    target = new URL(decodeXmlEntities(href), snapshotsUrl);
  } catch (_) {
    return null;
  }
  if (target.origin !== snapshotsUrl.origin) return null;
  let targetPath;
  let snapshotsPath;
  try {
    targetPath = decodeURIComponent(target.pathname).replace(/\/+$/, '');
    snapshotsPath = decodeURIComponent(snapshotsUrl.pathname).replace(/\/+$/, '');
  } catch (_) {
    return null;
  }
  if (!targetPath.startsWith(`${snapshotsPath}/`)) return null;
  const name = targetPath.slice(snapshotsPath.length + 1);
  if (!name || name.includes('/') || name === 'latest.json' || !name.endsWith('.json')) return null;
  return name;
}

async function listLegacySnapshotNames(config) {
  const propfindBody = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';
  const res = await webdavRequest(
    'PROPFIND',
    joinUrl(config.baseUrl, config.backupDir, 'snapshots'),
    config,
    propfindBody,
    { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(propfindBody) },
  );
  if (res.statusCode === 404) return [];
  if (![200, 207].includes(res.statusCode)) {
    throw new Error(`读取旧快照目录失败（HTTP ${res.statusCode}）`);
  }
  const names = [];
  const hrefPattern = /<(?:[A-Za-z0-9_-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?href>/gi;
  for (const match of String(res.body || '').matchAll(hrefPattern)) {
    const name = snapshotNameFromHref(config, match[1]);
    if (name && !names.includes(name)) names.push(name);
  }
  return names.sort();
}

function snapshotMonthFromLegacy(manifest, filename) {
  if (manifest?.createdAt) {
    try { return snapshotMonthFor(manifest.createdAt); } catch (_) {}
  }
  const match = /^(\d{4})(\d{2})\d{2}-\d{6}(?:-[a-f0-9]+)?\.json$/i.exec(filename);
  const month = Number(match?.[2]);
  if (!match || month < 1 || month > 12) {
    throw new Error(`无法从旧快照确定月份：${filename}`);
  }
  return `${match[1]}-${match[2]}`;
}

function snapshotsMatch(left, right) {
  return !!left && !!right && left.type === 'snapshot' && right.type === 'snapshot' &&
    left.snapshotId === right.snapshotId && left.createdAt === right.createdAt &&
    left.database?.hash === right.database?.hash &&
    JSON.stringify(left.notes || []) === JSON.stringify(right.notes || []);
}

async function copyRemote(config, sourcePath, destinationPath) {
  const res = await webdavRequest(
    'COPY',
    joinUrl(config.baseUrl, config.backupDir, sourcePath),
    config,
    null,
    {
      Destination: joinUrl(config.baseUrl, config.backupDir, destinationPath),
      Overwrite: 'F',
    },
  );
  if (![200, 201, 204].includes(res.statusCode)) {
    throw new Error(`复制快照到月份目录失败（HTTP ${res.statusCode}）：${sourcePath}`);
  }
}

async function deleteRemote(config, relativePath) {
  const res = await webdavRequest('DELETE', joinUrl(config.baseUrl, config.backupDir, relativePath), config);
  if (![200, 204, 404].includes(res.statusCode)) {
    throw new Error(`清理重复旧快照失败（HTTP ${res.statusCode}）：${relativePath}`);
  }
}

async function updateLatestSnapshotPath(config, latest, snapshotPath) {
  const updated = { ...latest, snapshotPath };
  const body = Buffer.from(JSON.stringify(updated, null, 2) + '\n', 'utf8');
  const res = await webdavRequest(
    'PUT',
    joinUrl(config.baseUrl, config.backupDir, 'latest.json'),
    config,
    body,
    { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length },
  );
  if (![200, 201, 204].includes(res.statusCode)) {
    throw new Error(`更新最新快照指针失败（HTTP ${res.statusCode}）`);
  }
}

async function migrateSnapshotFolders(config = getBackupConfig(), options = {}) {
  if (!config.configured) {
    throw new Error('坚果云 WebDAV 未配置完整，请填写账号和应用密码');
  }
  const apply = options.apply === true;
  const latest = await getRemoteJson(config, 'latest.json');
  const names = await listLegacySnapshotNames(config);
  const plans = [];
  for (const name of names) {
    const sourcePath = `snapshots/${name}`;
    const manifest = await getRemoteJson(config, sourcePath);
    if (!manifest) throw new Error(`旧快照在检查期间消失：${sourcePath}`);
    validateRestoreManifest(manifest);
    const month = snapshotMonthFromLegacy(manifest, name);
    const destinationPath = `snapshots/${month}/${name}`;
    const destinationManifest = await getRemoteJson(config, destinationPath);
    if (destinationManifest) {
      validateRestoreManifest(destinationManifest);
      if (!snapshotsMatch(manifest, destinationManifest)) {
        throw new Error(`目标月份目录已有不同内容，迁移已停止：${destinationPath}`);
      }
    }
    plans.push({ sourcePath, destinationPath, month, action: destinationManifest ? 'remove-duplicate' : 'move' });
  }
  const latestPlan = plans.find(plan => plan.sourcePath === latest?.snapshotPath);
  const latestPathUpdate = latestPlan
    ? { from: latestPlan.sourcePath, to: latestPlan.destinationPath }
    : null;

  if (!apply) {
    return {
      success: true,
      dryRun: true,
      legacyCount: plans.length,
      moveCount: plans.filter(plan => plan.action === 'move').length,
      duplicateCount: plans.filter(plan => plan.action === 'remove-duplicate').length,
      latestPathUpdate,
      months: [...new Set(plans.map(plan => plan.month))],
      plans,
    };
  }

  const months = [...new Set(plans.map(plan => plan.month))];
  await ensureRemoteDirs(config, months.map(month => `${config.backupDir}/snapshots/${month}`));
  for (const plan of plans.filter(item => item.action === 'move')) {
    await copyRemote(config, plan.sourcePath, plan.destinationPath);
  }
  if (latestPathUpdate && latest?.type === 'latest-pointer') {
    await updateLatestSnapshotPath(config, latest, latestPathUpdate.to);
  }
  for (const plan of plans) await deleteRemote(config, plan.sourcePath);
  return {
    success: true,
    dryRun: false,
    legacyCount: plans.length,
    moveCount: plans.filter(plan => plan.action === 'move').length,
    duplicateCount: plans.filter(plan => plan.action === 'remove-duplicate').length,
    latestPathUpdate,
    months,
    plans,
  };
}

async function remoteObjectMatches(config, relativePath, localCompressed) {
  if (!Buffer.isBuffer(localCompressed) || localCompressed.length > MAX_RESTORE_OBJECT_BYTES) {
    throw new Error(`本地备份对象过大或格式无效：${relativePath}`);
  }
  const remoteBody = await getRemoteBuffer(config, relativePath);
  if (!remoteBody) return false;
  let localContent;
  let remoteContent;
  try {
    localContent = zlib.gunzipSync(localCompressed, { maxOutputLength: MAX_RESTORE_OBJECT_BYTES });
    remoteContent = zlib.gunzipSync(remoteBody, { maxOutputLength: MAX_RESTORE_OBJECT_BYTES });
  } catch (e) {
    throw new Error(`远程备份对象无法校验：${relativePath}（${e.message}）`);
  }
  return localContent.length === remoteContent.length && sha256(localContent) === sha256(remoteContent);
}

function validHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validateRestoreManifest(manifest) {
  if (!manifest || manifest.type !== 'snapshot' || manifest.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new Error(`不支持的备份清单版本：${manifest?.schemaVersion ?? '未知'}`);
  }
  const database = manifest.database;
  if (!database || !validHash(database.hash) ||
      database.objectPath !== `objects/database/${database.hash}.db.gz`) {
    throw new Error('备份清单中的数据库对象校验信息无效');
  }
  if (!Number.isSafeInteger(database.size) || database.size < 0) {
    throw new Error('备份清单中的数据库大小无效');
  }
  if (database.size > MAX_RESTORE_OBJECT_BYTES) {
    throw new Error(`数据库对象超过恢复大小上限：${MAX_RESTORE_OBJECT_BYTES} bytes`);
  }
  if (!Array.isArray(manifest.notes)) throw new Error('备份清单中的笔记列表无效');
  const noteNames = new Set();
  for (const note of manifest.notes) {
    if (!note || typeof note.name !== 'string' || note.name.length > 255 ||
        path.basename(note.name) !== note.name || note.name === '.' || note.name === '..' ||
        !note.name.endsWith('.md') || noteNames.has(note.name)) {
      throw new Error(`备份清单中的笔记文件名无效：${note?.name ?? ''}`);
    }
    if (!validHash(note.hash) || note.objectPath !== `objects/notes/${note.hash}.md.gz`) {
      throw new Error(`备份清单中的笔记对象校验信息无效：${note.name}`);
    }
    if (!Number.isSafeInteger(note.size) || note.size < 0) {
      throw new Error(`备份清单中的笔记大小无效：${note.name}`);
    }
    if (note.size > MAX_RESTORE_OBJECT_BYTES) {
      throw new Error(`笔记对象超过恢复大小上限：${note.name}`);
    }
    noteNames.add(note.name);
  }
  const totalSize = database.size + manifest.notes.reduce((sum, note) => sum + note.size, 0);
  if (!Number.isSafeInteger(totalSize) || totalSize > MAX_RESTORE_OBJECT_BYTES) {
    throw new Error(`备份清单总大小超过恢复上限：${MAX_RESTORE_OBJECT_BYTES} bytes`);
  }
  return manifest;
}

async function downloadVerifiedObject(config, descriptor, label) {
  const compressed = await getRemoteBuffer(config, descriptor.objectPath);
  if (!compressed) throw new Error(`找不到远程${label}：${descriptor.objectPath}`);
  let content;
  try {
    content = zlib.gunzipSync(compressed, { maxOutputLength: MAX_RESTORE_OBJECT_BYTES });
  } catch (e) {
    throw new Error(`远程${label}解压失败：${e.message}`);
  }
  if (content.length !== descriptor.size || sha256(content) !== descriptor.hash) {
    throw new Error(`远程${label}校验失败：${descriptor.objectPath}`);
  }
  return content;
}

function assertNewRestoreDirectory(outputDir) {
  const resolved = path.resolve(outputDir || '');
  if (!outputDir || resolved === path.parse(resolved).root) {
    throw new Error('恢复目标必须是一个明确的非根目录路径');
  }
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error(`恢复目标的父目录不存在：${parent}`);
  }
  try {
    fs.lstatSync(resolved);
    throw new Error(`恢复目标已存在，为避免覆盖请换一个目录：${resolved}`);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return resolved;
}

function publishRestoreDirectory(stageDir, outputDir) {
  const resolved = assertNewRestoreDirectory(outputDir);
  try {
    // mkdir is the exclusive second check. Unlike rename(stage, target), it
    // cannot replace a directory that appeared after the first check.
    fs.mkdirSync(resolved, { mode: 0o700 });
  } catch (e) {
    if (e.code === 'EEXIST') {
      throw new Error(`恢复目标已存在，为避免覆盖请换一个目录：${resolved}`);
    }
    throw e;
  }

  const targetNotesDir = path.join(resolved, 'notes');
  fs.mkdirSync(targetNotesDir, { mode: 0o700 });
  fs.copyFileSync(
    path.join(stageDir, 'todo.db'),
    path.join(resolved, 'todo.db'),
    fs.constants.COPYFILE_EXCL,
  );
  fs.chmodSync(path.join(resolved, 'todo.db'), 0o600);
  for (const name of fs.readdirSync(path.join(stageDir, 'notes'))) {
    const source = path.join(stageDir, 'notes', name);
    const target = path.join(targetNotesDir, name);
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o600);
  }
  fs.rmSync(stageDir, { recursive: true, force: true });
}

async function restoreBackup(config = getBackupConfig(), options = {}) {
  if (!config.configured) throw new Error('坚果云 WebDAV 未配置完整，请填写账号和应用密码');
  const outputDir = assertNewRestoreDirectory(options.outputDir);
  const requestedSnapshot = options.snapshot || 'latest';
  let snapshotPath = requestedSnapshot;
  let latest = null;
  if (requestedSnapshot === 'latest') {
    latest = await getRemoteJson(config, 'latest.json');
    if (!latest || typeof latest.snapshotPath !== 'string') {
      throw new Error('远程 latest.json 不存在或缺少 snapshotPath');
    }
    snapshotPath = safeRemotePath(latest.snapshotPath, '快照路径');
  } else {
    snapshotPath = safeRemotePath(requestedSnapshot, '快照路径');
  }
  const manifest = validateRestoreManifest(await getRemoteJson(config, snapshotPath));
  if (latest?.databaseHash && latest.databaseHash !== manifest.database.hash) {
    throw new Error('latest.json 与快照中的数据库哈希不一致');
  }

  const parent = path.dirname(outputDir);
  const stageDir = fs.mkdtempSync(path.join(parent, `.${path.basename(outputDir)}.restore-`));
  try {
    const database = await downloadVerifiedObject(config, manifest.database, '数据库对象');
    fs.writeFileSync(path.join(stageDir, 'todo.db'), database, { mode: 0o600 });
    const notesDir = path.join(stageDir, 'notes');
    fs.mkdirSync(notesDir, { mode: 0o700 });
    for (const note of manifest.notes) {
      const content = await downloadVerifiedObject(config, note, `笔记对象 ${note.name}`);
      fs.writeFileSync(path.join(notesDir, note.name), content, { mode: 0o600 });
    }
    // The target is created only after every object has passed its hash check.
    // Exclusive mkdir/copy operations prevent replacing a target that appears
    // between the initial and final existence checks.
    publishRestoreDirectory(stageDir, outputDir);
    return {
      success: true,
      outputDir,
      snapshotPath,
      snapshotId: manifest.snapshotId,
      databaseHash: manifest.database.hash,
      noteCount: manifest.notes.length,
      createdAt: manifest.createdAt,
    };
  } catch (e) {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (_) {}
    throw e;
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
  const createdAt = new Date();
  const snapshotMonth = snapshotMonthFor(createdAt);
  await ensureRemoteDirs(config, [
    config.backupDir,
    `${config.backupDir}/objects/database`,
    `${config.backupDir}/objects/notes`,
    `${config.backupDir}/snapshots`,
    `${config.backupDir}/snapshots/${snapshotMonth}`,
  ]);

  const previous = await readPreviousSnapshot(config);
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
  restoreBackup,
  migrateSnapshotFolders,
};
