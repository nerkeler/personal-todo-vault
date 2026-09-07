# TODO App Specification

## 1. 产品目标

TODO App 是一个可在本机或局域网访问的待办管理服务。核心对象是“待办”，每个待办可以关联一份独立的 Markdown 笔记，用于记录上下文、计划与复盘内容。

## 2. 功能范围

- 待办的创建、编辑、完成、删除
- 分类的创建、重命名、图标设置、删除与排序
- 按分类筛选待办
- 进度设置：整数 0–100；进度达到 100 时自动标记完成
- Markdown 笔记的预览、编辑与保存
- 明暗主题、响应式布局
- 可选的每日邮件提醒

## 3. 交互与视觉

**Aesthetic:** 日式禅意 + 现代卡片式设计，柔和渐变，优雅留白。

**Color Palette:**

- Primary gradient: `#667eea` → `#764ba2`
- Background: `#f8fafc`
- Card: `#ffffff`
- Text primary: `#1a202c`
- Text secondary: `#718096`
- Accent success: `#38ef7d`
- Accent danger: `#ff6b6b`
- Border: `#e2e8f0`

**Responsive:** 桌面端居中布局；移动端使用全宽内容和 16px 左右内边距。

## 4. 技术架构

- **Frontend:** 原生 HTML + CSS + JavaScript，无前端框架
- **Backend:** Node.js 原生 `http` 服务，监听 `0.0.0.0:8238`
- **Database:** `sql.js`（SQLite WASM）
- **Email:** `nodemailer`
- **Storage:** `todo.db`、`notes/<todo-id>.md`

### 4.1 持久化与迁移

数据库写入采用“导出到临时文件 → `fsync` → 原子 `rename`”流程，减少进程中断造成的半写文件。替换数据库前会把旧文件保存到 `backups/`，最多保留最近 10 份。

启动时，如果 `todo.db` 不存在但存在旧版 `data.json`，服务会自动迁移分类、待办、提醒与旧笔记引用，再生成 SQLite 数据库。已有数据库不会重复导入 JSON。

### 4.2 Markdown 关联

Markdown 文件按待办 ID 命名为 `<todo-id>.md`，标题变化不会影响笔记关联。读取旧版按标题命名的笔记时，服务会复制内容到 ID 文件，并更新待办记录，旧文件仅在没有其他待办引用时才会被清理。

Markdown 预览会先转义文本，再应用有限的格式化规则；链接仅允许 `http:`、`https:`、`mailto:` 协议，并设置 `rel="noopener"`。

## 5. 数据模型

### Category

```json
{
  "id": "cat_default",
  "name": "默认",
  "icon": "📋",
  "sort_order": 0
}
```

### Todo

```json
{
  "id": "uuid",
  "title": "任务标题",
  "categoryId": "cat_default",
  "completed": false,
  "progress": 0,
  "priority": 0,
  "createdAt": "2026-08-09T00:00:00.000Z",
  "reminderEnabled": false,
  "reminderTime": "09:00",
  "reminderMode": "once",
  "reminderWeekdays": [],
  "reminderRepeatCount": 1,
  "reminderSentCount": 0,
  "reminderLastSentAt": "",
  "creatorEmail": "",
  "noteFile": "uuid.md"
}
```

后端数据库内部使用 snake_case 列名，但 API 对待办字段统一使用 camelCase。

## 6. API

- `GET /api/categories`
- `POST /api/categories`：`{ name, icon }`
- `PATCH /api/categories/:id`：`{ name?, icon? }`
- `DELETE /api/categories/:id`
- `PATCH /api/categories/reorder`：`{ order: [categoryId, ...] }`
- `GET /api/todos?categoryId=...`
- `POST /api/todos`：`{ title, categoryId, priority? }`
- `PATCH /api/todos/:id`：`{ title?, completed?, categoryId?, progress?, priority?, reminderEnabled?, reminderTime?, reminderMode?, reminderWeekdays?, reminderRepeatCount?, creatorEmail? }`
- `DELETE /api/todos/:id`
- `GET /api/todos/:id/note`
- `PUT /api/todos/:id/note`：`{ content }`
- `GET /api/settings`
- `PUT /api/settings`：`{ emailEnabled, checkTime }`

备份快照清单写入 `snapshots/YYYY-MM/<snapshot-id>.json`，`latest.json` 始终位于备份根目录；恢复同时兼容迁移前的 `snapshots/<snapshot-id>.json` 路径。

输入约束包括：标题 1–200 字符、分类名 1–80 字符、进度为 0–100 整数、重要程度为 0（普通）、1（重要）或 2（紧急）、时间为 `HH:MM`、提醒邮箱最多 320 字符。`reminderMode` 只能是 `once`、`weekly` 或 `count`；`weekly`/`count` 至少选择一个星期；`reminderRepeatCount` 为 1–1000 的整数。已启用提醒必须设置有效时间。不存在的待办或分类返回 HTTP 404。

提醒任务由服务端每分钟检查，使用服务本机时区；每个待办每天最多发送一次。单次提醒发送成功后自动关闭；按次数提醒达到总次数后自动关闭；每周提醒持续有效，直到手动关闭。已完成待办不会发送提醒。

## 7. 工程结构

```text
todo-app/
├── server.js       # HTTP 服务、API、定时提醒
├── sqlite.js       # SQLite 初始化、迁移与原子保存
├── index.html      # 主页面与 Markdown 预览
├── todo.db         # SQLite 数据库
├── notes/          # 按待办 ID 命名的 Markdown 文件
├── backups/        # 自动生成的数据库备份（不提交）
├── data.json       # 旧版数据迁移来源
├── README.md       # 使用说明
└── SPEC.md         # 本规格文档
```
