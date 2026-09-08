/**
 * TODO App Server - 纯 Node.js 实现
 * SQLite: sql.js (WASM)
 * Email: nodemailer
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const initSqlJs = require('./sql-wasm.js');

const PORT = Number(process.env.PORT) || 8238;
const HOST = process.env.HOST || '127.0.0.1';
const DB_PY = null; // 不再调用 Python
const DATA_DIR = process.env.TODO_DATA_DIR || __dirname;
const NOTES_DIR = process.env.TODO_NOTES_DIR || path.join(DATA_DIR, 'notes');
const LOCAL_BACKUP_DIR = process.env.TODO_BACKUP_DIR || path.join(DATA_DIR, 'backups');
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;
const MAX_NOTE_BODY_BYTES = 4 * 1024 * 1024;
const DB_FILE = process.env.TODO_DB_FILE || path.join(DATA_DIR, 'todo.db');
const BACKUP_PATHS = { rootDir: __dirname, dbFile: DB_FILE, notesDir: NOTES_DIR };

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ── 环境变量加载（读取 /etc/environment）──────────────────
// /etc/environment 仅在部分 Linux 环境中存在；本机开发环境缺失时直接跳过。
if (fs.existsSync('/etc/environment')) {
  fs.readFileSync('/etc/environment', 'utf-8').split('\n').forEach(line => {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  });
}

function normalizeHttpOrigin(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch (_) {
    return null;
  }
}

// A reverse proxy terminates HTTPS before the Node process sees the request.
// Trust only explicitly configured public origins; never infer them from
// X-Forwarded-Proto or another client-controlled header.
const ALLOWED_ORIGINS = new Set(
  String(process.env.TODO_ALLOWED_ORIGINS || '')
    .split(',')
    .map(normalizeHttpOrigin)
    .filter(Boolean),
);

// ── 加载模块 ─────────────────────────────────────────────
const { initDB, closeDB, saveDB,
  getCategories, createCategory, updateCategory, deleteCategory, reorderCategories,
  getTodos, createTodo, updateTodo, touchTodoUpdatedAt, deleteTodo,
  getSettings, saveSettings, migrateFromJSON } = require('./sqlite.js');
const { sendEmail, sendTestEmail } = require('./email.js');
const { getFullConfig, saveAppConfig, publicAppConfig, isEmailConfigured, migrateStoredConfigSecrets } = require('./appConfig.js');
const { getBackupConfig, publicBackupStatus, testBackupConfig, uploadBackup, restoreBackup } = require('./cloudBackup.js');

// ── MIME 类型 ────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

// Only these files are part of the browser client. Runtime data and source
// files must never be reachable through the static file handler.
const PUBLIC_FILES = Object.freeze({
  '/': 'index.html',
  '/index.html': 'index.html',
  '/USAGE.md': 'USAGE.md',
  '/sql-wasm.js': 'sql-wasm.js',
  '/sql-wasm.wasm': 'sql-wasm.wasm',
});
const PUBLIC_ROOT = path.resolve(__dirname);
const REMINDER_GRACE_MS = 90 * 1000;

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

const REMINDER_MODES = new Set(['once', 'weekly', 'count']);
const PRIORITY_LEVELS = new Set([0, 1, 2]);
const WEEKDAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const MAX_REMINDER_NOTE_CHARS = 4000;

function normalizeReminderWeekdays(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter(day => Number.isInteger(day) && day >= 1 && day <= 7))].sort((a, b) => a - b);
}

function localDateKey(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isoWeekday(date) {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

function wasReminderSentOnLocalDate(value, date) {
  if (!value) return false;
  const sentAt = new Date(value);
  return !Number.isNaN(sentAt.getTime()) && localDateKey(sentAt) === localDateKey(date);
}

function reminderScheduleAt(todo, date) {
  if (!isValidTime(todo.reminderTime)) return null;
  const [hours, minutes] = todo.reminderTime.split(':').map(Number);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes, 0, 0);
}

function isReminderDue(todo, now) {
  const scheduledAt = reminderScheduleAt(todo, now);
  if (!scheduledAt) return false;
  const elapsed = now.getTime() - scheduledAt.getTime();
  return elapsed >= 0 && elapsed <= REMINDER_GRACE_MS;
}

function sameReminderConfiguration(left, right) {
  return !!left?.reminderEnabled === !!right?.reminderEnabled &&
    (left?.reminderTime || '') === (right?.reminderTime || '') &&
    (left?.reminderMode || 'once') === (right?.reminderMode || 'once') &&
    Number(left?.reminderRepeatCount || 1) === Number(right?.reminderRepeatCount || 1) &&
    JSON.stringify(normalizeReminderWeekdays(left?.reminderWeekdays)) ===
      JSON.stringify(normalizeReminderWeekdays(right?.reminderWeekdays));
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
    updateTodo(todo.id, { noteFile }, { touchUpdatedAt: false });
  }
  return { noteFile, filepath };
}

function reminderWeekdayText(days = []) {
  const names = normalizeReminderWeekdays(days).map(day => WEEKDAY_NAMES[day]).filter(Boolean);
  return names.length ? names.join('、') : '未选择星期';
}

function reminderRuleText(todo, mode) {
  if (mode === 'weekly') return `每周重复：${reminderWeekdayText(todo.reminderWeekdays)}`;
  if (mode === 'count') {
    const total = Math.max(1, Number(todo.reminderRepeatCount) || 1);
    const sent = Math.max(0, Number(todo.reminderSentCount) || 0);
    const next = Math.min(sent + 1, total);
    return `按次数重复：${reminderWeekdayText(todo.reminderWeekdays)}，共 ${total} 次，当前第 ${next}/${total} 次`;
  }
  return '单次提醒：发送成功后自动关闭';
}

function readReminderNote(todo) {
  const candidates = [notePathFor(todo)];
  if (todo.noteFile && path.basename(todo.noteFile) === todo.noteFile) {
    candidates.push(path.join(NOTES_DIR, todo.noteFile));
  }
  for (const filepath of new Set(candidates)) {
    try {
      if (!fs.existsSync(filepath)) continue;
      const note = fs.readFileSync(filepath, 'utf8').trim();
      if (!note) return '（笔记为空）';
      if (note.length <= MAX_REMINDER_NOTE_CHARS) return note;
      return `${note.slice(0, MAX_REMINDER_NOTE_CHARS)}\n\n……（笔记内容较长，已截断）`;
    } catch (e) {
      console.error(`[REMINDER] read note failed: ${e.message}`);
    }
  }
  return '（暂无笔记内容）';
}

function escapeEmailHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeEmailMarkdownUrl(value) {
  const decoded = String(value || '').trim();
  try {
    const parsed = new URL(decoded);
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return null;
    return escapeEmailHtml(decoded);
  } catch (_) {
    return null;
  }
}

function inlineMarkdownToEmailHtml(value) {
  let html = escapeEmailHtml(value);
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, href) => {
    const safeHref = safeEmailMarkdownUrl(href);
    return safeHref
      ? `<a href="${safeHref}" style="color:#667eea;text-decoration:underline;" rel="noopener noreferrer">${label}</a>`
      : label;
  });
  return html
    .replace(/`([^`]+)`/g, '<code style="padding:2px 5px;background:#edf0f5;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.9em;">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');
}

function markdownToEmailHtml(markdown) {
  if (!markdown || !markdown.trim()) return '<p style="margin:0;color:#718096;">（笔记为空）</p>';
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let html = '';
  let inCode = false;
  let codeLines = [];
  let tableRows = [];

  const parseTableRow = row => row.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
  const isTableDivider = row => /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?$/.test(row.trim());
  const flushTable = () => {
    if (!tableRows.length) return;
    const rows = tableRows.filter(row => !isTableDivider(row));
    if (rows.length < 2) {
      html += rows.map(row => `<p style="margin:0 0 10px;">${inlineMarkdownToEmailHtml(row)}</p>`).join('');
      tableRows = [];
      return;
    }
    const [header, ...body] = rows.map(parseTableRow);
    html += `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:14px 0;border-collapse:collapse;font-size:13px;"><thead><tr>${header.map(cell => `<th style="padding:8px 10px;border:1px solid #e2e8f0;background:#f8fafc;text-align:left;">${inlineMarkdownToEmailHtml(cell)}</th>`).join('')}</tr></thead><tbody>${body.map(row => `<tr>${row.map(cell => `<td style="padding:8px 10px;border:1px solid #e2e8f0;vertical-align:top;">${inlineMarkdownToEmailHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    tableRows = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      if (inCode) {
        html += `<pre style="margin:14px 0;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;overflow:auto;white-space:pre-wrap;word-break:break-word;"><code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;">${escapeEmailHtml(codeLines.join('\n'))}</code></pre>`;
        codeLines = [];
        inCode = false;
      } else {
        flushTable();
        inCode = true;
        codeLines = [];
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      tableRows.push(trimmed);
      continue;
    }
    flushTable();

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length, 4);
      const size = level === 1 ? '20px' : level === 2 ? '17px' : level === 3 ? '15px' : '14px';
      html += `<h${level} style="margin:18px 0 8px;color:#1a202c;font-size:${size};line-height:1.4;">${inlineMarkdownToEmailHtml(heading[2])}</h${level}>`;
      continue;
    }
    if (/^[-*]\s+/.test(trimmed) && !/^[-*]\s+\[[ xX]\]/.test(trimmed)) {
      const items = [];
      while (i < lines.length) {
        const item = lines[i].trim();
        if (!/^[-*]\s+/.test(item)) break;
        items.push(item.replace(/^[-*]\s+/, ''));
        i++;
      }
      i--;
      html += `<ul style="margin:10px 0;padding-left:22px;">${items.map(item => `<li style="margin:4px 0;">${inlineMarkdownToEmailHtml(item)}</li>`).join('')}</ul>`;
      continue;
    }
    if (/^\d+\.\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length) {
        const item = lines[i].trim();
        const match = item.match(/^\d+\.\s+(.*)$/);
        if (!match) break;
        items.push(match[1]);
        i++;
      }
      i--;
      html += `<ol style="margin:10px 0;padding-left:22px;">${items.map(item => `<li style="margin:4px 0;">${inlineMarkdownToEmailHtml(item)}</li>`).join('')}</ol>`;
      continue;
    }
    if (/^- \[[ xX]\]\s*/.test(trimmed)) {
      const items = [];
      while (i < lines.length) {
        const item = lines[i].trim();
        const match = item.match(/^- \[([ xX])\]\s*(.*)$/);
        if (!match) break;
        const checked = match[1].toLowerCase() === 'x';
        items.push(`<li style="margin:4px 0;list-style:none;"><span style="color:${checked ? '#38a169' : '#a0aec0'};font-size:16px;">${checked ? '☑' : '☐'}</span> ${inlineMarkdownToEmailHtml(match[2])}</li>`);
        i++;
      }
      i--;
      html += `<ul style="margin:10px 0;padding-left:0;">${items.join('')}</ul>`;
      continue;
    }
    if (trimmed.startsWith('> ')) {
      const quotes = [];
      while (i < lines.length && lines[i].trim().startsWith('> ')) {
        quotes.push(lines[i].trim().slice(2));
        i++;
      }
      i--;
      html += `<blockquote style="margin:12px 0;padding:8px 14px;background:#f8fafc;border-left:1px solid #667eea;color:#4a5568;">${quotes.map(quote => inlineMarkdownToEmailHtml(quote)).join('<br>')}</blockquote>`;
      continue;
    }
    if (trimmed === '---' || trimmed === '***') {
      html += '<hr style="margin:18px 0;border:0;border-top:1px solid #e2e8f0;">';
      continue;
    }
    if (trimmed === '') continue;
    html += `<p style="margin:0 0 10px;">${inlineMarkdownToEmailHtml(line)}</p>`;
  }
  if (inCode) html += `<pre style="margin:14px 0;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;overflow:auto;white-space:pre-wrap;word-break:break-word;"><code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;">${escapeEmailHtml(codeLines.join('\n'))}</code></pre>`;
  flushTable();
  return html || '<p style="margin:0;color:#718096;">（笔记为空）</p>';
}

