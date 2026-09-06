/**
 * 从旧版 data.json 迁移分类和任务到 SQLite。
 *
 * 默认路径适配本地运行和 Docker：
 *   TODO_DATA_DIR=/data
 *   TODO_JSON_FILE=/data/data.json
 *   TODO_DB_FILE=/data/todo.db
 *
 * 目标数据库已存在时默认拒绝覆盖；确认要重做迁移时显式传入 --force。
 */
const fs = require('fs');
const path = require('path');
const initSqlJs = require('./sql-wasm.js');

const DATA_DIR = process.env.TODO_DATA_DIR || __dirname;
const JSON_FILE = process.env.TODO_JSON_FILE || path.join(DATA_DIR, 'data.json');
const DB_FILE = process.env.TODO_DB_FILE || path.join(DATA_DIR, 'todo.db');
const BACKUP_DIR = process.env.TODO_BACKUP_DIR || path.join(DATA_DIR, 'backups');
const args = process.argv.slice(2);
const FORCE = args.includes('--force');

const DEFAULT_CATEGORIES = [
  { id: 'cat_default', name: '默认', icon: '📥', sort_order: 0 },
  { id: 'cat_touzi', name: '投资', icon: '💰', sort_order: 1 },
  { id: 'cat_dianshiju', name: '电视剧', icon: '🎬', sort_order: 2 },
  { id: 'cat_dianying', name: '电影', icon: '🎥', sort_order: 3 },
  { id: 'cat_shuji', name: '书籍', icon: '📚', sort_order: 4 },
  { id: 'cat_youxi', name: '游戏', icon: '🎮', sort_order: 5 },
];

function ensureDir(filepath) {
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
}

function text(value, fallback = '') {
  return value === undefined || value === null ? fallback : String(value);
}

function requiredText(value, label) {
  const result = text(value).trim();
  if (!result) throw new Error(`${label} 不能为空`);
  return result;
}

function normalizeProgress(value) {
  const progress = Number(value);
  if (!Number.isFinite(progress)) return 0;
  return Math.min(100, Math.max(0, Math.round(progress)));
}

function normalizeWeekdays(value) {
  let source = value;
  if (typeof source === 'string' && source.trim()) {
    try { source = JSON.parse(source); } catch (_) { source = []; }
  }
  if (!Array.isArray(source)) return [];
  return [...new Set(source.map(Number).filter(day => Number.isInteger(day) && day >= 1 && day <= 7))].sort((a, b) => a - b);
}

function normalizeNoteFile(value) {
  const filename = text(value).trim();
  return filename && path.basename(filename) === filename ? filename : '';
}

