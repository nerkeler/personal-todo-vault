'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');

const ROOT = path.resolve(__dirname, '..');
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-release-regression-'));
const DATA_DIR = path.join(TEMP_ROOT, 'data');
const CONFIG_DIR = path.join(TEMP_ROOT, 'config');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CONFIG_DIR, { recursive: true });

const ENV_KEYS = [
  'TODO_DATA_DIR', 'TODO_NOTES_DIR', 'TODO_DB_FILE', 'TODO_CONFIG_DIR',
  'TODO_ALLOWED_ORIGINS', 'TODO_RESTORE_MAX_BYTES',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
process.env.TODO_DATA_DIR = DATA_DIR;
process.env.TODO_NOTES_DIR = path.join(DATA_DIR, 'notes');
process.env.TODO_DB_FILE = path.join(DATA_DIR, 'todo.db');
process.env.TODO_CONFIG_DIR = CONFIG_DIR;
delete process.env.TODO_RESTORE_MAX_BYTES;

const db = require(path.join(ROOT, 'sqlite.js'));

function json(value) {
  return JSON.stringify(value);
}

function hash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sameDayWeekday(date = new Date()) {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

function currentReminderTime(date = new Date()) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function createServerHarness() {
  let handler;
  let sendCalls = 0;
  let sendControl = null;
  const config = {
    email: {
      enabled: true,
      host: 'smtp.invalid',
      port: 465,
      secure: true,
      user: 'synthetic',
      password: 'synthetic',
      recipients: 'audit@example.invalid',
      from: 'audit@example.invalid',
      fromName: 'Audit',
    },
    webdav: {},
  };
  const sendEmail = () => {
    sendCalls += 1;
    if (sendControl) {
      sendControl.startedResolve();
      return sendControl.promise;
    }
    return Promise.resolve({ success: true });
  };
  const modules = {
    './sqlite.js': db,
    './email.js': {
      sendEmail,
      sendTestEmail: async () => ({ success: true }),
    },
    './appConfig.js': {
      getFullConfig: () => config,
      saveAppConfig: () => config,
      publicAppConfig: () => config,
      isEmailConfigured: () => true,
      migrateStoredConfigSecrets: () => {},
    },
    './cloudBackup.js': {
      getBackupConfig: () => ({ configured: false, autoEnabled: false }),
      publicBackupStatus: () => ({ configured: false }),
      inspectRemoteBackup: async () => { throw new Error('坚果云 WebDAV 未配置完整，请填写账号和应用密码'); },
      testBackupConfig: async () => ({ success: true }),
      uploadBackup: async () => ({ success: true }),
      restoreBackup: async () => { throw new Error('坚果云 WebDAV 未配置完整，请填写账号和应用密码'); },
    },
  };
  const context = vm.createContext({
    require: name => modules[name] || require(name.startsWith('./') ? path.join(ROOT, name) : name),
    __dirname: ROOT,
    process: {
      env: {
        PORT: '8238',
        HOST: '127.0.0.1',
        TODO_DATA_DIR: DATA_DIR,
        TODO_NOTES_DIR: path.join(DATA_DIR, 'notes'),
        TODO_DB_FILE: path.join(DATA_DIR, 'todo.db'),
        TODO_CONFIG_DIR: CONFIG_DIR,
        TODO_ALLOWED_ORIGINS: 'https://todo.example.test',
      },
      pid: process.pid,
    },
    console,
    Buffer,
    URL,
    setInterval: () => null,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
  });
  context.http = undefined;
  context.require = name => {
    if (name === 'http') {
      return {
        createServer: callback => {
          handler = callback;
          return { listen() {}, on() {} };
        },
      };
    }
    return modules[name] || require(name.startsWith('./') ? path.join(ROOT, name) : name);
  };
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').split('\nbootstrap();')[0];
  vm.runInContext(source, context, { filename: path.join(ROOT, 'server.js') });

  function gateEmail() {
    let resolve;
    let startedResolve;
    const promise = new Promise(result => { resolve = result; });
    const started = new Promise(result => { startedResolve = result; });
    sendControl = { promise, resolve, startedResolve };
    return {
      started,
      release(value = { success: true }) {
        const control = sendControl;
        sendControl = null;
        control.resolve(value);
      },
    };
  }

  return {
    context,
    get handler() { return handler; },
    get sendCalls() { return sendCalls; },
    gateEmail,
  };
}

async function request(harness, method, requestUrl, payload, headers = {}) {
  const requestBody = payload === undefined ? [] : [json(payload)];
  const req = Readable.from(requestBody);
  Object.assign(req, {
    method,
    url: requestUrl,
    headers: { host: 'todo.internal:8238', ...headers },
    socket: { encrypted: false },
  });
  let resolveResponse;
  const responseDone = new Promise(resolve => { resolveResponse = resolve; });
  const res = {
    headers: {},
    status: 200,
    writableEnded: false,
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headersToAdd = {}) {
      this.status = status;
      Object.assign(this.headers, headersToAdd);
    },
    end(body = '') {
      this.writableEnded = true;
      this.rawBody = body;
      resolveResponse();
    },
  };
  const result = harness.handler(req, res);
  await Promise.all([Promise.resolve(result), responseDone]);
  let body = res.rawBody;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  try { body = JSON.parse(body); } catch (_) {}
  return { status: res.status, headers: res.headers, body };
}

async function createReminderTodo(harness, title, mode = 'once', repeatCount = 1) {
  const created = await request(harness, 'POST', '/api/todos', {
    title,
    categoryId: 'cat_default',
  });
  assert.equal(created.status, 200);
  const reminder = {
    reminderEnabled: true,
    reminderTime: currentReminderTime(),
    reminderMode: mode,
    reminderWeekdays: mode === 'once' ? [] : [sameDayWeekday()],
    reminderRepeatCount: repeatCount,
    creatorEmail: 'audit@example.invalid',
  };
  const updated = await request(harness, 'PATCH', `/api/todos/${created.body.id}`, reminder);
  assert.equal(updated.status, 200);
  return created.body.id;
}

async function testServer() {
  await db.initDB();
  const harness = createServerHarness();

  assert.equal((await request(harness, 'GET', '/')).status, 200, '根页面应可访问');
  assert.equal((await request(harness, 'GET', '/server.js')).status, 404, '源码不应由静态处理器暴露');
  assert.equal((await request(harness, 'GET', '/%2e%2e/server.js')).status, 404, '编码路径逃逸应被拒绝');

  assert.equal((await request(harness, 'GET', '/api/todos', undefined, {
    origin: 'http://todo.internal:8238',
  })).status, 200, '同源 HTTP 请求应可访问');
  assert.equal((await request(harness, 'GET', '/api/todos', undefined, {
    origin: 'https://todo.example.test',
  })).status, 200, '显式配置的 HTTPS 反代来源应可访问');
  assert.equal((await request(harness, 'GET', '/api/todos', undefined, {
    origin: 'https://evil.example.test',
    'x-forwarded-proto': 'https',
  })).status, 403, '未配置来源即使伪造 X-Forwarded-Proto 也应被拒绝');
  assert.equal((await request(harness, 'GET', '/api/todos', undefined, {
    origin: 'https://todo.example.test.evil',
  })).status, 403, '相似但未列入白名单的来源应被拒绝');
  assert.equal((await request(harness, 'GET', '/api/todos', undefined, {
    origin: 'null',
  })).status, 403, 'null Origin 应被拒绝');
  assert.equal((await request(harness, 'POST', '/api/backup/restore', { snapshot: 'latest' })).status, 500, '未配置云端备份时恢复应明确失败');
  assert.equal((await request(harness, 'POST', '/api/backup/sync')).status, 500, '未配置云端备份时同步应明确失败');

  const priorityCreated = await request(harness, 'POST', '/api/todos', {
    title: 'priority regression',
    categoryId: 'cat_default',
  });
  assert.equal(priorityCreated.status, 200);
  assert.equal(priorityCreated.body.priority, 0, '新待办默认应为普通重要程度');
  const expectedDueDate = '2026-09-18';
  const expectedDueTime = '09:30';
  const dueDateCreated = await request(harness, 'POST', '/api/todos', {
    title: 'due date regression',
    categoryId: 'cat_default',
    dueDate: expectedDueDate,
    dueTime: expectedDueTime,
  });
  assert.equal(dueDateCreated.status, 200);
  assert.equal(dueDateCreated.body.dueDate, expectedDueDate, '新待办应保存预期完成日期');
  assert.equal(dueDateCreated.body.dueTime, expectedDueTime, '新待办应保存预期完成时间');
  const defaultDueDateCreated = await request(harness, 'POST', '/api/todos', {
    title: 'default due date regression',
    categoryId: 'cat_default',
  });
  const now = new Date();
  const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  assert.equal(defaultDueDateCreated.body.dueDate, localToday, '未指定日期时应默认使用当天');
  assert.equal(defaultDueDateCreated.body.dueTime, '', '未指定时间时应保持为空');
  const dueDateUpdated = await request(harness, 'PATCH', `/api/todos/${dueDateCreated.body.id}`, { dueDate: '2026-09-19', dueTime: '18:45' });
  assert.equal(dueDateUpdated.status, 200);
  assert.equal(dueDateUpdated.body.dueDate, '2026-09-19', '预期完成日期应支持修改');
  assert.equal(dueDateUpdated.body.dueTime, '18:45', '预期完成时间应支持修改');
  const invalidDueDate = await request(harness, 'PATCH', `/api/todos/${dueDateCreated.body.id}`, { dueDate: '2026-02-30' });
  assert.equal(invalidDueDate.status, 400, '无效预期完成日期应被拒绝');
  const invalidDueTime = await request(harness, 'PATCH', `/api/todos/${dueDateCreated.body.id}`, { dueTime: '25:99' });
  assert.equal(invalidDueTime.status, 400, '无效预期完成时间应被拒绝');
  const priorityUpdated = await request(harness, 'PATCH', `/api/todos/${priorityCreated.body.id}`, { priority: 2 });
  assert.equal(priorityUpdated.status, 200);
  assert.equal(priorityUpdated.body.priority, 2, '待办应支持更新重要程度');
  const invalidPriority = await request(harness, 'PATCH', `/api/todos/${priorityCreated.body.id}`, { priority: 3 });
  assert.equal(invalidPriority.status, 400, '非法重要程度应被拒绝');

  const noOpId = await createReminderTodo(harness, 'no-op reminder', 'count', 4);
  db.updateTodo(noOpId, { reminderSentCount: 2, reminderLastSentAt: '' });
  const noOp = await request(harness, 'PATCH', `/api/todos/${noOpId}`, {
    reminderEnabled: true,
    reminderTime: currentReminderTime(),
    reminderMode: 'count',
    reminderWeekdays: [sameDayWeekday()],
    reminderRepeatCount: 4,
  });
  assert.equal(noOp.body.reminderSentCount, 2, '相同提醒规则保存不得清零计数');
  assert.equal(noOp.body.reminderLastSentAt, '', '相同提醒规则保存不得清空发送时间');
  db.updateTodo(noOpId, { reminderEnabled: false });

  const completionId = await createReminderTodo(harness, 'completion while sending');
  const completionGate = harness.gateEmail();
  const completionTick = vm.runInContext('runReminderTick()', harness.context);
  await completionGate.started;
  await request(harness, 'PATCH', `/api/todos/${completionId}`, { completed: true, progress: 100 });
  completionGate.release();
  await completionTick;
  const completed = db.getTodos().find(todo => todo.id === completionId);
  assert.equal(completed.completed, true);
  assert.equal(completed.reminderSentCount, 0, '完成期间旧发送不能回写计数');
  const reopened = await request(harness, 'PATCH', `/api/todos/${completionId}`, { completed: false, progress: 0 });
  assert.equal(reopened.body.reminderEnabled, false, '完成后重新打开不得恢复旧提醒状态');

  const closeId = await createReminderTodo(harness, 'disable while sending');
  const closeGate = harness.gateEmail();
  const closeTick = vm.runInContext('runReminderTick()', harness.context);
  await closeGate.started;
  await request(harness, 'PATCH', `/api/todos/${closeId}`, { reminderEnabled: false });
  closeGate.release();
  await closeTick;
  const closed = db.getTodos().find(todo => todo.id === closeId);
  assert.equal(closed.reminderEnabled, false);
  assert.equal(closed.reminderSentCount, 0, '关闭期间旧发送不能回写计数');

  const concurrentId = await createReminderTodo(harness, 'concurrent reminder');
  const callsBefore = harness.sendCalls;
  const concurrentGate = harness.gateEmail();
  const firstTick = vm.runInContext('runReminderTick()', harness.context);
  await concurrentGate.started;
  const secondTick = vm.runInContext('runReminderTick()', harness.context);
  await secondTick;
  concurrentGate.release();
  await firstTick;
  assert.equal(harness.sendCalls, callsBefore + 1, '同一任务并发检查只能发送一次');
  assert.equal(db.getTodos().find(todo => todo.id === concurrentId).reminderSentCount, 1);
}

function createCloudContext(requestImpl) {
  const context = vm.createContext({
    require: name => require(name.startsWith('./') ? path.join(ROOT, name) : name),
    module: { exports: {} },
    process: { env: { TODO_RESTORE_MAX_BYTES: '' } },
    Buffer,
    URL,
    console,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'cloudBackup.js'), 'utf8'), context, {
    filename: path.join(ROOT, 'cloudBackup.js'),
  });
  context.mockRequest = requestImpl;
  vm.runInContext('webdavRequest = mockRequest', context);
  return context;
}