function buildReminderEmail(todo, mode) {
  const progress = Number.isFinite(Number(todo.progress)) ? Math.max(0, Math.min(100, Number(todo.progress))) : 0;
  const completion = todo.completed ? 100 : progress;
  const title = todo.title || '未命名任务';
  const reminderTime = todo.reminderTime || '未设置';
  const rule = reminderRuleText(todo, mode);
  const note = readReminderNote(todo);
  const text = [
    '🔔 该处理这件事了',
    title,
    '',
    '任务概览',
    `提醒时间：${reminderTime}`,
    `重复规则：${rule}`,
    `完成进度：${completion}%`,
    '当前状态：待完成',
    '',
    '📝 关联笔记',
    '────────────────────────',
    note,
    '',
    '建议：打开 TODO App，完成或更新这项任务。',
    '此邮件由 TODO App 自动发送。',
  ].join('\n');

  const safeTitle = escapeEmailHtml(title);
  const safeReminderTime = escapeEmailHtml(reminderTime);
  const safeRule = escapeEmailHtml(rule);
  const noteHtml = markdownToEmailHtml(note);
  const html = `
    <div style="margin:0;background:#f6f7fb;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans SC',Arial,sans-serif;color:#1a202c;line-height:1.6;">
      <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${safeTitle} · 待处理提醒</div>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:620px;margin:0 auto;border-collapse:separate;border-spacing:0;">
        <tr>
          <td style="background:#667eea;border-radius:16px 16px 0 0;padding:28px 32px;color:#fff;">
            <div style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;opacity:.84;">TODO APP</div>
            <div style="font-size:24px;font-weight:700;line-height:1.3;margin-top:8px;">🔔 该处理这件事了</div>
          </td>
        </tr>
        <tr>
          <td style="background:#fff;border:1px solid #e2e8f0;border-top:0;border-radius:0 0 16px 16px;padding:28px 32px;">
            <div style="font-size:22px;font-weight:700;line-height:1.4;word-break:break-word;">${safeTitle}</div>
            <div style="display:inline-block;margin-top:12px;padding:4px 10px;border-radius:999px;background:#fff3cd;color:#8a5a00;font-size:12px;font-weight:700;">待完成</div>

            <div style="margin-top:24px;border-top:1px solid #edf0f5;border-bottom:1px solid #edf0f5;padding:18px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
                <tr>
                  <td style="width:50%;padding:0 16px 12px 0;vertical-align:top;">
                    <div style="font-size:12px;color:#718096;">提醒时间</div>
                    <div style="font-size:15px;font-weight:600;margin-top:2px;">${safeReminderTime}</div>
                  </td>
                  <td style="width:50%;padding:0 0 12px 16px;vertical-align:top;">
                    <div style="font-size:12px;color:#718096;">重复规则</div>
                    <div style="font-size:15px;font-weight:600;margin-top:2px;word-break:break-word;">${safeRule}</div>
                  </td>
                </tr>
              </table>
              <div style="font-size:12px;color:#718096;margin-top:4px;">完成进度 <strong style="color:#38a169;">${completion}%</strong></div>
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:8px;border-collapse:collapse;background:#e2e8f0;border-radius:999px;overflow:hidden;">
                <tr><td style="height:8px;background:#38ef7d;border-radius:999px;width:${completion}%;font-size:0;line-height:0;">&nbsp;</td><td style="font-size:0;line-height:0;">&nbsp;</td></tr>
              </table>
            </div>

            <div style="margin-top:22px;padding:18px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
              <div style="font-size:13px;font-weight:700;color:#4a5568;margin-bottom:8px;">📝 关联笔记</div>
              <div style="font-size:14px;color:#4a5568;word-break:break-word;">${noteHtml}</div>
            </div>

            <div style="font-size:13px;color:#718096;margin-top:22px;">建议：打开 TODO App，完成或更新这项任务。</div>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 8px 0;text-align:center;font-size:12px;color:#a0aec0;">此邮件由 TODO App 自动发送</td>
        </tr>
      </table>
    </div>
  `;

  return { text, html };
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

function isSameOriginRequest(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  if (origin === 'null') return false;
  const host = req.headers?.host;
  if (!host) return false;
  try {
    const normalizedOrigin = normalizeHttpOrigin(origin);
    if (!normalizedOrigin) return false;
    if (ALLOWED_ORIGINS.has(normalizedOrigin)) return true;
    const protocol = req.socket?.encrypted ? 'https:' : 'http:';
    return normalizedOrigin === normalizeHttpOrigin(`${protocol}//${host}`);
  } catch (_) {
    return false;
  }
}

function publicFilePath(pathname) {
  const relativePath = PUBLIC_FILES[pathname];
  if (!relativePath) return null;
  const filePath = path.resolve(PUBLIC_ROOT, relativePath);
  if (filePath !== PUBLIC_ROOT && !filePath.startsWith(`${PUBLIC_ROOT}${path.sep}`)) return null;
  return filePath;
}

// ── HTTP 服务器 ──────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const isApiPath = pathname === '/api' || pathname.startsWith('/api/');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (req.headers?.origin) res.setHeader('Vary', 'Origin');
  if (isApiPath && !isSameOriginRequest(req)) {
    jsonRes(res, { error: '仅允许同源请求' }, 403);
    return;
  }
  if (req.method === 'OPTIONS') {
    if (isApiPath && req.headers?.origin) {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    res.writeHead(204);
    res.end();
    return;
  }
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
      const result = await runBackup();
      lastBackup = result;
      jsonResR(result);
    } catch (e) {
      lastBackup = { success: false, error: e.message, createdAt: new Date().toISOString() };
      jsonResR({ error: e.message }, 500);
    }
    return;
  }

  if (pathname === '/api/backup/restore' && req.method === 'POST') {
    withBody(async (payload) => {
      try {
        const snapshot = typeof payload.snapshot === 'string' && payload.snapshot.trim()
          ? payload.snapshot.trim()
          : 'latest';
        const result = await restoreBackupToCurrentData(snapshot);
        jsonResR(result);
      } catch (e) { jsonResR({ error: e.message }, 500); }
    });
    return;
  }

  if (pathname === '/api/backup/sync' && req.method === 'POST') {
    try {
      const result = await syncBackupToCurrentData();
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
      withBody(async ({ title, categoryId, priority }) => {
        if (!isNonEmptyString(title, 200)) { jsonResR({ error: '标题必须是 1-200 个字符的非空字符串' }, 400); return; }
        if (priority !== undefined && (!Number.isInteger(priority) || !PRIORITY_LEVELS.has(priority))) {
          jsonResR({ error: 'priority 必须是 0、1 或 2' }, 400); return;
        }
        const selectedCategoryId = categoryId || defaultCategoryId();
        if (!selectedCategoryId || !hasCategory(selectedCategoryId)) {
          jsonResR({ error: 'Category not found' }, 400); return;
        }
        try { jsonResR(createTodo(title.trim(), selectedCategoryId, priority ?? 0)); }
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
        const currentTodo = findTodo(id) || todo;
        if (currentTodo?.completed) {
          const updateKeys = Object.keys(updates);
          const isReopening = updates.completed === false && updateKeys.every(key =>
            key === 'completed' || (key === 'progress' && updates.progress === 0));
          const isCompletedNoop = updates.completed === true && updateKeys.every(key => key === 'completed');
          if (!isReopening && !isCompletedNoop) {
            jsonResR({ error: '任务已完成，请先重新打开任务后再编辑' }, 409); return;
          }
        }
        if (updates.categoryId !== undefined && !hasCategory(updates.categoryId)) {
          jsonResR({ error: 'Category not found' }, 400); return;
        }
        if (updates.progress !== undefined &&
            (!Number.isInteger(updates.progress) || updates.progress < 0 || updates.progress > 100)) {
          jsonResR({ error: 'progress 必须是 0-100 的整数' }, 400); return;
        }
        if (updates.priority !== undefined && (!Number.isInteger(updates.priority) || !PRIORITY_LEVELS.has(updates.priority))) {
          jsonResR({ error: 'priority 必须是 0、1 或 2' }, 400); return;
        }
        if (updates.reminderEnabled !== undefined && typeof updates.reminderEnabled !== 'boolean') {
          jsonResR({ error: 'reminderEnabled 必须是布尔值' }, 400); return;
        }
        if (updates.reminderTime !== undefined && updates.reminderTime !== '' && !isValidTime(updates.reminderTime)) {
          jsonResR({ error: 'reminderTime 必须是 HH:MM 格式或留空' }, 400); return;
        }
        if (updates.reminderMode !== undefined && !REMINDER_MODES.has(updates.reminderMode)) {
          jsonResR({ error: 'reminderMode 必须是 once、weekly 或 count' }, 400); return;
        }
        if (updates.reminderWeekdays !== undefined &&
            (!Array.isArray(updates.reminderWeekdays) || normalizeReminderWeekdays(updates.reminderWeekdays).length !== updates.reminderWeekdays.length)) {
          jsonResR({ error: 'reminderWeekdays 必须是 1-7 之间的星期数组' }, 400); return;
        }
        if (updates.reminderRepeatCount !== undefined &&
            (!Number.isInteger(updates.reminderRepeatCount) || updates.reminderRepeatCount < 1 || updates.reminderRepeatCount > 1000)) {
          jsonResR({ error: 'reminderRepeatCount 必须是 1-1000 的整数' }, 400); return;
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
          if (updates.priority !== undefined) kw.priority = updates.priority;
          if (updates.reminderEnabled !== undefined) kw.reminderEnabled = updates.reminderEnabled;
          if (updates.reminderTime !== undefined) kw.reminderTime = updates.reminderTime;
          if (updates.reminderMode !== undefined) kw.reminderMode = updates.reminderMode;
          if (updates.reminderWeekdays !== undefined) kw.reminderWeekdays = normalizeReminderWeekdays(updates.reminderWeekdays);
          if (updates.reminderRepeatCount !== undefined) kw.reminderRepeatCount = updates.reminderRepeatCount;
          if (updates.reminderSentCount !== undefined) kw.reminderSentCount = Math.max(0, Number(updates.reminderSentCount) || 0);
          if (updates.reminderLastSentAt !== undefined) kw.reminderLastSentAt = cleanString(updates.reminderLastSentAt, 80);
          if (updates.creatorEmail !== undefined) kw.creatorEmail = updates.creatorEmail.trim();
          const effectiveMode = kw.reminderMode !== undefined ? kw.reminderMode : (currentTodo.reminderMode || 'once');
          const effectiveWeekdays = kw.reminderWeekdays !== undefined ? kw.reminderWeekdays : (currentTodo.reminderWeekdays || []);
          const effectiveRepeatCount = kw.reminderRepeatCount !== undefined ? kw.reminderRepeatCount : (currentTodo.reminderRepeatCount || 1);
          const completing = updates.completed === true || (updates.completed === undefined && updates.progress === 100);
          const effectiveEnabled = completing
            ? false
            : (kw.reminderEnabled !== undefined ? kw.reminderEnabled : currentTodo.reminderEnabled);
          const effectiveTime = kw.reminderTime !== undefined ? kw.reminderTime : currentTodo.reminderTime;
          if (effectiveEnabled && !isValidTime(effectiveTime)) {
            jsonResR({ error: '启用提醒时必须设置有效的提醒时间' }, 400); return;
          }
          if (effectiveEnabled && ['weekly', 'count'].includes(effectiveMode) && effectiveWeekdays.length === 0) {
            jsonResR({ error: '每周重复或重复次数提醒至少选择一个星期' }, 400); return;
          }
          const reminderFieldsTouched = ['reminderEnabled', 'reminderTime', 'reminderMode', 'reminderWeekdays', 'reminderRepeatCount']
            .some(key => updates[key] !== undefined);
          const reminderRuleChanged = reminderFieldsTouched && (
            !!effectiveEnabled !== !!currentTodo.reminderEnabled ||
            (effectiveTime || '') !== (currentTodo.reminderTime || '') ||
            effectiveMode !== (currentTodo.reminderMode || 'once') ||
            Number(effectiveRepeatCount || 1) !== Number(currentTodo.reminderRepeatCount || 1) ||
            JSON.stringify(normalizeReminderWeekdays(effectiveWeekdays)) !==
              JSON.stringify(normalizeReminderWeekdays(currentTodo.reminderWeekdays))
          );
          // Reset only when the effective rule really changed. The settings
          // form sends the complete rule on every save, so checking field
          // presence would incorrectly erase the sent count on a no-op save.
          if (reminderRuleChanged) {
            kw.reminderSentCount = 0;
            kw.reminderLastSentAt = '';
          }
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
        const currentTodo = findTodo(id);
        if (currentTodo?.completed) {
          jsonResR({ error: '任务已完成，Markdown 仅可查看' }, 409); return;
        }
        try {
          const { noteFile, filepath } = ensureNoteFile(currentTodo || todo);
          writeTextAtomic(filepath, content);
          if ((currentTodo || todo).noteFile !== noteFile) updateTodo(id, { noteFile });
          const updated = touchTodoUpdatedAt(id);
          jsonResR({ ...(updated || {}), id, noteFile, success: true });
        } catch (e) { jsonResR({ error: e.message }, 500); }
      }, MAX_NOTE_BODY_BYTES);
      return;
    }
    jsonResR({ error: 'Not found' }, 404); return;
  }

  // ── 静态文件 ─────────────────────────────────────────
  if (!['GET', 'HEAD'].includes(req.method)) {
    jsonResR({ error: 'Not found' }, 404);
    return;
  }
  const filePath = publicFilePath(pathname);
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'text/plain';
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': content.length });
    res.end(req.method === 'HEAD' ? undefined : content);
  });
});