function readSource() {
  if (!fs.existsSync(JSON_FILE)) {
    throw new Error(`找不到源数据文件：${JSON_FILE}`);
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
  } catch (e) {
    throw new Error(`读取源数据失败：${e.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('源数据必须是 JSON 对象');
  }
  if (data.categories !== undefined && !Array.isArray(data.categories)) {
    throw new Error('源数据 categories 必须是数组');
  }
  if (data.todos !== undefined && !Array.isArray(data.todos)) {
    throw new Error('源数据 todos 必须是数组');
  }
  return {
    categories: data.categories || [],
    todos: data.todos || [],
  };
}

function createSchema(db) {
  db.run(`CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT DEFAULT '📥',
    sort_order INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    completed INTEGER DEFAULT 0,
    category_id TEXT,
    progress INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
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
  db.run('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
  db.run('CREATE INDEX IF NOT EXISTS idx_todos_cat ON todos(category_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_todos_created ON todos(created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_todos_reminder ON todos(reminder_enabled, reminder_time)');
}

function migrateCategories(db, categories) {
  const source = categories.length ? categories : DEFAULT_CATEGORIES;
  source.forEach((category, index) => {
    const id = requiredText(category.id, `第 ${index + 1} 个分类 ID`);
    const name = requiredText(category.name, `分类 ${id} 名称`);
    const sortOrder = Number(category.sort_order ?? category.order ?? index);
    db.run('INSERT INTO categories (id, name, icon, sort_order) VALUES (?, ?, ?, ?)', [
      id, name, text(category.icon, '📋'), Number.isFinite(sortOrder) ? sortOrder : index,
    ]);
  });
  return source.length;
}

function migrateTodos(db, todos) {
  const now = new Date().toISOString();
  todos.forEach((todo, index) => {
    const id = requiredText(todo.id, `第 ${index + 1} 个待办 ID`);
    const title = requiredText(todo.title, `待办 ${id} 标题`);
    const completed = todo.completed ? 1 : 0;
    const createdAt = text(todo.createdAt ?? todo.created_at, now);
    const updatedAt = text(todo.updatedAt ?? todo.updated_at, createdAt);
    const reminderEnabled = !completed && !!(todo.reminderEnabled ?? todo.reminder_enabled);
    const reminderMode = ['once', 'weekly', 'count'].includes(todo.reminderMode) ? todo.reminderMode : 'once';
    const reminderRepeatCount = Math.max(1, Number(todo.reminderRepeatCount ?? todo.reminder_repeat_count) || 1);
    const reminderSentCount = Math.max(0, Number(todo.reminderSentCount ?? todo.reminder_sent_count) || 0);
    db.run(`INSERT INTO todos
      (id, title, completed, category_id, progress, created_at, updated_at,
       reminder_enabled, reminder_time, reminder_mode, reminder_weekdays,
       reminder_repeat_count, reminder_sent_count, reminder_last_sent_at,
       creator_email, note_file)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      id,
      title,
      completed,
      text(todo.categoryId ?? todo.category_id, 'cat_default'),
      normalizeProgress(todo.progress),
      createdAt,
      updatedAt,
      reminderEnabled ? 1 : 0,
      text(todo.reminderTime ?? todo.reminder_time),
      reminderMode,
      JSON.stringify(normalizeWeekdays(todo.reminderWeekdays ?? todo.reminder_weekdays)),
      reminderRepeatCount,
      reminderSentCount,
      text(todo.reminderLastSentAt ?? todo.reminder_last_sent_at),
      text(todo.creatorEmail ?? todo.creator_email),
      normalizeNoteFile(todo.noteFile ?? todo.note_file),
    ]);
  });
  return todos.length;
}

function backupExistingDatabase() {
  if (!FORCE || !fs.existsSync(DB_FILE)) return null;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('Z', '');
  const backupFile = path.join(BACKUP_DIR, `todo-pre-migrate-${stamp}.db`);
  fs.copyFileSync(DB_FILE, backupFile);
  return backupFile;
}

function writeDatabase(buffer) {
  ensureDir(DB_FILE);
  const tempFile = `${DB_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempFile, buffer, { mode: 0o600 });
    fs.renameSync(tempFile, DB_FILE);
  } catch (e) {
    try { fs.unlinkSync(tempFile); } catch (_) {}
    throw e;
  }
}

async function main() {
  const unknownArgs = args.filter(arg => arg !== '--force');
  if (unknownArgs.length) throw new Error(`未知参数：${unknownArgs.join(' ')}，可用参数只有 --force`);
  if (fs.existsSync(DB_FILE) && !FORCE) {
    throw new Error(`目标数据库已存在：${DB_FILE}；如确认覆盖，请使用 --force`);
  }

  const data = readSource();
  const previousDatabase = backupExistingDatabase();
  const SQL = await initSqlJs({ locateFile: filename => path.join(__dirname, filename) });
  const db = new SQL.Database();
  try {
    createSchema(db);
    const categoryCount = migrateCategories(db, data.categories);
    const todoCount = migrateTodos(db, data.todos);
    const buffer = Buffer.from(db.export());
    writeDatabase(buffer);
    const categoryRows = db.exec('SELECT COUNT(*) FROM categories')[0].values[0][0];
    const todoRows = db.exec('SELECT COUNT(*) FROM todos')[0].values[0][0];
    console.log(`迁移完成：${categoryCount} 个分类，${todoCount} 个待办`);
    console.log(`验证通过：数据库内 ${categoryRows} 个分类，${todoRows} 个待办`);
    console.log('已写入：', DB_FILE);
    if (previousDatabase) console.log('原数据库备份：', previousDatabase);
  } finally {
    db.close();
  }
}

main().catch(error => {
  console.error(`[MIGRATE] ${error.message}`);
  process.exitCode = 1;
});
