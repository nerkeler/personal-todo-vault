/**
 * TODO App Server - 纯 Node.js 实现
 * SQLite: sql.js (WASM)
 * Email: nodemailer
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = Number(process.env.PORT) || 8238;
const HOST = process.env.HOST || '127.0.0.1';
const DB_PY = null; // 不再调用 Python
const NOTES_DIR = path.join(__dirname, 'notes');
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
const MAX_NOTE_BODY_BYTES = 4 * 1024 * 1024;
const DB_FILE = path.join(__dirname, 'todo.db');
const BACKUP_PATHS = { rootDir: __dirname, dbFile: DB_FILE, notesDir: NOTES_DIR };

// ── 环境变量加载（读取 /etc/environment）──────────────────
// /etc/environment 仅在部分 Linux 环境中存在；本机开发环境缺失时直接跳过。
if (fs.existsSync('/etc/environment')) {
  fs.readFileSync('/etc/environment', 'utf-8').split('\n').forEach(line => {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
}

// ── 加载模块 ─────────────────────────────────────────────
const { initDB, closeDB, saveDB,
  getCategories, createCategory, updateCategory, deleteCategory, reorderCategories,
  getTodos, createTodo, updateTodo, deleteTodo,
  getSettings, saveSettings, migrateFromJSON } = require('./sqlite.js');
const { sendEmail, sendTestEmail } = require('./email.js');
const { getFullConfig, saveAppConfig, publicAppConfig, isEmailConfigured, migrateStoredConfigSecrets } = require('./appConfig.js');
const { getBackupConfig, publicBackupStatus, testBackupConfig, uploadBackup } = require('./cloudBackup.js');

// ── MIME 类型 ────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

// ── 预设图标 ─────────────────────────────────────────────
const PRESET_ICONS = [
  '📋','📌','📍','💰','💎','💳','🎬','🎥','🎞️','📺',
  '📚','📖','📕','🎮','🕹️','🎯','⚽','🏀','🎸','🎨',
  '🍳','☕','🍺','🍜','🏠','🚗','✈️','💼','🏢','📱',
  '💻','🔧','🔬','📊','📈','📉','🧘','🏃','🌱','🌸',
  '🎁','⭐','🔥','💡','⚡','🎉','🎊','👀','✔️','❌',
  '🗑️','✏️','📝','📧','🛒','🎒','🏋️','🧗','🚴','🏊',
  '🎵','🎤','📷','🖼️','🌅','🏞️','🌺','🍀','🌻','🌹',
  '🍎','🍕','🎂','🍦','🧃','🍷','🏨','🛵',
];

// ── JSON 响应工具 ────────────────────────────────────────
const jsonRes = (res, data, code = 200) => {
  if (res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

function isValidTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function findTodo(id) {
  return getTodos().find(todo => todo.id === id) || null;
}

function noteFileFor(todo) {
  return `${todo.id}.md`;
}

function notePathFor(todo) {
  return path.join(NOTES_DIR, noteFileFor(todo));
}

function writeTextAtomic(filepath, content) {
  const tempFile = `${filepath}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, content, 'utf8');
  fs.renameSync(tempFile, filepath);
}

function ensureNoteFile(todo) {
  if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true });
  const noteFile = noteFileFor(todo);
  const filepath = notePathFor(todo);
  if (!fs.existsSync(filepath)) {
    const legacyName = todo.noteFile && path.basename(todo.noteFile) === todo.noteFile
      ? todo.noteFile
      : null;
    const legacyPath = legacyName ? path.join(NOTES_DIR, legacyName) : null;
    if (legacyPath && legacyPath !== filepath && fs.existsSync(legacyPath)) {
      // 兼容旧版“按标题命名”的笔记，但之后固定使用 todo id。
      fs.copyFileSync(legacyPath, filepath);
    } else {
      writeTextAtomic(filepath, `# ${todo.title}\n`);
    }
    updateTodo(todo.id, { noteFile });
  }
  return { noteFile, filepath };
}

function removeTodoNote(todo) {
  const candidates = [notePathFor(todo)];
  if (todo.noteFile && path.basename(todo.noteFile) === todo.noteFile) {
    candidates.push(path.join(NOTES_DIR, todo.noteFile));
  }
  const otherNoteFiles = new Set(
    getTodos()
      .filter(other => other.id !== todo.id)
      .map(other => other.noteFile)
      .filter(Boolean)
  );
  for (const filepath of new Set(candidates)) {
    const filename = path.basename(filepath);
    // 旧版按标题命名的文件可能被多个任务共用，只有不再被引用时才删除。
    if (filename !== noteFileFor(todo) && otherNoteFiles.has(filename)) continue;
    try { if (fs.existsSync(filepath)) fs.unlinkSync(filepath); } catch (e) {
      console.error('[NOTE] Cleanup failed:', e.message);
    }
  }
}

function hasCategory(id) {
  return typeof id === 'string' && getCategories().some(category => category.id === id);
}

function defaultCategoryId() {
  const categories = getCategories();
  return categories.find(category => category.id === 'cat_default')?.id || categories[0]?.id || null;
}

function isNonEmptyString(value, maxLength = 200) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function cleanString(value, maxLength = 500) {
  if (value === undefined || value === null) return undefined;
  return String(value).trim().slice(0, maxLength);
}

function settingsResponse(config = getFullConfig()) {
  return {
    ...publicAppConfig(config),
    backup: { ...publicBackupStatus(getBackupConfig(config)), lastBackup },
  };
}

function cleanSettingsPatch(payload = {}) {
  const patch = { email: {}, webdav: {} };
  const email = payload.email || {};
  const webdav = payload.webdav || {};

  if (payload.emailEnabled !== undefined) patch.email.enabled = !!payload.emailEnabled;
  if (payload.checkTime !== undefined) patch.email.checkTime = cleanString(payload.checkTime, 20);
  if (email.enabled !== undefined) patch.email.enabled = !!email.enabled;
  if (email.checkTime !== undefined) patch.email.checkTime = cleanString(email.checkTime, 20);
  if (email.host !== undefined) patch.email.host = cleanString(email.host, 200);
  if (email.port !== undefined) patch.email.port = Number(email.port) || 465;
  if (email.secure !== undefined) patch.email.secure = !!email.secure;
  if (email.user !== undefined) patch.email.user = cleanString(email.user, 300);
  if (typeof email.password === 'string' && email.password.length > 0) patch.email.password = email.password;
  if (email.clearPassword === true) patch.email.password = '';
  if (email.fromName !== undefined) patch.email.fromName = cleanString(email.fromName, 100);
  if (email.from !== undefined) patch.email.from = cleanString(email.from, 300);
  if (email.recipients !== undefined) patch.email.recipients = cleanString(email.recipients, 1000);
  if (email.defaultTo !== undefined) patch.email.recipients = cleanString(email.defaultTo, 1000);

  if (webdav.baseUrl !== undefined) patch.webdav.baseUrl = cleanString(webdav.baseUrl, 500);
  if (webdav.username !== undefined) patch.webdav.username = cleanString(webdav.username, 300);
  if (typeof webdav.password === 'string' && webdav.password.length > 0) patch.webdav.password = webdav.password;
  if (webdav.clearPassword === true) patch.webdav.password = '';
  if (webdav.backupDir !== undefined) patch.webdav.backupDir = cleanString(webdav.backupDir, 200);
  if (webdav.autoEnabled !== undefined) patch.webdav.autoEnabled = !!webdav.autoEnabled;
  if (webdav.intervalHours !== undefined) patch.webdav.intervalHours = Math.max(1, Number(webdav.intervalHours) || 24);

  if (patch.email.checkTime !== undefined && !isValidTime(patch.email.checkTime)) {
    throw new Error('每日检查时间必须是 HH:MM 格式');
  }
  if (patch.email.port !== undefined && (patch.email.port < 1 || patch.email.port > 65535)) {
    throw new Error('SMTP 端口必须在 1-65535 之间');
  }
  return patch;
}

// ── HTTP 服务器 ──────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const jsonResR = (data, code = 200) => jsonRes(res, data, code);
  const withBody = async (callback, maxBytes = MAX_JSON_BODY_BYTES) => {
    let body = '';
    let bytes = 0;
    let tooLarge = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (tooLarge) return;
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > maxBytes) {
        tooLarge = true;
        req.resume();
        jsonResR({ error: 'Request body too large' }, 413);
        return;
      }
      body += chunk;
    });
    req.on('end', async () => {
      if (tooLarge) return;
      try {
        const payload = body ? JSON.parse(body) : {};
        await callback(payload);
      } catch (e) {
        if (!res.writableEnded) jsonResR({ error: 'Invalid JSON' }, 400);
      }
    });
  };

  // ── GET /api/settings ─────────────────────────────────
  if (pathname === '/api/settings' && req.method === 'GET') {
    try {
      jsonResR(settingsResponse(getFullConfig()));
    } catch (e) { jsonResR({ error: e.message }, 500); }
    return;
  }

  // ── PUT /api/settings ──────────────────────────────────
  if (pathname === '/api/settings' && req.method === 'PUT') {
    withBody(async (payload) => {
      try {
        const config = saveAppConfig(cleanSettingsPatch(payload));
        saveSettings(config.email.enabled, config.email.checkTime); // keep legacy DB settings in sync
        if (config.email.enabled && isEmailConfigured(config.email)) startCron(); else stopCron();
        startBackupTimer();
        jsonResR(settingsResponse(config));
      } catch (e) { jsonResR({ error: e.message }, 400); }
    });
    return;
  }

  // ── POST /api/settings/test-email ──────────────────────
  if (pathname === '/api/settings/test-email' && req.method === 'POST') {
    withBody(async (payload) => {
      try {
        const config = getFullConfig(cleanSettingsPatch(payload));
        const to = cleanString(payload.to, 1000) || config.email.recipients;
        const result = await sendTestEmail(to, { email: config.email });
        jsonResR({ ...result, to });
      } catch (e) { jsonResR({ error: e.message }, 500); }
    });
    return;
  }

  // ── Cloud backup ──────────────────────────────────────
  if (pathname === '/api/backup/status' && req.method === 'GET') {
    try {
      jsonResR({ ...publicBackupStatus(getBackupConfig()), lastBackup });
    } catch (e) { jsonResR({ error: e.message }, 500); }
    return;
  }

  if (pathname === '/api/backup/test' && req.method === 'POST') {
    withBody(async (payload) => {
      try {
        const config = getFullConfig(cleanSettingsPatch(payload));
        const result = await testBackupConfig(getBackupConfig(config));
        jsonResR(result);
      } catch (e) { jsonResR({ error: e.message }, 500); }
    });
    return;
  }

  if (pathname === '/api/backup/run' && req.method === 'POST') {
    try {
      saveDB();
      const result = await uploadBackup(BACKUP_PATHS, getBackupConfig());
      lastBackup = result;
      jsonResR(result);
    } catch (e) {
      lastBackup = { success: false, error: e.message, createdAt: new Date().toISOString() };
      jsonResR({ error: e.message }, 500);
    }
    return;
  }

  // ── GET /api/icons ─────────────────────────────────────
  if (pathname === '/api/icons' && req.method === 'GET') {
    jsonResR(PRESET_ICONS); return;
  }

  // ── GET /api/categories ────────────────────────────────
  if (pathname === '/api/categories' && req.method === 'GET') {
    try {
      const cats = getCategories();
      cats.sort((a, b) => a.sort_order - b.sort_order);
      jsonResR(cats);
    } catch (e) { jsonResR({ error: e.message }, 500); }
    return;
  }

  // ── POST /api/categories ──────────────────────────────
  if (pathname === '/api/categories' && req.method === 'POST') {
    withBody(async ({ name, icon }) => {
      if (!isNonEmptyString(name, 80)) { jsonResR({ error: '名称必须是 1-80 个字符的非空字符串' }, 400); return; }
      if (icon !== undefined && typeof icon !== 'string') { jsonResR({ error: '图标必须是字符串' }, 400); return; }
      try { jsonResR(createCategory(name.trim(), icon?.trim() || '📋')); }
      catch (e) { jsonResR({ error: e.message }, 500); }
    });
    return;
  }

  // ── PATCH /api/categories/reorder ──────────────────────
  if (pathname === '/api/categories/reorder' && req.method === 'PATCH') {
    withBody(async ({ order }) => {
      if (!Array.isArray(order) || order.some(id => typeof id !== 'string')) {
        jsonResR({ error: 'order must be an array of category ids' }, 400); return;
      }
      try { reorderCategories(order); jsonResR({ success: true }); }
      catch (e) { jsonResR({ error: e.message }, 500); }
    });
    return;
  }

  // ── /api/categories/:id ───────────────────────────────
  const catMatch = pathname.match(/^\/api\/categories\/([^/]+)$/);
  if (catMatch) {
    const id = catMatch[1];
    const category = getCategories().find(item => item.id === id);
    if (!category) { jsonResR({ error: 'Category not found' }, 404); return; }
    if (req.method === 'PATCH') {
      withBody(async ({ name, icon }) => {
        if (name !== undefined && !isNonEmptyString(name, 80)) {
          jsonResR({ error: '名称必须是 1-80 个字符的非空字符串' }, 400); return;
        }
        if (icon !== undefined && typeof icon !== 'string') {
          jsonResR({ error: '图标必须是字符串' }, 400); return;
        }
        if (name === undefined && icon === undefined) {
          jsonResR({ error: '至少提供 name 或 icon' }, 400); return;
        }
        try { jsonResR(updateCategory(id, name?.trim(), icon?.trim())); }
        catch (e) { jsonResR({ error: e.message }, 500); }
      });
      return;
    }
    if (req.method === 'DELETE') {
      try {
        getTodos(id).forEach(removeTodoNote);
        deleteCategory(id);
        jsonResR({ success: true });
      } catch (e) { jsonResR({ error: e.message }, 500); }
      return;
    }
    jsonResR({ error: 'Not found' }, 404); return;
  }

  // ── GET/POST /api/todos ───────────────────────────────
  if (pathname === '/api/todos') {
    if (req.method === 'GET') {
      const catId = parsed.query.categoryId;
      if (catId && !hasCategory(catId)) { jsonResR({ error: 'Category not found' }, 404); return; }
      try { jsonResR(getTodos(catId || null)); }
      catch (e) { jsonResR({ error: e.message }, 500); }
      return;
    }
    if (req.method === 'POST') {
      withBody(async ({ title, categoryId }) => {
        if (!isNonEmptyString(title, 200)) { jsonResR({ error: '标题必须是 1-200 个字符的非空字符串' }, 400); return; }
        const selectedCategoryId = categoryId || defaultCategoryId();
        if (!selectedCategoryId || !hasCategory(selectedCategoryId)) {
          jsonResR({ error: 'Category not found' }, 400); return;
        }
        try { jsonResR(createTodo(title.trim(), selectedCategoryId)); }
        catch (e) { jsonResR({ error: e.message }, 500); }
      });
      return;
    }
    jsonResR({ error: 'Not found' }, 404); return;
  }

  // ── /api/todos/:id ────────────────────────────────────
  const todoMatch = pathname.match(/^\/api\/todos\/([^/]+)$/);
  if (todoMatch) {
    const id = todoMatch[1];
    const todo = findTodo(id);
    if (!todo) { jsonResR({ error: 'Todo not found' }, 404); return; }
    if (req.method === 'PATCH') {
      withBody(async (updates) => {
        if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
          jsonResR({ error: '请求体必须是对象' }, 400); return;
        }
        if (updates.title !== undefined && !isNonEmptyString(updates.title, 200)) {
          jsonResR({ error: '标题必须是 1-200 个字符的非空字符串' }, 400); return;
        }
        if (updates.completed !== undefined && typeof updates.completed !== 'boolean') {
          jsonResR({ error: 'completed 必须是布尔值' }, 400); return;
        }
        if (updates.categoryId !== undefined && !hasCategory(updates.categoryId)) {
          jsonResR({ error: 'Category not found' }, 400); return;
        }
        if (updates.progress !== undefined &&
            (!Number.isInteger(updates.progress) || updates.progress < 0 || updates.progress > 100)) {
          jsonResR({ error: 'progress 必须是 0-100 的整数' }, 400); return;
        }
        if (updates.reminderEnabled !== undefined && typeof updates.reminderEnabled !== 'boolean') {
          jsonResR({ error: 'reminderEnabled 必须是布尔值' }, 400); return;
        }
        if (updates.reminderTime !== undefined && !isValidTime(updates.reminderTime)) {
          jsonResR({ error: 'reminderTime 必须是 HH:MM 格式' }, 400); return;
        }
        if (updates.creatorEmail !== undefined &&
            (typeof updates.creatorEmail !== 'string' || updates.creatorEmail.length > 320)) {
          jsonResR({ error: 'creatorEmail 必须是长度不超过 320 的字符串' }, 400); return;
        }
        try {
          const kw = {};
          if (updates.title !== undefined) kw.title = updates.title.trim();
          if (updates.completed !== undefined) kw.completed = updates.completed;
          if (updates.categoryId !== undefined) kw.categoryId = updates.categoryId;
          if (updates.progress !== undefined) kw.progress = updates.progress;
          if (updates.reminderEnabled !== undefined) kw.reminderEnabled = updates.reminderEnabled;
          if (updates.reminderTime !== undefined) kw.reminderTime = updates.reminderTime;
          if (updates.creatorEmail !== undefined) kw.creatorEmail = updates.creatorEmail.trim();
          const result = updateTodo(id, kw);
          jsonResR(result || { error: 'Todo not found' }, result ? 200 : 404);
        } catch (e) { jsonResR({ error: e.message }, 500); }
      });
      return;
    }
    if (req.method === 'DELETE') {
      try { removeTodoNote(todo); deleteTodo(id); jsonResR({ success: true }); }
      catch (e) { jsonResR({ error: e.message }, 500); }
      return;
    }
    jsonResR({ error: 'Not found' }, 404); return;
  }

  // ── /api/todos/:id/note ───────────────────────────────
  const noteMatch = pathname.match(/^\/api\/todos\/([^/]+)\/note$/);
  if (noteMatch) {
    const id = noteMatch[1];
    const todo = findTodo(id);
    if (!todo) { jsonResR({ error: 'Todo not found' }, 404); return; }
    if (req.method === 'GET') {
      try {
        const { noteFile, filepath } = ensureNoteFile(todo);
        const content = fs.readFileSync(filepath, 'utf8');
        jsonResR({ id, noteFile, content, exists: true });
      } catch (e) { jsonResR({ error: e.message }, 500); }
      return;
    }
    if (req.method === 'PUT') {
      withBody(async ({ content }) => {
        if (typeof content !== 'string') { jsonResR({ error: 'content 必须是字符串' }, 400); return; }
        try {
          const { noteFile, filepath } = ensureNoteFile(todo);
          writeTextAtomic(filepath, content);
          if (todo.noteFile !== noteFile) updateTodo(id, { noteFile });
          jsonResR({ id, noteFile, success: true });
        } catch (e) { jsonResR({ error: e.message }, 500); }
      }, MAX_NOTE_BODY_BYTES);
      return;
    }
    jsonResR({ error: 'Not found' }, 404); return;
  }

  // ── 静态文件 ─────────────────────────────────────────
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.join(__dirname, filePath);
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'text/plain';
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime }); res.end(content);
  });
});

// ── Cron（每分钟检查任务提醒）────────────────────────────
let cronTimer = null;

function stopCron() {
  if (cronTimer) { clearInterval(cronTimer); cronTimer = null; console.log('[CRON] stopped'); }
}

function startCron() {
  stopCron();
  cronTimer = setInterval(async () => {
    try {
      const emailConfig = getFullConfig().email;
      if (!emailConfig.enabled || !isEmailConfigured(emailConfig)) return;
      const now = new Date();
      const curTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
      const todos = getTodos();
      for (const todo of todos) {
        if (!todo.reminderEnabled || !todo.reminderTime) continue;
        if (todo.reminderTime !== curTime) continue;
        const recipient = todo.creatorEmail || emailConfig.recipients;
        if (!recipient) continue;
        try {
          await sendEmail(
            recipient,
            `📋 任务提醒：${todo.title}`,
            `您有一个待办任务还未完成：\n\n${todo.title}\n\n请及时处理。`,
            { email: emailConfig }
          );
        } catch (e) {
          console.error(`[REMINDER] Failed: ${e.message}`);
        }
      }
    } catch (e) { console.error('[CRON] error:', e.message); }
  }, 60 * 1000);
  console.log('[CRON] started');
}


// ── Cloud backup timer ───────────────────────────────────
let backupTimer = null;
let lastBackup = null;

function stopBackupTimer() {
  if (backupTimer) { clearInterval(backupTimer); backupTimer = null; console.log('[BACKUP] stopped'); }
}

function startBackupTimer() {
  stopBackupTimer();
  const config = getBackupConfig();
  if (!config.configured || !config.autoEnabled) return;
  const intervalMs = config.intervalHours * 60 * 60 * 1000;
  backupTimer = setInterval(async () => {
    try {
      saveDB();
      lastBackup = await uploadBackup(BACKUP_PATHS, getBackupConfig());
      console.log(`[BACKUP] uploaded: ${lastBackup.remotePath}`);
    } catch (e) {
      lastBackup = { success: false, error: e.message, createdAt: new Date().toISOString() };
      console.error('[BACKUP] failed:', e.message);
    }
  }, intervalMs);
  console.log(`[BACKUP] auto enabled: every ${config.intervalHours}h`);
}

// ── 启动 ─────────────────────────────────────────────────
async function bootstrap() {
  try {
    await initDB();
    console.log('[TODO] SQLite ready:', DB_FILE);
    migrateStoredConfigSecrets();
    const appConfig = getFullConfig();
    const smtpReady = isEmailConfigured(appConfig.email);
    console.log(`[TODO] SMTP: ${smtpReady}, emailEnabled: ${appConfig.email.enabled}`);
    if (appConfig.email.enabled && smtpReady) startCron();
    startBackupTimer();
  } catch (e) {
    console.error('[TODO] Bootstrap error:', e.message);
    process.exit(1);
  }
}

bootstrap();
server.listen(PORT, HOST, () => console.log(`TODO App → http://${HOST}:${PORT}`));

process.on('SIGTERM', () => { stopBackupTimer(); closeDB(); process.exit(0); });
process.on('SIGINT',  () => { stopBackupTimer(); closeDB(); process.exit(0); });