// ── Cron（每分钟检查任务提醒）────────────────────────────
let cronTimer = null;
const reminderInFlight = new Set();

function stopCron() {
  if (cronTimer) { clearInterval(cronTimer); cronTimer = null; console.log('[CRON] stopped'); }
}

async function runReminderTick() {
  if (restoreInFlight) return;
  try {
    const emailConfig = getFullConfig().email;
    if (!emailConfig.enabled || !isEmailConfigured(emailConfig)) return;
    const now = new Date();
    const weekday = isoWeekday(now);
    const todos = getTodos();
    for (const todo of todos) {
      if (todo.completed || !todo.reminderEnabled || !todo.reminderTime) continue;
      // Check a short grace window so timer startup/jitter does not silently
      // lose a reminder, while avoiding broad catch-up after a long outage.
      if (!isReminderDue(todo, now)) continue;
      if (wasReminderSentOnLocalDate(todo.reminderLastSentAt, now)) continue;
      const mode = REMINDER_MODES.has(todo.reminderMode) ? todo.reminderMode : 'once';
      if (mode !== 'once' && !todo.reminderWeekdays.includes(weekday)) continue;
      if (mode === 'count' && todo.reminderSentCount >= todo.reminderRepeatCount) {
        updateTodo(todo.id, { reminderEnabled: false });
        continue;
      }
      const recipient = todo.creatorEmail || emailConfig.recipients;
      if (!recipient || reminderInFlight.has(todo.id)) continue;
      reminderInFlight.add(todo.id);
      try {
        const reminderEmail = buildReminderEmail(todo, mode);
        await sendEmail(
          recipient,
          `📋 任务提醒：${todo.title}`,
          reminderEmail.text,
          { email: emailConfig, html: reminderEmail.html }
        );

        if (restoreInFlight) continue;

        // Re-read after SMTP returns. Completion, manual disable, or a rule
        // edit made while sending must win over this old snapshot.
        const current = findTodo(todo.id);
        if (!current || current.completed || !current.reminderEnabled ||
            !sameReminderConfiguration(current, todo)) {
          continue;
        }
        const sentCount = current.reminderSentCount + 1;
        const finished = mode === 'once' || (mode === 'count' && sentCount >= current.reminderRepeatCount);
        updateTodo(current.id, {
          reminderEnabled: !finished,
          reminderSentCount: sentCount,
          reminderLastSentAt: new Date().toISOString(),
        });
        console.log(`[REMINDER] sent: ${current.id} (${mode}, ${sentCount}${mode === 'count' ? `/${current.reminderRepeatCount}` : ''})`);
      } catch (e) {
        console.error(`[REMINDER] Failed: ${e.message}`);
      } finally {
        reminderInFlight.delete(todo.id);
      }
    }
  } catch (e) { console.error('[CRON] error:', e.message); }
}

