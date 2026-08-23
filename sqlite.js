/**
 * SQLite 数据库操作层 - 替代 Python db.py
 * 使用 sql.js (WebAssembly) 纯 Node.js 实现
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('./sql-wasm.js');

const DB_FILE = path.join(__dirname, 'todo.db');
const JSON_FILE = path.join(__dirname, 'data.json');
const BACKUP_DIR = path.join(__dirname, 'backups');
const MAX_BACKUPS = 10;
let db = null;

const PRESET_CATEGORIES = [
  { id: 'cat_default',   name: '默认',   icon: '📋', sort_order: 0 },
  { id: 'cat_touzi',     name: '投资',   icon: '💰', sort_order: 1 },
  { id: 'cat_dianshiju', name: '电视剧', icon: '🎬', sort_order: 2 },
  { id: 'cat_dianying',  name: '电影',   icon: '🎥', sort_order: 3 },
  { id: 'cat_shuji',     name: '书籍',   icon: '📚', sort_order: 4 },
  { id: 'cat_youxi',     name: '游戏',   icon: '🎮', sort_order: 5 },
];

// ── 初始化数据库连接 ─────────────────────────────────────
async function initDB() {
  const dbExisted = fs.existsSync(DB_FILE);
  const SQL = await initSqlJs({
    locateFile: f => path.join(__dirname, f)
  });

  // 加载已有数据库或创建新数据库
  if (fs.existsSync(DB_FILE)) {
    const buffer = fs.readFileSync(DB_FILE);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // 建表
  db.run(`CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT DEFAULT '📋',
    sort_order INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    completed INTEGER DEFAULT 0,
    category_id TEXT,
    progress INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    reminder_enabled INTEGER DEFAULT 0,
    reminder_time TEXT DEFAULT '',
    reminder_mode TEXT DEFAULT 'once',
    reminder_weekdays TEXT DEFAULT '[]',
    reminder_repeat_count INTEGER DEFAULT 1,
    reminder_sent_count INTEGER DEFAULT 0,
    reminder_last_sent_at TEXT DEFAULT '',
    creator_email TEXT DEFAULT '',
    note_file TEXT DEFAULT ''
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  db.run('CREATE INDEX IF NOT EXISTS idx_todos_cat ON todos(category_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_todos_created ON todos(created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_todos_reminder ON todos(reminder_enabled, reminder_time)');

  // 兼容旧库：为已存在的 todos 表补充新增列
  const cols = db.exec(`PRAGMA table_info(todos)`);
  const colNames = (cols[0]?.values || []).map(r => r[1]);
  const migrations = [
    ['note_file', "ALTER TABLE todos ADD COLUMN note_file TEXT DEFAULT ''"],
    ['reminder_mode', "ALTER TABLE todos ADD COLUMN reminder_mode TEXT DEFAULT 'once'"],
    ['reminder_weekdays', "ALTER TABLE todos ADD COLUMN reminder_weekdays TEXT DEFAULT '[]'"],
    ['reminder_repeat_count', "ALTER TABLE todos ADD COLUMN reminder_repeat_count INTEGER DEFAULT 1"],
    ['reminder_sent_count', "ALTER TABLE todos ADD COLUMN reminder_sent_count INTEGER DEFAULT 0"],
    ['reminder_last_sent_at', "ALTER TABLE todos ADD COLUMN reminder_last_sent_at TEXT DEFAULT ''"],
  ];
  for (const [name, sql] of migrations) {
    if (!colNames.includes(name)) db.run(sql);
  }

  // 初始化默认分类
  const existing = db.exec('SELECT COUNT(*) FROM categories')[0].values[0][0];
  if (existing === 0) {
    for (const cat of PRESET_CATEGORIES) {
      db.run('INSERT INTO categories (id, name, icon, sort_order) VALUES (?, ?, ?, ?)',
        [cat.id, cat.name, cat.icon, cat.sort_order]);
    }
  }

  // 新数据库存在旧版 JSON 时自动迁移，避免首次启动变成空库。
  if (!dbExisted && fs.existsSync(JSON_FILE)) {
    const result = migrateFromJSON(JSON_FILE, false);
    console.log(`[TODO] Migrated JSON: ${result.cats} categories, ${result.todos} todos`);
  }

  normalizeCategoryOrder();
  saveDB();
  return db;
}

// ── 持久化数据库文件 ───────────────────────────────────
function saveDB() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  const tempFile = `${DB_FILE}.${process.pid}.tmp`;

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    const stamp = new Date().toISOString()
      .replace(/[-:]/g, '')
      .replace('T', '-')
      .replace('Z', '');
    fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, `todo-${stamp}.db`));
  }

  const fd = fs.openSync(tempFile, 'w');
  try {
    fs.writeSync(fd, buffer, 0, buffer.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempFile, DB_FILE);

  const backups = fs.readdirSync(BACKUP_DIR)
    .filter(name => /^todo-.*\.db$/.test(name))
    .sort()
    .reverse();
  for (const old of backups.slice(MAX_BACKUPS)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch (_) {}
  }
}

function closeDB() {
  if (db) { saveDB(); db.close(); db = null; }
}

// ── 辅助 ───────────────────────────────────────────────
function rowsToArray(result) {
  if (!result || result.length === 0) return [];
  const [{ columns, values }] = result;
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

// ── Categories ─────────────────────────────────────────
function normalizeCategoryOrder() {
  const rows = rowsToArray(db.exec('SELECT id FROM categories ORDER BY sort_order ASC, rowid ASC'));
  rows.forEach((row, idx) => {
    db.run('UPDATE categories SET sort_order=? WHERE id=?', [idx, row.id]);
  });
}

function getCategories() {
  const result = db.exec('SELECT * FROM categories ORDER BY sort_order, rowid');
  return rowsToArray(result);
}

function createCategory(name, icon = '📋') {
  const id = 'cat_' + require('crypto').randomBytes(8).toString('hex');
  const maxOrderResult = db.exec('SELECT MAX(sort_order) FROM categories');
  const maxOrder = (maxOrderResult[0]?.values[0][0] ?? -1) + 1;
  db.run('INSERT INTO categories (id, name, icon, sort_order) VALUES (?, ?, ?, ?)',
    [id, name, icon, maxOrder]);
  saveDB();
  return getCategories().find(c => c.id === id);
}

function updateCategory(id, name, icon) {
  if (name !== undefined) db.run('UPDATE categories SET name=? WHERE id=?', [name, id]);
  if (icon !== undefined) db.run('UPDATE categories SET icon=? WHERE id=?', [icon, id]);
  saveDB();
  return getCategories().find(c => c.id === id);
}

function deleteCategory(id) {
  db.run('DELETE FROM todos WHERE category_id=?', [id]);
  db.run('DELETE FROM categories WHERE id=?', [id]);
  saveDB();
  return true;
}

function reorderCategories(orderIds) {
  const existingIds = new Set(rowsToArray(db.exec('SELECT id FROM categories')).map(row => row.id));
  const ordered = [...new Set(orderIds)].filter(id => existingIds.has(id));
  const missing = rowsToArray(db.exec('SELECT id FROM categories ORDER BY sort_order, rowid'))
    .map(row => row.id)
    .filter(id => !ordered.includes(id));
  [...ordered, ...missing].forEach((id, idx) => {
    db.run('UPDATE categories SET sort_order=? WHERE id=?', [idx, id]);
  });
  saveDB();
  return true;
}

function parseReminderWeekdays(value) {
  let days;
  if (Array.isArray(value)) {
    days = value;
  } else {
    try {
      const parsed = JSON.parse(value || '[]');
      days = Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      days = String(value || '').split(',');
    }
  }
  return [...new Set(days.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 7))]
    .sort((a, b) => a - b);
}

// ── Todos ─────────────────────────────────────────────
function getTodos(categoryId) {
  const sql = categoryId
    ? 'SELECT * FROM todos WHERE category_id=? ORDER BY created_at DESC'
    : 'SELECT * FROM todos ORDER BY created_at DESC';
  const result = categoryId
    ? db.exec(sql, [categoryId])
    : db.exec(sql);
  return rowsToArray(result).map(r => ({
    id: r.id,
    title: r.title,
    categoryId: r.category_id,
    progress: Number.isInteger(r.progress) ? r.progress : 0,
    createdAt: r.created_at || null,
    completed: !!r.completed,
    reminderEnabled: !!r.reminder_enabled,
    reminderTime: r.reminder_time || '',
    reminderMode: ['once', 'weekly', 'count'].includes(r.reminder_mode) ? r.reminder_mode : 'once',
    reminderWeekdays: parseReminderWeekdays(r.reminder_weekdays),
    reminderRepeatCount: Math.max(1, Number(r.reminder_repeat_count) || 1),
    reminderSentCount: Math.max(0, Number(r.reminder_sent_count) || 0),
    reminderLastSentAt: r.reminder_last_sent_at || '',
    creatorEmail: r.creator_email || '',
    noteFile: r.note_file || null,
  }));
}

function createTodo(title, categoryId = 'cat_default') {
  const id = require('crypto').randomBytes(8).toString('hex') + require('crypto').randomBytes(4).toString('hex');
  const now = new Date().toISOString();
  db.run(`INSERT INTO todos (id, title, completed, category_id, progress, created_at, reminder_enabled, reminder_time, reminder_mode, reminder_weekdays, reminder_repeat_count, reminder_sent_count, reminder_last_sent_at, creator_email, note_file)
    VALUES (?, ?, 0, ?, 0, ?, 0, '', 'once', '[]', 1, 0, '', '', '')`, [id, title, categoryId, now]);
  saveDB();
  return getTodos().find(t => t.id === id);
}

function updateTodo(id, kwargs) {
  const fields = [];
  const values = [];
  // JS → DB 字段名映射
  const fieldMap = {
    title: 'title',
    completed: 'completed',
    categoryId: 'category_id',
    progress: 'progress',
    reminderEnabled: 'reminder_enabled',
    reminderTime: 'reminder_time',
    reminderMode: 'reminder_mode',
    reminderWeekdays: 'reminder_weekdays',
    reminderRepeatCount: 'reminder_repeat_count',
    reminderSentCount: 'reminder_sent_count',
    reminderLastSentAt: 'reminder_last_sent_at',
    creatorEmail: 'creator_email',
    noteFile: 'note_file',
  };
  for (const [jsKey, dbKey] of Object.entries(fieldMap)) {
    if (kwargs[jsKey] !== undefined) {
      let val = kwargs[jsKey];
      if (typeof val === 'boolean') val = val ? 1 : 0;
      if (jsKey === 'reminderWeekdays') val = JSON.stringify(Array.isArray(val) ? val : []);
      fields.push(`${dbKey}=?`);
      values.push(val);
    }
  }
  // 进度100%自动标记完成
  if (kwargs.progress === 100 && kwargs.completed === undefined) {
    fields.push('completed=?');
    values.push(1);
  }
  if (fields.length === 0) return getTodos().find(t => t.id === id);
  values.push(id);
  db.run(`UPDATE todos SET ${fields.join(',')} WHERE id=?`, values);
  saveDB();
  return getTodos().find(t => t.id === id);
}

function deleteTodo(id) {
  db.run('DELETE FROM todos WHERE id=?', [id]);
  saveDB();
  return true;
}

// ── Settings ───────────────────────────────────────────
function getSettings() {
  const result = db.exec('SELECT * FROM settings');
  const rows = rowsToArray(result);
  const map = {};
  rows.forEach(r => { map[r.key] = r.value; });
  return {
    emailEnabled: map['emailEnabled'] === 'true',
    checkTime: map['checkTime'] || '09:00',
  };
}

function saveSettings(emailEnabled, checkTime) {
  db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['emailEnabled', String(!!emailEnabled)]);
  db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['checkTime', checkTime || '09:00']);
  saveDB();
  return getSettings();
}

// ── 从 JSON 迁移 ──────────────────────────────────────
function migrateFromJSON(jsonFile, persist = true) {
  if (!fs.existsSync(jsonFile)) return { status: 'already_migrated' };
  const data = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'));

  // 迁移分类
  for (const cat of (data.categories || [])) {
    try {
      db.run('INSERT OR IGNORE INTO categories (id, name, icon, sort_order) VALUES (?, ?, ?, ?)',
        [cat.id, cat.name, cat.icon || '📋', cat.sort_order ?? cat.order ?? 0]);
    } catch (e) { /* ignore dup */ }
  }

  // 迁移任务
  for (const todo of (data.todos || [])) {
    try {
      const reminderEnabled = todo.reminderEnabled ?? todo.reminder_enabled ?? false;
      const reminderTime = todo.reminderTime ?? todo.reminder_time ?? '';
      const reminderMode = ['once', 'weekly', 'count'].includes(todo.reminderMode) ? todo.reminderMode : 'once';
      const reminderWeekdays = JSON.stringify(parseReminderWeekdays(todo.reminderWeekdays ?? todo.reminder_weekdays));
      const reminderRepeatCount = Math.max(1, Number(todo.reminderRepeatCount ?? todo.reminder_repeat_count) || 1);
      const reminderSentCount = Math.max(0, Number(todo.reminderSentCount ?? todo.reminder_sent_count) || 0);
      const reminderLastSentAt = todo.reminderLastSentAt ?? todo.reminder_last_sent_at ?? '';
      const creatorEmail = todo.creatorEmail ?? todo.creator_email ?? '';
      const noteFile = todo.noteFile ?? todo.note_file ?? '';
      db.run(`INSERT OR IGNORE INTO todos
        (id, title, completed, category_id, progress, created_at, reminder_enabled, reminder_time, reminder_mode, reminder_weekdays, reminder_repeat_count, reminder_sent_count, reminder_last_sent_at, creator_email, note_file)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [todo.id, todo.title, todo.completed ? 1 : 0,
         todo.categoryId || 'cat_default', todo.progress || 0,
         todo.createdAt || '', reminderEnabled ? 1 : 0,
         reminderTime, reminderMode, reminderWeekdays, reminderRepeatCount, reminderSentCount,
         reminderLastSentAt, creatorEmail, noteFile]);
    } catch (e) { /* ignore dup */ }
  }

  if (persist) saveDB();
  return { status: 'migrated', todos: (data.todos || []).length, cats: (data.categories || []).length };
}

module.exports = { initDB, closeDB, saveDB,
  getCategories, createCategory, updateCategory, deleteCategory, reorderCategories,
  getTodos, createTodo, updateTodo, deleteTodo,
  getSettings, saveSettings, migrateFromJSON,
};