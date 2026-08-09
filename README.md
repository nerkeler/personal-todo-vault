# ✨ TODO App

一个支持局域网访问的待办事项管理服务。每个待办都关联一份 Markdown 笔记，数据使用 SQLite 持久化，前端为原生 HTML/CSS/JavaScript。

## 快速开始

```bash
cd /Users/nerkeler/workspace/todo-app
npm install
npm start
```

打开 <http://localhost:8238/>。服务监听 `0.0.0.0:8238`，同一局域网内可通过本机 IP 访问，例如 `http://192.168.1.x:8238/`。

也可以直接执行：

```bash
node server.js
```

## 功能

- ✅ 添加、编辑、完成、删除待办
- 🗂️ 自定义分类、图标与分类排序
- 📄 每个待办关联 Markdown 笔记，支持预览与编辑
- 📈 进度记录（0–100%，到 100% 自动完成）
- 🔔 可选的邮件提醒
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
| `backups/` | 数据库备份目录，最多保留 10 个，已加入 Git 忽略 |
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
| GET | `/api/settings` | 获取提醒设置 |
| PUT | `/api/settings` | 保存提醒设置 `{ emailEnabled, checkTime }` |
| GET | `/api/icons` | 获取预设分类图标 |

待办接口统一使用 camelCase 字段，例如 `categoryId`、`createdAt`、`reminderEnabled`、`reminderTime`、`creatorEmail`、`noteFile`。

## 邮件提醒配置

服务启动前设置以下环境变量即可启用 SMTP：

```bash
export TODO_SMTP_HOST=smtp.example.com
export TODO_SMTP_PORT=465
export TODO_SMTP_USER=your-account@example.com
export TODO_SMTP_PASS=your-password
export TODO_SMTP_FROM=your-account@example.com
export TODO_SMTP_TO=recipient@example.com
```

未配置 SMTP 时，页面仍可正常使用待办与 Markdown 功能，但邮件提醒不会发送。

## 检查代码

```bash
npm run check
```