function startCron() {
  stopCron();
  runReminderTick().catch(e => console.error('[CRON] initial check error:', e.message));
  cronTimer = setInterval(runReminderTick, 60 * 1000);
  console.log('[CRON] started');
}


// ── Cloud backup timer ───────────────────────────────────
let backupTimer = null;
let lastBackup = null;
let backupInFlight = null;
let restoreInFlight = false;
let syncInFlight = false;

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
      lastBackup = await runBackup();
      console.log(`[BACKUP] uploaded: ${lastBackup.remotePath}`);
    } catch (e) {
      lastBackup = { success: false, error: e.message, createdAt: new Date().toISOString() };
      console.error('[BACKUP] failed:', e.message);
    }
  }, intervalMs);
  console.log(`[BACKUP] auto enabled: every ${config.intervalHours}h`);
}

async function runBackup() {
  if (restoreInFlight || syncInFlight) throw new Error('数据同步正在进行，请稍候再备份');
  if (backupInFlight) return backupInFlight;
  backupInFlight = (async () => {
    saveDB();
    return uploadBackup(BACKUP_PATHS, getBackupConfig());
  })();
  try {
    return await backupInFlight;
  } finally {
    backupInFlight = null;
  }
}

function timestampForRestore() {
  return new Date().toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .replace(/\.\d{3}Z$/, '');
}