async function testCloudBackup() {
  const baseUrl = 'https://mock.invalid/dav/';
  const config = {
    configured: true,
    baseUrl,
    backupDir: 'audit',
    username: 'synthetic',
    password: 'synthetic',
  };
  const objects = new Map();
  const requests = [];
  const requestImpl = async (method, targetUrl, _config, body, _headers, options = {}) => {
    const key = new URL(targetUrl).pathname;
    requests.push({ method, key, options });
    if (method === 'MKCOL') return { statusCode: 201, body: '' };
    if (method === 'PUT') {
      objects.set(key, Buffer.from(body || ''));
      return { statusCode: 201, body: '' };
    }
    if (!objects.has(key)) return { statusCode: 404, body: options.binary ? Buffer.alloc(0) : '' };
    const value = objects.get(key);
    if (method === 'HEAD') return { statusCode: 200, body: '' };
    return { statusCode: 200, body: options.binary ? Buffer.from(value) : value.toString('utf8') };
  };
  const context = createCloudContext(requestImpl);

  const generatedSnapshotPath = vm.runInContext(
    "snapshotPathFor(new Date(2026, 8, 8, 12, 34, 56), 'snapshot-test')",
    context,
  );
  assert.equal(generatedSnapshotPath, 'snapshots/2026-09/snapshot-test.json', '新快照应按月份归档');

  const dbContent = Buffer.from('synthetic database bytes');
  const noteContent = Buffer.from('# synthetic note\n');
  const databaseHash = hash(dbContent);
  const noteHash = hash(noteContent);
  const manifest = {
    schemaVersion: 2,
    app: 'todo-app',
    type: 'snapshot',
    snapshotId: 'synthetic-snapshot',
    createdAt: new Date().toISOString(),
    source: { rootDir: 'data', dbFile: 'todo.db', notesDir: 'notes' },
    strategy: 'content-addressed-incremental',
    database: {
      name: 'todo.db',
      hash: databaseHash,
      objectPath: `objects/database/${databaseHash}.db.gz`,
      size: dbContent.length,
    },
    notes: [{
      name: 'synthetic.md',
      hash: noteHash,
      objectPath: `objects/notes/${noteHash}.md.gz`,
      size: noteContent.length,
    }],
  };
  const latest = {
    schemaVersion: 2,
    app: 'todo-app',
    type: 'latest-pointer',
    snapshotPath: 'snapshots/synthetic-snapshot.json',
    databaseHash,
  };
  const remoteKey = relative => `/dav/audit/${relative}`;
  objects.set(remoteKey('latest.json'), Buffer.from(json(latest)));
  objects.set(remoteKey('snapshots/synthetic-snapshot.json'), Buffer.from(json(manifest)));
  objects.set(remoteKey(manifest.database.objectPath), zlib.gzipSync(dbContent));
  objects.set(remoteKey(manifest.notes[0].objectPath), zlib.gzipSync(noteContent));

  const restoredPath = path.join(TEMP_ROOT, 'restored-cloud');
  const restored = await context.module.exports.restoreBackup(config, { outputDir: restoredPath });
  assert.equal(restored.noteCount, 1);
  assert.deepEqual(fs.readFileSync(path.join(restoredPath, 'todo.db')), dbContent);
  assert.deepEqual(fs.readFileSync(path.join(restoredPath, 'notes', 'synthetic.md')), noteContent);
  const inspected = await context.module.exports.inspectRemoteBackup(config);
  assert.equal(inspected.state, 'valid', '已有有效目录应能完成云端预检');
  assert.equal(inspected.noteCount, 1);
  objects.set(remoteKey('latest.json'), Buffer.from(json(manifest)));
  const directRestorePath = path.join(TEMP_ROOT, 'direct-cloud');
  const directRestore = await context.module.exports.restoreBackup(config, { outputDir: directRestorePath });
  assert.equal(directRestore.snapshotPath, 'latest.json', '直接快照格式应能被恢复流程兼容');
  objects.set(remoteKey('latest.json'), Buffer.from(json(latest)));
  assert(requests.some(item => item.key.endsWith('/latest.json') && item.options.maxResponseBytes === 128 * 1024 * 1024));
  assert(requests.some(item => item.options.binary && item.options.maxResponseBytes === 128 * 1024 * 1024));
  await assert.rejects(
    context.module.exports.restoreBackup(config, { outputDir: restoredPath }),
    /已存在/,
    '恢复工具不得覆盖已有目录',
  );

  objects.set(remoteKey(manifest.notes[0].objectPath), Buffer.from('corrupted object'));
  const corruptPath = path.join(TEMP_ROOT, 'corrupt-cloud');
  await assert.rejects(context.module.exports.restoreBackup(config, { outputDir: corruptPath }));
  assert.equal(fs.existsSync(corruptPath), false, '对象校验失败时不得发布恢复目录');

  const oversized = {
    ...manifest,
    snapshotId: 'oversized',
    database: {
      ...manifest.database,
      size: 128 * 1024 * 1024 + 1,
    },
  };
  objects.set(remoteKey('latest.json'), Buffer.from(json({ ...latest, snapshotPath: 'snapshots/oversized.json' })));
  objects.set(remoteKey('snapshots/oversized.json'), Buffer.from(json(oversized)));
  const oversizedPath = path.join(TEMP_ROOT, 'oversized-cloud');
  await assert.rejects(context.module.exports.restoreBackup(config, { outputDir: oversizedPath }), /上限/);
  assert.equal(fs.existsSync(oversizedPath), false);

  const sameContent = Buffer.from('same content');
  const sameCompressed = zlib.gzipSync(sameContent);
  const validConflict = createCloudContext(async (method, targetUrl, _config, body, _headers, options = {}) => {
    if (method === 'HEAD') return { statusCode: 404, body: '' };
    if (method === 'PUT') return { statusCode: 409, body: 'Conflict' };
    if (method === 'GET') return { statusCode: 200, body: options.binary ? sameCompressed : sameCompressed.toString('utf8') };
    return { statusCode: 404, body: '' };
  });
  const reused = await vm.runInContext(
    "putObjectIfMissing({baseUrl:'https://mock.invalid/dav/',backupDir:'audit',username:'u',password:'p'},'objects/a.gz',zlib.gzipSync(Buffer.from('same content')),'application/gzip')",
    Object.assign(validConflict, { zlib }),
  );
  assert.equal(reused.reused, true, '409 只有在远程对象内容校验一致时才可复用');

  const invalidConflict = createCloudContext(async method => {
    if (method === 'HEAD') return { statusCode: 404, body: '' };
    if (method === 'PUT') return { statusCode: 409, body: 'Conflict' };
    return { statusCode: 404, body: '' };
  });
  await assert.rejects(vm.runInContext(
    "putObjectIfMissing({baseUrl:'https://mock.invalid/dav/',backupDir:'audit',username:'u',password:'p'},'objects/a.gz',Buffer.from('not gzip'),'application/gzip')",
    invalidConflict,
  ), /冲突|远程/);

  const authContext = createCloudContext(async method => {
    if (method === 'MKCOL') return { statusCode: 401, body: '' };
    return { statusCode: 404, body: '' };
  });
  await assert.rejects(
    authContext.module.exports.testBackupConfig(config),
    /坚果云认证失败.*第三方应用密码/,
    'WebDAV 401 应提示认证问题而不是目录冲突',
  );

  const legacyName = '20260808-123456-abcd1234.json';
  const migrationObjects = new Map();
  const migrationRequests = [];
  const legacyManifest = {
    ...manifest,
    snapshotId: 'legacy-snapshot',
    createdAt: '2026-08-08T04:34:56.000Z',
  };
  migrationObjects.set(remoteKey(`snapshots/${legacyName}`), Buffer.from(json(legacyManifest)));
  migrationObjects.set(remoteKey('latest.json'), Buffer.from(json({
    schemaVersion: 2,
    app: 'todo-app',
    type: 'latest-pointer',
    snapshotPath: `snapshots/${legacyName}`,
    databaseHash,
  })));
  const migrationContext = createCloudContext(async (method, targetUrl, _config, body, headers = {}, options = {}) => {
    const url = new URL(targetUrl);
    const key = url.pathname;
    migrationRequests.push({ method, key });
    if (method === 'PROPFIND') {
      const legacyPaths = [...migrationObjects.keys()]
        .filter(item => new RegExp(`/dav/audit/snapshots/[^/]+\\.json$`).test(item));
      const hrefs = ['/dav/audit/snapshots/', ...legacyPaths];
      return {
        statusCode: 207,
        body: `<d:multistatus xmlns:d="DAV:">${hrefs.map(href => `<d:response><d:href>${href}</d:href></d:response>`).join('')}</d:multistatus>`,
      };
    }
    if (method === 'MKCOL') return { statusCode: 201, body: '' };
    if (method === 'PUT') {
      migrationObjects.set(key, Buffer.from(body || ''));
      return { statusCode: 200, body: '' };
    }
    if (method === 'COPY') {
      const destination = new URL(headers.Destination).pathname;
      const value = migrationObjects.get(key);
      if (!value) return { statusCode: 404, body: '' };
      if (migrationObjects.has(destination)) return { statusCode: 412, body: 'exists' };
      migrationObjects.set(destination, value);
      return { statusCode: 201, body: '' };
    }
    if (method === 'DELETE') {
      migrationObjects.delete(key);
      return { statusCode: 204, body: '' };
    }
    if (!migrationObjects.has(key)) return { statusCode: 404, body: options.binary ? Buffer.alloc(0) : '' };
    const value = migrationObjects.get(key);
    if (method === 'HEAD') return { statusCode: 200, body: '' };
    return { statusCode: 200, body: options.binary ? Buffer.from(value) : value.toString('utf8') };
  });
  const migrationConfig = { ...config };
  const preview = await migrationContext.migrateSnapshotFolders(migrationConfig, { apply: false });
  assert.equal(preview.legacyCount, 1, '迁移预览应发现根目录旧快照');
  assert.equal(preview.moveCount, 1, '迁移预览应生成移动计划');
  assert.equal(preview.plans[0].destinationPath, `snapshots/2026-08/${legacyName}`);
  assert.equal(preview.latestPathUpdate.to, `snapshots/2026-08/${legacyName}`, '迁移预览应包含 latest 指针更新');
  assert(migrationObjects.has(remoteKey(`snapshots/${legacyName}`)), '预览不得移动旧快照');

  const migrated = await migrationContext.migrateSnapshotFolders(migrationConfig, { apply: true });
  assert.equal(migrated.moveCount, 1, '迁移应移动旧快照');
  assert.equal(migrationObjects.has(remoteKey(`snapshots/${legacyName}`)), false, '迁移后旧路径应消失');
  assert(migrationObjects.has(remoteKey(`snapshots/2026-08/${legacyName}`)), '迁移后应存在月份目录快照');
  assert.equal(JSON.parse(migrationObjects.get(remoteKey('latest.json')).toString()).snapshotPath, `snapshots/2026-08/${legacyName}`, '迁移后 latest 指针应指向新路径');
  assert(migrationRequests.some(item => item.method === 'COPY'), '迁移应先复制到月份目录');
  assert(migrationRequests.some(item => item.method === 'DELETE'), '迁移应在指针更新后删除旧路径');
  const secondRun = await migrationContext.migrateSnapshotFolders(migrationConfig, { apply: true });
  assert.equal(secondRun.legacyCount, 0, '迁移脚本应可重复执行');
}

