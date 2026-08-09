/**
 * TODO App Server - 纯 Node.js 实现
 * SQLite: sql.js (WASM)
 * Email: nodemailer
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 8238;
const DB_PY = null; // 不再调用 Python
const NOTES_DIR = path.join(__dirname, 'notes');

// ── 加载模块 ─────────────────────────────────────────────
const { initDB, closeDB, saveDB,
  getCategories, createCategory, updateCategory, deleteCategory, reorderCategories,
  getTodos, createTodo, updateTodo, deleteTodo,
  getSettings, saveSettings, migrateFromJSON } = require('./sqlite.js');
const { sendEmail, DEFAULT_TO } = require('./email.js');

// ── 环境变量加载（读取 /etc/environment）──────────────────
// /etc/environment 仅在部分 Linux 环境中存在；本机开发环境缺失时直接跳过。
if (fs.existsSync('/etc/environment')) {
  fs.readFileSync('/etc/environment', 'utf-8').split('\n').forEach(line => {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
}

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
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

// ── HTTP 服务器 ──────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const jsonResR = (data, code = 200) => jsonRes(res, data, code);
  const withBody = async (callback) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try { await callback(JSON.parse(body)); }
      catch (e) { jsonResR({ error: 'Invalid JSON' }, 400); }
    });
  };

  // ── GET /api/settings ─────────────────────────────────
  if (pathname === '/api/settings' && req.method === 'GET') {
    try {
      const s = getSettings();
      jsonResR({ ...s, smtpReady: !!(process.env.TODO_SMTP_USER && process.env.TODO_SMTP_PASS) });
    } catch (e) { jsonResR({ error: e.message }, 500); }
    return;
  }

  // ── PUT /api/settings ──────────────────────────────────
  if (pathname === '/api/settings' && req.method === 'PUT') {
    withBody(async ({ emailEnabled, checkTime }) => {
      try {
        const s = saveSettings(!!emailEnabled, checkTime || '09:00');
        if (s.emailEnabled) startCron(); else stopCron();
        jsonResR({ ...s, smtpReady: !!(process.env.TODO_SMTP_USER && process.env.TODO_SMTP_PASS) });
      } catch (e) { jsonResR({ error: e.message }, 500); }
    });
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
      if (!name?.trim()) { jsonResR({ error: '名称不能为空' }, 400); return; }
      try { jsonResR(createCategory(name.trim(), icon || '📋')); }
      catch (e) { jsonResR({ error: e.message }, 500); }
    });
    return;
  }

  // ── PATCH /api/categories/reorder ──────────────────────
  if (pathname === '/api/categories/reorder' && req.method === 'PATCH') {
    withBody(async ({ order }) => {
      if (!Array.isArray(order)) { jsonResR({ error: 'order must be array' }, 400); return; }
      try { reorderCategories(order); jsonResR({ success: true }); }
      catch (e) { jsonResR({ error: e.message }, 500); }
    });
    return;
  }

  // ── /api/categories/:id ───────────────────────────────
  const catMatch = pathname.match(/^\/api\/categories\/([^/]+)$/);
  if (catMatch) {
    const id = catMatch[1];
    if (req.method === 'PATCH') {
      withBody(async ({ name, icon }) => {
        try { jsonResR(updateCategory(id, name, icon)); }
        catch (e) { jsonResR({ error: e.message }, 500); }
      });
      return;
    }
    if (req.method === 'DELETE') {
      try { deleteCategory(id); jsonResR({ success: true }); }
      catch (e) { jsonResR({ error: e.message }, 500); }
      return;
    }
    jsonResR({ error: 'Not found' }, 404); return;
  }

  // ── GET/POST /api/todos ───────────────────────────────
  if (pathname === '/api/todos') {
    if (req.method === 'GET') {
      const catId = parsed.query.categoryId;
      try { jsonResR(getTodos(catId || null)); }
      catch (e) { jsonResR({ error: e.message }, 500); }
      return;
    }
    if (req.method === 'POST') {
      withBody(async ({ title, categoryId }) => {
        if (!title?.trim()) { jsonResR({ error: 'Title is required' }, 400); return; }
        try { jsonResR(createTodo(title.trim(), categoryId || 'cat_default')); }
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
    if (req.method === 'PATCH') {
      withBody(async (updates) => {
        try {
          const kw = {};
          if (updates.title !== undefined) kw.title = updates.title.trim();
          if (updates.completed !== undefined) kw.completed = updates.completed;
          if (updates.categoryId !== undefined) kw.categoryId = updates.categoryId;
          if (updates.progress !== undefined) kw.progress = updates.progress;
          if (updates.reminderEnabled !== undefined) kw.reminderEnabled = updates.reminderEnabled;
          if (updates.reminderTime !== undefined) kw.reminderTime = updates.reminderTime;
          if (updates.creatorEmail !== undefined) kw.creatorEmail = updates.creatorEmail;
          const result = updateTodo(id, kw);
          if (result) jsonResR(result);
          else jsonResR({ error: 'not found' }, 404);
        } catch (e) { jsonResR({ error: e.message }, 500); }
      });
      return;
    }
    if (req.method === 'DELETE') {
      try { deleteTodo(id); jsonResR({ success: true }); }
      catch (e) { jsonResR({ error: e.message }, 500); }
      return;
    }
    jsonResR({ error: 'Not found' }, 404); return;
  }

  // ── /api/todos/:id/note ───────────────────────────────
  const noteMatch = pathname.match(/^\/api\/todos\/([^/]+)\/note$/);
  if (noteMatch) {
    const id = noteMatch[1];

    // 根据任务标题生成安全的 .md 文件名（自动建文件）
    const noteFileFor = (todoId) => {
      const todo = getTodos().find(t => t.id === todoId);
      if (!todo) return `${todoId}.md`;
      const base = (todo.title || 'note')
        .replace(/[\\/:*?"<>|\s]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60);
      return (base || `note-${todoId}`) + '.md';
    };

    if (req.method === 'GET') {
      try {
        if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true });
        const noteFile = noteFileFor(id);
        const filepath = path.join(NOTES_DIR, noteFile);
        // 自动建文件：不存在时以任务标题为一级标题创建
        if (!fs.existsSync(filepath)) {
          const todo = getTodos().find(t => t.id === id);
          const heading = todo ? `# ${todo.title}\n` : '';
          fs.writeFileSync(filepath, heading, 'utf-8');
          updateTodo(id, { noteFile });
        }
        const exists = fs.existsSync(filepath);
        const content = exists ? fs.readFileSync(filepath, 'utf-8') : '';
        jsonResR({ id, noteFile, content, exists });
      } catch (e) { jsonResR({ error: e.message }, 500); }
      return;
    }
    if (req.method === 'PUT') {
      withBody(async ({ content }) => {
        try {
          if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true });
          const filepath = path.join(NOTES_DIR, noteFileFor(id));
          fs.writeFileSync(filepath, content || '', 'utf-8');
          updateTodo(id, { noteFile: path.basename(filepath) });
          jsonResR({ id, noteFile: path.basename(filepath), success: true });
        } catch (e) { jsonResR({ error: e.message }, 500); }
      });
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
      const s = getSettings();
      if (!s.emailEnabled) return;
      const now = new Date();
      const curTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
      const todos = getTodos();
      for (const todo of todos) {
        if (!todo.reminder_enabled || !todo.reminder_time) continue;
        if (todo.reminder_time !== curTime) continue;
        const recipient = todo.creator_email || DEFAULT_TO;
        if (!recipient) continue;
        try {
          await sendEmail(recipient, `📋 任务提醒：${todo.title}`,
            `您有一个待办任务还未完成：\n\n${todo.title}\n\n请及时处理。`);
          console.log(`[REMINDER] Sent: ${todo.title}`);
        } catch (e) {
          console.error(`[REMINDER] Failed: ${e.message}`);
        }
      }
    } catch (e) { console.error('[CRON] error:', e.message); }
  }, 60 * 1000);
  console.log('[CRON] started');
}

// ── 启动 ─────────────────────────────────────────────────
async function bootstrap() {
  try {
    await initDB();
    console.log('[TODO] SQLite ready:', path.join(__dirname, 'todo.db'));
    const s = getSettings();
    const smtpReady = !!(process.env.TODO_SMTP_USER && process.env.TODO_SMTP_PASS);
    console.log(`[TODO] SMTP: ${smtpReady}, emailEnabled: ${s.emailEnabled}`);
    if (s.emailEnabled && smtpReady) startCron();
  } catch (e) {
    console.error('[TODO] Bootstrap error:', e.message);
    process.exit(1);
  }
}

bootstrap();
server.listen(PORT, '0.0.0.0', () => console.log(`TODO App → http://localhost:${PORT}`));

process.on('SIGTERM', () => { closeDB(); process.exit(0); });
process.on('SIGINT',  () => { closeDB(); process.exit(0); });