function nextRestorePath(prefix) {
  const stamp = timestampForRestore();
  let candidate = path.join(DATA_DIR, `.${prefix}-${stamp}`);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(DATA_DIR, `.${prefix}-${stamp}-${suffix++}`);
  }
  return candidate;
}

function nextRestoreSafetyPath(prefix = 'restore') {
  const stamp = timestampForRestore();
  let candidate = path.join(LOCAL_BACKUP_DIR, `${prefix}-${stamp}`);
  let suffix = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(LOCAL_BACKUP_DIR, `${prefix}-${stamp}-${suffix++}`);
  }
  return candidate;
}

function copyRestoreSafetyFiles(safetyDir) {
  fs.mkdirSync(safetyDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(DB_FILE)) {
    fs.copyFileSync(DB_FILE, path.join(safetyDir, 'todo.db'));
  }
  if (fs.existsSync(NOTES_DIR)) {
    fs.cpSync(NOTES_DIR, path.join(safetyDir, 'notes'), { recursive: true, force: false });
  }
}

function moveRestoreEntry(source, target, options = {}) {
  const isDirectory = options.directory === true;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.renameSync(source, target);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    if (isDirectory) fs.cpSync(source, target, { recursive: true, force: false });
    else fs.copyFileSync(source, target);
    fs.rmSync(source, { recursive: isDirectory, force: true });
  }
}

