# TODO App 使用说明

TODO App 是一个将待办事项、进度提醒与 Markdown 上下文放在一起管理的个人任务工具。每条任务既可以保持简洁，也可以关联一份可持续补充的说明文档。

## 项目特点

### 待办与 Markdown 上下文关联

- 每条待办都可以关联独立的 Markdown 文档。
- Markdown 内容在预览时解析为标题、列表、表格、代码块和引用，不展示源文本。
- 编辑与预览使用统一的文档版式，适合记录目标、步骤、资料和复盘。

### 进度驱动的完成状态

- 进度范围为 0%–100%，支持快捷设置和进度条调整。
- 进度达到 100% 后，任务自动标记为已完成。
- 已完成任务默认关闭提醒，Markdown 文档进入只读浏览状态。
- 需要继续修改时，先将任务恢复为未完成状态。

### 分类与状态清晰

- 使用分类整理不同类型的任务，并支持自定义图标和排序。
- 左侧分类显示该分类的任务总数。
- 已完成任务单独分页展示，每页 10 条，页码过多时使用省略号。

### 本地化的数据管理

- 待办和 Markdown 笔记保存在本地，适合个人使用和私有管理。
- 支持明暗主题、移动端布局、邮件提醒和配置中心。

## 使用方法

### 1. 创建待办

1. 在顶部输入框填写任务名称。
2. 选择所属分类。
3. 点击“添加”或按 Enter 键创建任务。

### 2. 编辑任务

- 点击任务右侧的编辑按钮，可以修改未完成任务的名称；直接点击任务名称不会进入编辑。
- 点击分类标签，可以将任务移动到其他分类。
- 点击删除按钮可以移除任务。
- 创建时间和更新时间会显示在任务信息中。

### 3. 设置任务进度

1. 点击任务下方的“+ 添加进度”或现有进度条。
2. 拖动滑块，或选择 0%、25%、50%、75%、100% 等快捷值。
3. 点击“保存”。设置为 100% 后，任务会自动完成。

### 4. 编写 Markdown 文档

1. 点击任务右侧的文档按钮打开 Markdown 文档。
2. 在“编辑”页输入内容，在“预览”页查看解析后的效果。
3. 点击“保存文档”，系统会显示保存状态后关闭窗口。
4. 已完成任务的文档只能浏览，不能编辑。

### 5. 配置任务提醒

1. 点击未完成任务右侧的铃铛按钮。
2. 开启提醒并设置发送时间和重复方式。
3. 根据需要选择单次、每周或按次数重复。
4. 任务完成后提醒会自动关闭。

### 6. 管理分类

- 点击左侧分类名称，查看对应分类的任务。
- 点击“新增分类”创建自定义分类。
- 将鼠标移到分类上，可以编辑分类、调整顺序或删除分类。

### 7. 使用配置中心

点击右上角的设置按钮进入配置中心，可统一管理邮件提醒和备份相关设置。坚果云首次配置时，先填写表单并点击“测试坚果云”，测试成功后再点击“保存配置”；测试使用临时表单数据，不会自动保存应用密码，保存前备份和同步按钮会保持不可用。

如果备份目录中已经有云端快照，保存后优先使用“与云端同步”；如果目录为空，同步会将当前本地数据创建为第一份快照。为防止新容器的空数据库覆盖已有云端数据，“立即备份”会在这种情况下主动阻止上传。

### 8. 访问控制（登录）

访问保护默认关闭。在配置中心「🔐 访问控制」中设置至少 6 个字符的访问密码后启用：

- 启用后打开页面会出现解锁遮罩，API 与页面数据都需要先登录。
- 勾选“30 天内记住这台设备”后本机浏览器在密码变更前的 30 天内免登录；不勾选则关闭浏览器即失效（最长 12 小时）。
- 修改密码或关闭保护会使所有已登录设备的会话立即失效。
- 退出登录只清除当前设备的登录状态，其它“记住设备”的浏览器不受影响。
- 登录接口自带限流：同一来源连续 5 次输错密码会锁定 10 分钟。
- 忘记密码：删除服务器 `config/config.auth.json`（及可选的 `config.auth.key`）后重启应用。

### 9. 服务端管理员命令（auth:manage）

管理员可以在服务器上直接管理访问保护，适用于忘记密码、批量部署和无法进入界面的场景。

**本机 / 直接运行部署**：

```bash
npm run auth:manage -- status      # 查询保护状态（--json 可输出 JSON）
npm run auth:manage -- set         # 首次启用 / 重置密码（交互输入，不回显）
npm run auth:manage -- change      # 修改密码（已启用时需先输入当前密码）
npm run auth:manage -- disable     # 关闭密码保护（需输入当前密码）
npm run auth:manage -- kick        # 不改密码，强制所有已登录设备重新登录
```

**Docker Compose 部署**（服务名以 docker-compose.yml 中的 `todo-app` 为准；配置目录挂载在 `/config`）：

```bash
docker compose exec todo-app node manageAuth.js status --json
docker compose exec todo-app node manageAuth.js set             # 交互输入不回显
docker compose exec todo-app node manageAuth.js change
docker compose exec todo-app node manageAuth.js disable
docker compose exec todo-app node manageAuth.js kick
```

非交互终端（如某些远端 SSH、CI）无法交互输入时，用环境变量完成同样操作：

```bash
# 首次启用 / 忘记密码时重置
docker compose exec -e TODO_AUTH_NEW_PASSWORD='你的新密码' todo-app node manageAuth.js set --yes
# 修改密码
docker compose exec -e TODO_AUTH_CURRENT_PASSWORD='当前密码' -e TODO_AUTH_NEW_PASSWORD='新密码' todo-app node manageAuth.js change --yes
# 关闭保护
docker compose exec -e TODO_AUTH_CURRENT_PASSWORD='当前密码' todo-app node manageAuth.js disable --yes
# 强制全部设备重新登录
docker compose exec todo-app node manageAuth.js kick
```

**单条 docker run 部署**：容器内同路径命令可用 `docker exec -it personal-todo-vault node manageAuth.js ...` 执行，配置目录正确挂载（`-v $PWD/config:/config`）后状态即持久化。

选项与环境变量：

- `--yes`：跳过覆盖式操作的确认提示（脚本化场景必需）。
- `--json`：`status` 输出 JSON，便于巡检脚本解析。
- `TODO_AUTH_NEW_PASSWORD`：脚本化提供目标密码（优先于交互输入）。
- `TODO_AUTH_CURRENT_PASSWORD`：脚本化提供当前密码（优先于交互输入）。

安全说明：管理命令不需要应用会话（管理员直接持有服务器权限），但为了保护密码安全，本工具**不接受命令行参数形式的密码**（避免出现在进程列表和 shell 历史中）；交互输入全程不回显，环境变量方式请酌情评估 CI/日志的可见性。`set` 覆盖已有密码、`kick` 与 `disable` 都会使所有已登录设备立即退出。若需要彻底重来，也可以删除宿主机 `./config/config.auth.json` 与 `config.auth.key` 后重启容器。

## 状态规则

| 状态 | 任务名称 | 进度 | 提醒 | Markdown |
| --- | --- | --- | --- | --- |
| 未完成 | 可编辑 | 可调整 | 可配置 | 可编辑、可预览 |
| 已完成 | 只读 | 固定 100% | 默认关闭 | 只读浏览 |
