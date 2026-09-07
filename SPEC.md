# Personal Todo Vault Specification

## 1. 产品目标

Personal Todo Vault 是一个面向个人使用和私有部署的待办管理服务。核心对象是“待办”，每个待办可以关联一份独立 Markdown 笔记，用于记录上下文、计划、资料与复盘内容。

服务默认将数据保存在部署设备上，不要求第三方账户；用户可以按需启用 SMTP 提醒和坚果云 WebDAV 备份。

## 2. 功能范围

- 待办的创建、编辑、完成、删除
- 分类的创建、重命名、图标设置、删除与排序
- 按分类筛选待办
- 进度设置：整数 0–100；进度达到 100 时自动标记完成
- Markdown 笔记的预览、编辑与保存
- 明暗主题、响应式布局
- 单次、每周指定星期和按次数重复的邮件提醒
- 页面统一配置、保存和测试 SMTP 与坚果云 WebDAV
- 数据库与 Markdown 笔记的内容寻址增量备份

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
- **Backend:** Node.js 原生 `http` 服务
- **Database:** `sql.js`（SQLite WebAssembly）
- **Email:** `nodemailer`
- **Storage:** `todo.db`、`notes/<todo-id>.md`
- **Optional backup:** 坚果云 WebDAV

默认监听 `127.0.0.1:8238`；设置 `HOST=0.0.0.0` 后才监听全部网卡。由于当前版本没有内置用户认证和多用户隔离，公开网络部署必须通过 VPN 或带身份验证的反向代理保护。

### 4.1 持久化与迁移

数据库写入采用“导出到临时文件 → `fsync` → 原子 `rename`”流程，减少进程中断造成的半写文件。替换数据库前会把旧文件保存到 `backups/`，最多保留最近 10 份。

启动时，如果 `todo.db` 不存在但存在旧版 `data.json`，服务会自动迁移分类、待办、提醒与旧笔记引用，再生成 SQLite 数据库。已有数据库不会重复导入 JSON。

### 4.2 Markdown 关联

Markdown 文件按待办 ID 命名为 `<todo-id>.md`，标题变化不会影响笔记关联。读取旧版按标题命名的笔记时，服务会复制内容到 ID 文件，并更新待办记录，旧文件仅在没有其他待办引用时才会被清理。

Markdown 预览会先转义文本，再应用有限的格式化规则；链接仅允许 `http:`、`https:`、`mailto:` 协议，并设置 `rel="noopener"`。

### 4.3 配置保护

页面配置统一写入 `config.local.json`。配置包使用 AES-256-GCM 加密，密钥保存在本机 `config.local.key` 或由 `TODO_CONFIG_SECRET` 提供。API 只返回配置是否已设置，不返回密码。

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
- `PATCH /api/todos/:id`：更新标题、分类、完成状态、进度、重要程度或提醒
- `DELETE /api/todos/:id`
- `GET /api/todos/:id/note`
- `PUT /api/todos/:id/note`：`{ content }`
- `GET /api/settings`
- `PUT /api/settings`：`{ email, webdav }`
- `POST /api/settings/test-email`
- `GET /api/backup/status`
- `POST /api/backup/test`
- `POST /api/backup/run`
- `GET /api/icons`

提醒规则：`reminderMode` 可设为 `once`、`weekly` 或 `count`。星期使用 ISO 编号：1=周一，…，7=周日。`weekly`/`count` 至少选择一个星期；`count` 需要设置 1–1000 的重复次数。每条待办每天最多发送一次；已完成待办不会继续发送提醒。重新开启或修改规则会从第 1 次重新计数。`priority` 只能是 0（普通）、1（重要）或 2（紧急）。

## 7. 工程结构

```text
personal-todo-vault/
├── server.js       # HTTP 服务、API、定时提醒和自动备份
├── sqlite.js       # SQLite 初始化、迁移与原子保存
├── index.html      # 主页面与 Markdown 编辑/预览
├── appConfig.js    # 加密配置读写与脱敏输出
├── cloudBackup.js  # WebDAV 内容寻址增量备份
├── email.js        # SMTP 邮件发送
├── todo.db         # 运行时数据库，不提交
├── notes/          # 运行时 Markdown 笔记，不提交
├── backups/        # 自动生成的数据库备份，不提交
├── data.json       # 旧版迁移来源，不提交
├── README.md       # 使用与部署说明
└── SPEC.md         # 产品与技术规格
```

运行时数据和本机配置均由 `.gitignore` 排除；公开仓库只包含代码、文档和无敏感信息的示例文件。