function replaceRestoredData(stageDir) {
  const stageDb = path.join(stageDir, 'todo.db');
  const stageNotes = path.join(stageDir, 'notes');
  if (!fs.existsSync(stageDb) || !fs.existsSync(stageNotes)) {
    throw new Error('恢复目录内容不完整');
  }
  if (fs.existsSync(DB_FILE)) fs.rmSync(DB_FILE, { force: true });
  moveRestoreEntry(stageDb, DB_FILE);
  if (fs.existsSync(NOTES_DIR)) fs.rmSync(NOTES_DIR, { recursive: true, force: true });
  moveRestoreEntry(stageNotes, NOTES_DIR, { directory: true });
}

async function rollbackRestoredData(safetyDir) {
  try { closeDB(); } catch (_) {}
  const safetyDb = path.join(safetyDir, 'todo.db');
  const safetyNotes = path.join(safetyDir, 'notes');
  fs.rmSync(DB_FILE, { force: true });
  if (fs.existsSync(safetyDb)) {
    fs.copyFileSync(safetyDb, DB_FILE);
  }
  fs.rmSync(NOTES_DIR, { recursive: true, force: true });
  if (fs.existsSync(safetyNotes)) {
    moveRestoreEntry(safetyNotes, NOTES_DIR, { directory: true });
  }
  await initDB();
}

async function restoreBackupToCurrentData(snapshot = 'latest') {
  if (restoreInFlight) throw new Error('已有恢复任务正在执行，请稍候');
  if (backupInFlight) throw new Error('备份正在进行，请稍候再恢复');
  restoreInFlight = true;
  const stageDir = nextRestorePath('todo-restore');
  const safetyDir = nextRestoreSafetyPath();
  let servicesStopped = false;
  let databaseClosed = false;
  try {
    // Download and verify the complete snapshot before touching live data.
    const restored = await restoreBackup(getBackupConfig(), { snapshot, outputDir: stageDir });

    stopCron();
    stopBackupTimer();
    servicesStopped = true;
    closeDB();
    databaseClosed = true;
    copyRestoreSafetyFiles(safetyDir);
    replaceRestoredData(stageDir);
    await initDB();

    const config = getFullConfig();
    if (config.email.enabled && isEmailConfigured(config.email)) startCron();
    startBackupTimer();
    servicesStopped = false;
    const { outputDir: _stageDir, ...restoreSummary } = restored;
    return {
      ...restoreSummary,
      active: true,
      safetyBackupDir: safetyDir,
      message: '恢复完成，当前应用已切换到该快照；恢复前数据保存在本地安全备份目录。',
    };
  } catch (e) {
    if (databaseClosed) {
      try {
        await rollbackRestoredData(safetyDir);
      } catch (rollbackError) {
        throw new Error(`${e.message}；自动回滚失败：${rollbackError.message}`);
      }
    }
    throw e;
  } finally {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch (_) {}
    if (servicesStopped) {
      const config = getFullConfig();
      if (config.email.enabled && isEmailConfigured(config.email)) startCron();
      startBackupTimer();
    }
    restoreInFlight = false;
  }
}

