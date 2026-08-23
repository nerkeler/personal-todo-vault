# ✨ TODO App

一个支持局域网访问的待办事项管理服务。每个待办都关联一份 Markdown 笔记，数据使用 SQLite 持久化，前端为原生 HTML/CSS/JavaScript。

## 快速开始

```bash
cd /Users/nerkeler/workspace/todo-app
npm install
npm start
```

打开 <http://127.0.0.1:8238/>。默认只监听本机 `127.0.0.1:8238`。如需局域网访问，可启动前设置 `HOST=0.0.0.0`。

也可以直接执行：

```bash
node server.js
```

局域网访问示例：

```bash
HOST=0.0.0.0 npm start
```

## 功能

- ✅ 添加、编辑、完成、删除待办
- 🗂️ 自定义分类、图标与分类排序
- 📄 每个待办关联 Markdown 笔记，支持预览与编辑
- 📈 进度记录（0–100%，到 100% 自动完成）
- 🔔 可选的邮件提醒：支持单次、每周指定星期、按次数重复
- ☁️ 坚果云 WebDAV 云端数据备份
- 🌙 明暗主题与移动端适配
- 💾 SQLite 数据持久化，启动时兼容迁移旧版 `data.json`
- 🛡️ Markdown 预览会过滤 HTML 与不安全链接协议
- 🔒 数据库采用临时文件、`fsync` 与原子替换保存，并保留最近 10 个备份

## 文件说明

| 文件/目录 | 说明 |
|-----------|------|
| `server.js` | Node.js HTTP 服务与 API 路由 |
| `sqlite.js` | sql.js SQLite 数据访问层 |
| `todo.db` | SQLite 数据库文件 |
| `notes/` | Markdown 笔记；新文件名固定为 `<todo-id>.md` |
| `backups/` | 本机数据库滚动备份目录，最多保留 10 个，已加入 Git 忽略 |
| `config.local.json` | 页面保存的本机配置（邮件/坚果云密码等），已加入 Git 忽略 |
| `appConfig.js` | 页面配置读写、默认值合并与脱敏输出 |
| `cloudBackup.js` | 坚果云 / WebDAV 备份模块 |
| `data.json` | 旧版本 JSON 数据；仅在没有 `todo.db` 时自动迁移 |
| `index.html` | 前端页面 |
| `SPEC.md` | 产品与技术规格 |

## API