async function testFrontend() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert(scripts.length > 0);
  new Function(scripts[scripts.length - 1]);
  assert.doesNotMatch(html, /id="themeSettingsSection"[^>]*\bopen\b/, '配置分组默认不应展开');
  assert.match(html, /resetSettingsDisclosure\(\)/, '打开配置中心前应重置为折叠状态');
  assert.match(html, /class="todo-priority-tag priority-/, '待办应展示重要程度标签');
  assert.match(html, /function togglePriorityDropdown\(/, '重要程度标签应提供选择浮层');
  assert.match(html, /id="addPriorityBtn" onclick="toggleAddPriorityDropdown\(event\)"/, '新增待办应提供重要程度选择');
  assert.match(html, /function setAddPriority\(/, '新增待办重要程度应可切换');
  assert.match(html, /JSON\.stringify\(\{ title, categoryId, priority: selectedAddPriority, dueDate: selectedAddDueDate \|\| todayDateKey\(\), dueTime: selectedAddDueTime \|\| '' \}\)/, '新增待办应提交预期完成日期和时间');
  assert.match(html, /class="todo-labels"[\s\S]*todo-cat-tag[\s\S]*priorityTagMarkup\(t\)[\s\S]*periodBadge/, '待办标签顺序应为分类、重要程度、时间范围');
  assert.match(html, /const dueKey = todoDueDateKey\(t\)[\s\S]*daysUntilDue[\s\S]*已逾期[\s\S]*明日/, '待办时间标签应优先按预期完成日期显示相对状态');
  assert.match(html, /class="todo-dates"[\s\S]*todo-date-created[\s\S]*todo-date-divider[\s\S]*todo-date-updated/, '创建和更新时间应归入独立信息组');
  assert.match(html, /\.todo-priority-tag \{[\s\S]*width: 72px;[\s\S]*min-width: 72px;/, '重要程度标签应保持紧凑的统一宽度');
  assert.match(html, /\.todo-cat-tag \{[\s\S]*min-width: 72px[\s\S]*height: 22px;/, '分类标签应与其他标签保持统一尺寸');
  assert.match(html, /\.period-badge \{[\s\S]*min-width: 72px[\s\S]*height: 22px;/, '时间范围标签应与其他标签保持统一尺寸');
  assert.match(html, /class="priority-dot priority-dot-\$\{meta\.className\}"/, '重要程度应统一使用颜色圆点');
  assert.match(html, /\.todo-priority-tag \{[\s\S]*justify-content: center;/, '重要程度文字应在标签内居中');
  assert.match(html, /\.todo-priority-tag \.priority-dot \{[\s\S]*position: absolute;/, '重要程度圆点不应影响文字居中');
  assert.match(html, /@media \(max-width: 768px\) \{[\s\S]*\.add-row \{[\s\S]*display: grid;[\s\S]*grid-template-columns: minmax\(0, 3fr\) minmax\(0, 3fr\) minmax\(0, 2fr\);[\s\S]*\.add-input-wrap \{ grid-column: 1 \/ -1;/, '移动端分类、重要程度和添加按钮应按 3:3:2 比例保持同一行');
  assert.match(html, /function toggleCatPicker\([\s\S]*const rect = btn\.getBoundingClientRect\(\);[\s\S]*const edge = 8;[\s\S]*list\.style\.top = \(rect\.bottom \+ 4\) \+ 'px';[\s\S]*const menuHeight = Math\.min\(list\.scrollHeight, parseFloat\(list\.style\.maxHeight\)\);/, '移动端分类下拉框应锚定按钮并在空间不足时翻转');
  assert.match(html, /function closeCatPicker\([\s\S]*catPickerList[\s\S]*catPickerBtn/, '分类下拉框应提供统一关闭入口');
  assert.match(html, /function toggleCatPicker\([\s\S]*closePriorityDropdown\(\);[\s\S]*closeMoveDropdown\(\);/, '打开分类下拉框前应关闭其他下拉框');
  assert.match(html, /function toggleAddPriorityDropdown\([\s\S]*closeCatPicker\(\);/, '打开新增重要程度下拉框前应关闭分类下拉框');
  assert.match(html, /function togglePriorityDropdown\([\s\S]*closeCatPicker\(\);/, '打开待办重要程度下拉框前应关闭分类下拉框');
  assert.match(html, /function toggleMoveDropdown\([\s\S]*closeCatPicker\(\);/, '打开待办分类下拉框前应关闭新增分类下拉框');
  assert.doesNotMatch(html, /@media \(max-width: 768px\) \{[\s\S]*\.cat-picker-list \{[\s\S]*bottom: 0;/, '移动端分类下拉框不应固定在屏幕底部');
  assert.match(html, /\.cat-picker-btn \{[\s\S]*flex: 0 1 auto;[\s\S]*width: fit-content;[\s\S]*min-width: 112px;[\s\S]*max-width: 200px;/, '分类按钮应按内容动态调整宽度并保留合理边界');
  assert.match(html, /\.cat-picker-btn #catPickerLabel \{[\s\S]*position: static;[\s\S]*justify-content: center;[\s\S]*gap: 6px;[\s\S]*padding: 0;/, '分类按钮图标和文字应保持整体居中');
  assert.match(html, /\.cat-picker-btn #catPickerLabel \.ui-icon \{[\s\S]*position: static;/, '分类图标应随文字一起居中');
  assert.match(html, /\.cat-picker-btn \.arrow \{[\s\S]*position: static;[\s\S]*flex: 0 0 auto;/, '分类下拉箭头应与内容保持稳定对齐');
  assert.match(html, /\.category-icon-slot \{[\s\S]*display: inline-flex;[\s\S]*align-items: center;[\s\S]*justify-content: center;/, '分类图标应使用统一的对齐槽位');
  assert.match(html, /--main-max: 920px;/, '主内容区应保留常规桌面的基础宽度');
  assert.match(html, /class="settings-badge theme-status-badge" id="themeStatusBadge"/, '外观状态应使用已配置风格');
  assert.match(html, /\.settings-badge\.theme-status-badge \{[\s\S]*background: rgba\(82,196,26,0\.12\);[\s\S]*color: #52c41a;/, '外观状态应与已配置保持绿色配色');
  assert.match(html, /id="viewModeList"[\s\S]*id="viewModeDay"[\s\S]*id="viewModeMonth"[\s\S]*id="helpBtn"/, '日月视图按钮应位于使用说明左侧');
  assert.match(html, /view-switch-btn view-list[\s\S]*view-switch-btn view-day[\s\S]*view-switch-btn view-month/, '日月视图按钮应使用有区分度的语义颜色');
  assert.match(html, /function setViewMode\(mode\)[\s\S]*renderViewSwitcher\(\)[\s\S]*render\(/, '视图按钮应切换并重新渲染当前视图');
  assert.match(html, /id="calendarView" hidden/, '日月视图应使用独立的视图容器');
  assert.match(html, /id="addDueDateBtn"[\s\S]*id="addDueDatePicker"[\s\S]*id="addDueHourInput"[\s\S]*id="addDueMinuteInput"/, '新增待办应提供应用内日期时间选择器');
  assert.doesNotMatch(html, /id="addDueDateInput"[^>]*type="date"/, '预期完成时间不得调用系统日期选择器');
  assert.doesNotMatch(html, /<select[^>]+id="addDue(?:Hour|Minute)Input"/, '小时和分钟不得调用系统下拉列表');
  assert.match(html, /function renderAddDueDatePicker\(/, '预期完成时间应由应用内日历渲染');
  assert.match(html, /function handleAddDueTimeChange\(/, '预期完成时间应支持小时和分钟');
  assert.match(html, /id="addDueTimeMenu"[\s\S]*function toggleAddDueTimeMenu\([\s\S]*每 5 分钟/, '小时和分钟应使用紧凑的应用内选择面板');
  assert.match(html, /function renderCalendarView\(filtered, pending, completed\)[\s\S]*viewMode === 'day'[\s\S]*月视图/, '日月视图应提供基础日历结构');
  assert.match(html, /function todoDueDateKey\(todo\)[\s\S]*isValidDateKey\(value\)/, '日月视图应优先识别预期完成日期');
  assert.match(html, /function todoCalendarDateKey\(todo\)[\s\S]*todoDueDateKey\(todo\)[\s\S]*todoCreatedDateKey\(todo\)/, '旧待办应在没有预期完成日期时回退到创建日期');
  assert.match(html, /onclick="openCalendarDay\('\$\{key\}'\)"/, '月视图日期格应可进入对应日视图');
  assert.match(html, /\.calendar-weekday\.is-weekend|calendar-weekday\$\{index === 0 \|\| index === 6 \?/, '月视图周末列应有独立标识');
  assert.match(html, /function shiftCalendarDate\(|function resetCalendarToToday\(/, '日月视图应提供日期导航');
  assert.match(html, /onclick="resetCalendarToToday\(\)"[\s\S]*回到今天/, '月视图应明确回到今天的动作');
  assert.match(html, /\.calendar-month-title \{[\s\S]*color: var\(--primary\);[\s\S]*font-size: 1\.3rem;/, '当前月份应作为月视图的醒目标题');
  assert.match(html, /color-mix\(in srgb, var\(--primary-light\) 72%/, '月视图周末列应使用连续的浅色背景带');
  assert.match(html, /function renderCalendarTaskRows\(tasks\)[\s\S]*tasks\.map\(makeTodoItem\)/, '日月视图下方应复用普通待办卡片');
  assert.match(html, /calendar-task-card-list/, '日月视图待办应使用卡片列表容器');
  assert.match(html, /\.calendar-task-card-list \{[\s\S]*background: var\(--surface\);/, '日月视图分组背景应与待办卡片统一');
  assert.match(html, /\.main \{[\s\S]*min-height: 100vh;[\s\S]*display: flex;[\s\S]*flex-direction: column;/, '页面内容不足时页脚应由弹性布局推到页面底部');
  assert.match(html, /日视图优先按预期完成日期归类|月视图优先按预期完成日期归类/, '日月视图应明确预期完成日期规则');
  assert.match(html, /id="syncBackupBtn" onclick="openBackupSyncModal\(\)"/, '备份设置应提供云端同步入口');
  assert.match(html, /id="backupActionHint" aria-live="polite"/, '备份操作区应明确说明保存配置与首次同步顺序');
  assert.match(html, /function inspectBackupBeforeSync\([\s\S]*fetch\(API \+ '\/backup\/inspect'/, '开始同步前应先检查云端备份状态');
  assert.match(html, /连接测试成功，请点击“保存配置”/, '测试成功后应明确引导保存配置');
  assert.match(html, /id="backupSyncModal"[\s\S]*与云端同步[\s\S]*开始同步/, '云端同步应使用应用内确认弹窗');
  assert.match(html, /function confirmBackupSync\(\)[\s\S]*fetch\(API \+ '\/backup\/sync'/, '同步确认应调用合并同步接口');
  assert.doesNotMatch(html, /function confirmBackupSync\(\)[\s\S]*\bconfirm\(/, '云端同步不应使用系统 confirm 弹窗');
  assert.match(html, /本地新增和云端新增都会保留|双方新增内容/, '同步入口应说明双方新增内容都会保留');
  assert.match(html, /\.main \{[\s\S]*--main-max: 920px;[\s\S]*margin-left: max\(var\(--sidebar-w\), calc\(var\(--sidebar-w\) \+ \(100vw - var\(--sidebar-w\) - var\(--main-max\)\) \/ 2\)\);[\s\S]*max-width: var\(--main-max\)/, '主内容区应在侧栏右侧的可用区域内居中');
  assert.match(html, /@media \(min-width: 1366px\) \{[\s\S]*\.main \{ --main-max: 1120px; \}/, '宽屏主内容区应适度扩宽');
  assert.match(html, /@media \(min-width: 1680px\) \{[\s\S]*\.main \{ --main-max: 1320px; \}/, '大屏主内容区应有更高但有限的宽度上限');
  assert.match(html, /@media \(max-width: 768px\) \{[\s\S]*\.todo-item \{[\s\S]*display: grid;[\s\S]*grid-template-columns: 20px minmax\(0, 1fr\);[\s\S]*row-gap: 6px;[\s\S]*padding: 10px 12px;/, '移动端待办应收紧卡片垂直边距');
  assert.match(html, /@media \(max-width: 768px\) \{[\s\S]*\.todo-item > \.todo-body \{[\s\S]*display: contents;/, '移动端待办主体应允许标题、进度和元信息参与稳定排版');
  assert.match(html, /@media \(max-width: 768px\) \{[\s\S]*\.todo-body > \.todo-text,[\s\S]*\.todo-body > \.todo-title-editor \{[\s\S]*grid-column: 2;[\s\S]*grid-row: 1;/, '移动端待办标题应位于卡片顶部');
  assert.match(html, /@media \(max-width: 768px\) \{[\s\S]*\.todo-actions \{[\s\S]*display: none;/, '移动端默认应隐藏卡片操作栏');
  assert.match(html, /id="mobile-action-menu-portal"[\s\S]*id="mobile-action-menu-grid"/, '移动端应提供应用内操作菜单');
  assert.doesNotMatch(html, /id="mobile-action-menu-title"/, '移动端操作菜单不应重复显示待办标题');
  assert.match(html, /\.mobile-action-menu-grid \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/, '移动端操作菜单应使用单列布局');
  assert.match(html, /const MOBILE_LONG_PRESS_MS = 560;/, '移动端长按应使用稳定的触发时长');
  assert.match(html, /function initMobileActionMenu\([\s\S]*pointerdown[\s\S]*pointermove[\s\S]*Math\.hypot\(movedX, movedY\) > 10[\s\S]*pointerup/, '移动端长按应支持滑动取消并避免影响滚动');
  assert.match(html, /function openMobileActionMenu\(todoItem, anchor = \{\}\)[\s\S]*sourceButtons[\s\S]*sourceButton\.click\(\)/, '移动端菜单应复用原有操作按钮行为');
  assert.match(html, /const anchorX = Number\.isFinite\(anchor\.x\)[\s\S]*const anchorY = Number\.isFinite\(anchor\.y\)/, '移动端操作菜单应锚定触发位置');
  assert.match(html, /function closeMobileActionMenu\([\s\S]*mobile-action-menu-open[\s\S]*menu\.hidden = true/, '移动端操作菜单应提供统一关闭入口');
  assert.match(html, /event\.key === 'Escape'[\s\S]*closeMobileActionMenu\(\)/, '移动端操作菜单应支持 Escape 关闭');
  assert.match(html, /document\.addEventListener\('contextmenu', event => \{[\s\S]*event\.preventDefault\(\);[\s\S]*openMobileActionMenu\(todoItem, \{ x: event\.clientX, y: event\.clientY \}\)/, '移动端鼠标右键应在点击位置复用长按操作菜单');
  assert.match(html, /openMobileActionMenu\(todoItem, \{ x: state\.x, y: state\.y \}\)/, '移动端长按菜单应在手指按住的位置打开');
  assert.match(html, /document\.addEventListener\('scroll', closeMobileActionMenu, \{ capture: true, passive: true \}\)/, '页面滚动时应关闭固定定位的移动端操作菜单');
  assert.match(html, /@media \(max-width: 768px\) \{[\s\S]*\.todo-body > \.todo-meta \{[\s\S]*grid-column: 1 \/ -1;[\s\S]*grid-row: 3;/, '移动端元信息应位于标题和进度之后并占满卡片宽度');
  assert.match(html, /@media \(max-width: 768px\) \{[\s\S]*\.todo-meta \{[\s\S]*align-items: stretch;[\s\S]*flex-direction: column;[\s\S]*width: 100%;[\s\S]*overflow: visible;/, '移动端标签和日期应分行避免重叠');
  assert.match(html, /@media \(max-width: 768px\) \{[\s\S]*\.todo-labels \{[\s\S]*width: 100%;[\s\S]*flex: none;[\s\S]*flex-wrap: wrap;/, '移动端标签组应允许自然换行');
  assert.match(html, /@media \(max-width: 768px\) \{[\s\S]*\.todo-dates \{[\s\S]*display: none;/, '移动端不应显示创建和更新时间');
  assert.doesNotMatch(html, /meta\.symbol|symbol: '○'|symbol: '◆'|symbol: '!'/, '重要程度标签不应使用不同形状符号');
  assert.match(html, /\.add-priority-btn\.priority-normal \{[\s\S]*background: var\(--bg\);/, '新增待办优先级选择器不应使用彩色背景');
  assert.match(html, /\.add-priority-btn\.priority-normal \{[\s\S]*color: var\(--text\);/, '新增待办优先级文字应使用普通文本色');
  assert.match(html, /\.add-priority-btn\.priority-normal \{[\s\S]*border-color: var\(--border\);/, '新增待办优先级选择器不应使用彩色边框');
  assert.match(html, /\.todo-meta \{[\s\S]*width: calc\(100% \+ var\(--todo-action-space\) \+ 10px\)/, '日期信息组应延伸到卡片右侧');
  assert.match(html, /\.todo-actions \{[\s\S]*width: var\(--todo-action-space\)/, '操作区应保留固定占位避免内容抖动');
  assert.match(html, /\.todo-item\.editing \.todo-actions \{ visibility: hidden;/);
  assert.match(html, /todo-title-placeholder/);
  assert.match(html, /\.todo-title-editor \{[\s\S]*font-size: 0\.93rem;[\s\S]*min-height: 1\.5em;[\s\S]*height: 1\.5em;[\s\S]*display: flex;[\s\S]*align-items: center;/, '编辑标题区域应保持稳定高度并垂直居中');
  assert.match(html, /\.edit-input \{[\s\S]*top: 50%;[\s\S]*height: calc\(100% \+ 2px\);[\s\S]*transform: translateY\(-50%\);[\s\S]*display: block;/, '编辑输入框应在固定标题区域内垂直对齐');
  assert.match(html, /<textarea[\s\S]*class="edit-input"/);
  assert.doesNotMatch(html, /<div class="todo-text[^>]*onclick=/);
  assert.match(html, /html\.modal-scroll-locked \{[\s\S]*overflow: hidden;/, '打开弹窗时应锁定根页面滚动');
  assert.match(html, /body\.modal-scroll-locked \{[\s\S]*position: fixed;[\s\S]*overflow: hidden;/, '打开弹窗时 body 应固定在原滚动位置');
  assert.match(html, /function lockModalScroll\([\s\S]*function unlockModalScroll\(/, '弹窗滚动锁应支持打开和关闭恢复');
  assert.match(html, /overlay\.addEventListener\('wheel', preventBackdropScroll, \{ passive: false \}\)/, '遮罩层滚轮不得继续滚动底层页面');
  assert.match(html, /overlay\.addEventListener\('touchmove', preventBackdropScroll, \{ passive: false \}\)/, '移动端遮罩层触摸滚动不得穿透');
  assert.match(html, /\.modal-overlay \{[\s\S]*overscroll-behavior: contain;/, '遮罩层应阻止滚动链传递');
  assert.match(html, /\.note-body \{[\s\S]*overscroll-behavior: contain;/, 'Markdown 内容区应独立滚动');
  assert.match(html, /\.settings-modal \{[\s\S]*overflow-y: auto;[\s\S]*overscroll-behavior: contain;/, '设置内容区应独立滚动');

  const loadStart = html.indexOf('  async function loadNote(');
  const loadEnd = html.indexOf('  function setNoteMode(', loadStart);
  const loadCode = html.slice(loadStart, loadEnd);
  const nodes = {
    noteEditor: { value: '' },
    noteSaveStatus: { textContent: '' },
    noteModalTitle: { textContent: '' },
  };
  const pending = new Map();
  const loadContext = vm.createContext({
    document: { getElementById: id => nodes[id] },
    fetch: requestUrl => new Promise(resolve => pending.set(requestUrl, resolve)),
    API: '/api',
    todos: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
    noteTodoId: 'a',
    noteMode: 'preview',
    noteSessionToken: 1,
    noteLoadStatus: 'loading',
    noteLoadedSessionToken: 0,
    renderNotePreview: () => {},
    setNoteReadOnlyState: () => {},
    console,
  });
  vm.runInContext(loadCode, loadContext);
  const loadA = vm.runInContext("loadNote('a', 1)", loadContext);
  loadContext.noteTodoId = 'b';
  loadContext.noteSessionToken = 2;
  const loadB = vm.runInContext("loadNote('b', 2)", loadContext);
  pending.get('/api/todos/b/note')({ ok: true, json: async () => ({ content: 'B content' }) });
  await loadB;
  pending.get('/api/todos/a/note')({ ok: true, json: async () => ({ content: 'A content' }) });
  await loadA;
  assert.equal(nodes.noteEditor.value, 'B content', '旧笔记响应不得覆盖当前会话');

  const saveStart = html.indexOf('  async function saveNote(');
  const saveEnd = html.indexOf('  /* ── Markdown renderer ──', saveStart);
  const saveCode = html.slice(saveStart, saveEnd);
  const saveStatus = { textContent: '' };
  const saveContext = vm.createContext({
    document: { getElementById: id => id === 'noteSaveStatus' ? saveStatus : { value: '' } },
    noteTodoId: 'a',
    noteLoadStatus: 'loading',
    noteLoadedSessionToken: 1,
    noteSessionToken: 1,
    noteSaveInFlight: false,
  });
  vm.runInContext(saveCode, saveContext);
  await vm.runInContext('saveNote()', saveContext);
  assert.equal(saveStatus.textContent, '笔记加载中…', '笔记未加载完成时不得保存');
}

(async () => {
  try {
    await testServer();
    await testCloudBackup();
    await testFrontend();
    console.log(JSON.stringify({
      passed: true,
      checks: [
        'static allowlist and same-origin proxy policy',
        'todo priority defaults, validation, persistence, and UI selector',
        'due-date status labels and calendar fallback behavior',
        'reminder no-op/concurrency/stale-state protection',
        'WebDAV response and gzip limits',
        '409 content verification and safe restore publish',
        'monthly snapshot paths and idempotent legacy migration',
        'note race/loading guard and fixed edit layout',
      ],
      tempDirectory: TEMP_ROOT,
    }));
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  } finally {
    try { db.closeDB(); } catch (_) {}
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }
})();