const TODO_DB_COLUMNS = [
  'id', 'title', 'completed', 'category_id', 'progress', 'priority',
  'created_at', 'updated_at', 'reminder_enabled', 'reminder_time',
  'reminder_mode', 'reminder_weekdays', 'reminder_repeat_count',
  'reminder_sent_count', 'reminder_last_sent_at', 'creator_email', 'note_file',
];

function rowsFromDatabase(database, table) {
  const result = database.exec(`SELECT * FROM ${table}`);
  if (!result.length) return [];
  const [{ columns, values }] = result;
  return values.map(row => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
}

function normalizeSyncCategory(row) {
  return {
    id: String(row.id || ''),
    name: String(row.name || '未命名分类'),
    icon: String(row.icon || '📋'),
    sort_order: Number.isFinite(Number(row.sort_order)) ? Number(row.sort_order) : 0,
  };
}

function normalizeSyncTodo(row) {
  const createdAt = String(row.created_at || new Date(0).toISOString());
  const progress = Math.max(0, Math.min(100, Number(row.progress) || 0));
  const priority = [0, 1, 2].includes(Number(row.priority)) ? Number(row.priority) : 0;
  const reminderMode = ['once', 'weekly', 'count'].includes(row.reminder_mode) ? row.reminder_mode : 'once';
  return {
    id: String(row.id || ''),
    title: String(row.title || ''),
    completed: row.completed ? 1 : 0,
    category_id: String(row.category_id || 'cat_default'),
    progress,
    priority,
    created_at: createdAt,
    updated_at: String(row.updated_at || createdAt),
    reminder_enabled: row.reminder_enabled ? 1 : 0,
    reminder_time: String(row.reminder_time || ''),
    reminder_mode: reminderMode,
    reminder_weekdays: typeof row.reminder_weekdays === 'string' ? row.reminder_weekdays : '[]',
    reminder_repeat_count: Math.max(1, Number(row.reminder_repeat_count) || 1),
    reminder_sent_count: Math.max(0, Number(row.reminder_sent_count) || 0),
    reminder_last_sent_at: String(row.reminder_last_sent_at || ''),
    creator_email: String(row.creator_email || ''),
    note_file: String(row.note_file || ''),
  };
}

function syncTodoValues(todo) {
  return TODO_DB_COLUMNS.map(column => todo[column]);
}

function syncTodoSignature(todo) {
  return JSON.stringify(syncTodoValues(todo));
}

function syncTimestamp(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

async function mergeSyncDatabase(localContent, remoteContent) {
  const SQL = await initSqlJs({ locateFile: file => path.join(__dirname, file) });
  const localDb = new SQL.Database(localContent);
  const remoteDb = new SQL.Database(remoteContent);
  try {
    const localCategories = rowsFromDatabase(localDb, 'categories').map(normalizeSyncCategory).filter(row => row.id);
    const remoteCategories = rowsFromDatabase(remoteDb, 'categories').map(normalizeSyncCategory).filter(row => row.id);
    const localCategoryMap = new Map(localCategories.map(row => [row.id, row]));
    let cloudOnlyCategories = 0;
    let conflictingCategories = 0;
    for (const remoteCategory of remoteCategories) {
      const localCategory = localCategoryMap.get(remoteCategory.id);
      if (!localCategory) {
        localDb.run(
          'INSERT OR IGNORE INTO categories (id, name, icon, sort_order) VALUES (?, ?, ?, ?)',
          [remoteCategory.id, remoteCategory.name, remoteCategory.icon, remoteCategory.sort_order],
        );
        cloudOnlyCategories += 1;
      } else if (JSON.stringify(localCategory) !== JSON.stringify(remoteCategory)) {
        // 分类没有更新时间字段；本地优先，避免静默覆盖用户正在使用的名称或图标。
        conflictingCategories += 1;
      }
    }

    const localTodos = rowsFromDatabase(localDb, 'todos').map(normalizeSyncTodo).filter(row => row.id);
    const remoteTodos = rowsFromDatabase(remoteDb, 'todos').map(normalizeSyncTodo).filter(row => row.id);
    const localTodoMap = new Map(localTodos.map(row => [row.id, row]));
    let cloudOnlyTodos = 0;
    let localOnlyTodos = 0;
    let remoteWins = 0;
    let localWins = 0;
    let conflictingTodos = 0;
    const remoteIds = new Set(remoteTodos.map(row => row.id));

    for (const localTodo of localTodos) {
      if (!remoteIds.has(localTodo.id)) localOnlyTodos += 1;
    }
    for (const remoteTodo of remoteTodos) {
      const localTodo = localTodoMap.get(remoteTodo.id);
      if (!localTodo) {
        localDb.run(
          `INSERT OR IGNORE INTO todos (${TODO_DB_COLUMNS.join(', ')}) VALUES (${TODO_DB_COLUMNS.map(() => '?').join(', ')})`,
          syncTodoValues(remoteTodo),
        );
        cloudOnlyTodos += 1;
        continue;
      }
      if (syncTodoSignature(localTodo) === syncTodoSignature(remoteTodo)) continue;

      const localTime = syncTimestamp(localTodo.updated_at);
      const remoteTime = syncTimestamp(remoteTodo.updated_at);
      if (remoteTime !== null && (localTime === null || remoteTime > localTime)) {
        const updateColumns = TODO_DB_COLUMNS.slice(1);
        localDb.run(
          `UPDATE todos SET ${updateColumns.map(column => `${column}=?`).join(', ')} WHERE id=?`,
          [...updateColumns.map(column => remoteTodo[column]), remoteTodo.id],
        );
        remoteWins += 1;
      } else if (localTime !== null && (remoteTime === null || localTime > remoteTime)) {
        localWins += 1;
      } else {
        // 时间相同或都无法解析时不猜测，保留本地并让界面明确显示冲突数。
        conflictingTodos += 1;
        localWins += 1;
      }
    }

    return {
      content: Buffer.from(localDb.export()),
      summary: {
        localOnlyTodos,
        cloudOnlyTodos,
        remoteWins,
        localWins,
        conflictingTodos,
        cloudOnlyCategories,
        conflictingCategories,
      },
    };
  } finally {
    localDb.close();
    remoteDb.close();
  }
}

function noteFilesIn(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter(name => name.endsWith('.md'));
}

function copySyncNote(source, target) {
  fs.copyFileSync(source, target);
  try { fs.chmodSync(target, 0o600); } catch (_) {}
}

function mergeSyncNotes(remoteDir, remoteDescriptors, mergedDir) {
  fs.mkdirSync(mergedDir, { recursive: true, mode: 0o700 });
  const localNames = new Set(noteFilesIn(NOTES_DIR));
  const remoteNames = new Set(noteFilesIn(remoteDir));
  const remoteMeta = new Map((remoteDescriptors || []).map(note => [note.name, note]));
  let localOnlyNotes = 0;
  let cloudOnlyNotes = 0;
  let conflictingNotes = 0;

  for (const name of localNames) {
    const source = path.join(NOTES_DIR, name);
    const target = path.join(mergedDir, name);
    if (!remoteNames.has(name)) localOnlyNotes += 1;
    copySyncNote(source, target);
  }
  for (const name of remoteNames) {
    const source = path.join(remoteDir, name);
    const target = path.join(mergedDir, name);
    if (!localNames.has(name)) {
      cloudOnlyNotes += 1;
      copySyncNote(source, target);
      continue;
    }
    const localSource = path.join(NOTES_DIR, name);
    const localContent = fs.readFileSync(localSource);
    const remoteContent = fs.readFileSync(source);
    if (sha256(localContent) === sha256(remoteContent)) continue;
    conflictingNotes += 1;
    const localMtime = fs.statSync(localSource).mtimeMs;
    const remoteMtime = Number(remoteMeta.get(name)?.mtimeMs) || 0;
    if (remoteMtime > localMtime) copySyncNote(source, target);
  }
  return { localOnlyNotes, cloudOnlyNotes, conflictingNotes };
}

async function syncBackupToCurrentData() {
  if (restoreInFlight || syncInFlight) throw new Error('已有数据同步任务正在执行，请稍候');
  if (backupInFlight) throw new Error('备份正在进行，请稍候再同步');
  syncInFlight = true;
  const remoteStageDir = nextRestorePath('todo-sync-remote');
  const mergedStageDir = nextRestorePath('todo-sync-merged');
  const safetyDir = nextRestoreSafetyPath('sync');
  let servicesStopped = false;
  let databaseClosed = false;
  try {
    saveDB();
    const localContent = fs.readFileSync(DB_FILE);
    const remote = await restoreBackup(getBackupConfig(), { outputDir: remoteStageDir });
    const remoteContent = fs.readFileSync(path.join(remoteStageDir, 'todo.db'));
    const merged = await mergeSyncDatabase(localContent, remoteContent);
    const mergedNotesDir = path.join(mergedStageDir, 'notes');
    fs.mkdirSync(mergedStageDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(mergedStageDir, 'todo.db'), merged.content, { mode: 0o600 });
    const noteSummary = mergeSyncNotes(path.join(remoteStageDir, 'notes'), remote.noteDescriptors, mergedNotesDir);

    stopCron();
    stopBackupTimer();
    servicesStopped = true;
    closeDB();
    databaseClosed = true;
    copyRestoreSafetyFiles(safetyDir);
    replaceRestoredData(mergedStageDir);
    await initDB();

    const config = getFullConfig();
    if (config.email.enabled && isEmailConfigured(config.email)) startCron();
    startBackupTimer();
    servicesStopped = false;

    let cloudSyncPending = false;
    let cloudSyncError = null;
    let uploaded = null;
    try {
      uploaded = await uploadBackup(BACKUP_PATHS, getBackupConfig());
    } catch (e) {
      cloudSyncPending = true;
      cloudSyncError = e.message;
    }
    return {
      ...(uploaded || {
        success: true,
        createdAt: new Date().toISOString(),
        uploadedObjects: 0,
        reusedObjects: 0,
        noteCount: noteFilesIn(NOTES_DIR).length,
      }),
      success: true,
      active: true,
      cloudSyncPending,
      cloudSyncError,
      safetyBackupDir: safetyDir,
      sync: { ...merged.summary, ...noteSummary, snapshotPath: remote.snapshotPath },
      message: cloudSyncPending
        ? '本地合并完成，但云端上传失败；本地结果已保留，请稍后重试。'
        : '本地与云端已完成合并同步，历史快照仍然保留。',
    };
  } catch (e) {
    if (databaseClosed) {
      try {
        await rollbackRestoredData(safetyDir);
      } catch (rollbackError) {
        throw new Error(`${e.message}；自动回滚失败：${rollbackError.message}`);
      }
    }
    throw e;
  } finally {
    try { fs.rmSync(remoteStageDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(mergedStageDir, { recursive: true, force: true }); } catch (_) {}
    if (servicesStopped) {
      const config = getFullConfig();
      if (config.email.enabled && isEmailConfigured(config.email)) startCron();
      startBackupTimer();
    }
    syncInFlight = false;
  }
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