所有 JSON 请求使用 `Content-Type: application/json`。普通 JSON 请求体上限为 2 MiB，Markdown 请求体上限为 4 MiB。

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/categories` | 获取按 `sort_order` 排序的分类 |
| POST | `/api/categories` | 创建分类 `{ name, icon }` |
| PATCH | `/api/categories/:id` | 更新分类名称或图标 |
| DELETE | `/api/categories/:id` | 删除分类及其待办 |
| PATCH | `/api/categories/reorder` | 调整分类顺序 `{ order: [id, ...] }` |
| GET | `/api/todos` | 获取所有待办；可用 `?categoryId=` 过滤 |
| POST | `/api/todos` | 创建待办 `{ title, categoryId }` |
| PATCH | `/api/todos/:id` | 更新标题、完成状态、分类、进度或提醒 |
| DELETE | `/api/todos/:id` | 删除待办及其 Markdown 笔记 |
| GET | `/api/todos/:id/note` | 读取该待办的 Markdown 笔记 |
| PUT | `/api/todos/:id/note` | 保存 Markdown 笔记 `{ content }` |
| GET | `/api/settings` | 获取统一配置（邮件与坚果云，密码只返回是否已配置） |
| PUT | `/api/settings` | 保存统一配置 `{ email, webdav }`，密码留空表示不修改 |
| POST | `/api/settings/test-email` | 使用当前表单配置发送测试邮件 |
| GET | `/api/backup/status` | 获取坚果云备份配置状态（不返回密码） |
| POST | `/api/backup/test` | 使用当前表单配置测试坚果云 WebDAV |
| POST | `/api/backup/run` | 立即生成并上传云端备份 |
| GET | `/api/icons` | 获取预设分类图标 |

待办接口统一使用 camelCase 字段，例如 `categoryId`、`createdAt`、`reminderEnabled`、`reminderTime`、`reminderMode`、`reminderWeekdays`、`reminderRepeatCount`、`creatorEmail`、`noteFile`。

提醒规则：`reminderMode` 可设为 `once`（单次发送一次）、`weekly`（按 `reminderWeekdays` 中的星期持续发送）或 `count`（按选中的星期发送，累计达到 `reminderRepeatCount` 次后自动关闭）。星期使用 ISO 编号：1=周一，…，7=周日。每条待办每天最多发送一次；已完成待办不会继续发送提醒。重新开启或修改规则会从第 1 次重新计数。

## 页面配置

右上角齿轮「配置中心」是唯一配置入口，邮件提醒和坚果云备份都在这里填写、保存和测试。

- 邮件配置：SMTP 服务器、端口、SSL/TLS、账号、授权码、发件人、收件人，并支持发送测试邮件。
- 坚果云配置：WebDAV 地址、账号、应用密码、备份目录、自动备份间隔，并支持连接测试和立即备份。
- 密码字段默认不回显明文；已配置时页面只显示「已配置，留空不修改」。
- 保存后的本机配置会以 AES-GCM 加密包写入 `config.local.json`，密钥在 `config.local.key`（或 `TODO_CONFIG_SECRET`）中，两个本地文件均已加入 `.gitignore`，不要提交到 Git。

环境变量仍可作为首次启动默认值或服务器自动部署兜底值，但建议最终通过页面保存：

```bash
# 邮件默认值（可选）
export TODO_SMTP_HOST=smtp.example.com
export TODO_SMTP_PORT=465
export TODO_SMTP_SECURE=true
export TODO_SMTP_USER=your-account@example.com
export TODO_SMTP_PASS=your-password
export TODO_SMTP_FROM=your-account@example.com
export TODO_MAIL_RECIPIENTS=recipient@example.com

# 坚果云默认值（可选）
export TODO_WEBDAV_URL=https://dav.jianguoyun.com/dav/
export TODO_WEBDAV_USERNAME=your-jianguoyun-account@example.com
export TODO_WEBDAV_PASSWORD=your-app-password
export TODO_WEBDAV_BACKUP_DIR=todo-app-backups
export TODO_BACKUP_AUTO=true
export TODO_BACKUP_INTERVAL_HOURS=24
```

坚果云应用密码请在坚果云「安全选项 / 第三方应用管理」生成。默认远程备份目录是 `todo-app-backups`，也可以在配置中心修改。当前采用“增量上传 + 完整快照清单”，不是每次覆盖一个大压缩包：

```text
todo-app-backups/
├── objects/
│   ├── database/<sha256>.db.gz
│   └── notes/<sha256>.md.gz
├── snapshots/<时间>-<随机值>.json
└── latest.json
```

- `todo.db` 和每个 Markdown 笔记分别计算 SHA-256；只有新增或内容变化的对象才上传，未变化内容直接复用。
- 每次备份都会生成一份新的完整快照清单，记录当前数据库对象和全部笔记对象；`latest.json` 指向最新清单。
- 删除的笔记会从最新清单中消失，不会在恢复当前版本时被误恢复；历史快照和对象默认保留，便于恢复历史状态。
- 这是一种单向的应用数据备份，不是坚果云与应用之间的双向编辑同步。不要直接在坚果云中修改对象文件；如需恢复，应根据快照清单执行恢复操作。
- 清单是 JSON，数据库和笔记对象使用 gzip 压缩；密钥和 WebDAV 密码仍只保存在本机加密配置中，不会上传到备份目录。

## 检查代码

```bash
npm run check
```
