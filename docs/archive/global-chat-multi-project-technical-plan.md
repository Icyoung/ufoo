# ufoo Global Chat 多项目切换技术方案（Plan）

Date: 2026-03-06  
Owner: codex-6  
Status: implemented
Related Decisions:
- `.ufoo/context/decisions/0083-codex-6-multi-project-chat-switch-planning.md`
- `.ufoo/context/decisions/0084-codex-6-global-chat-project-switch-ux-v1.md`
- `.ufoo/context/decisions/0085-codex-6-global-chat-multi-project-complete-plan-doc.md`

## Implementation Audit (2026-04-26)

Global chat v1 is implemented: `ufoo -g` / global mode, project runtime
registry, two-line dashboard, project rail and focus mode, transactional daemon
hot switch, per-project global history/drafts, CLI/chat project commands, and
coverage for project commands, dashboard rendering, key handling, and daemon
switch behavior are present.

## 1. 背景与目标

当前 `ufoo chat` 绑定单一 `projectRoot`，只能查看当前项目 daemon/status。  
目标是引入 **Global Chat 模式**（`ufoo -g`），在一个 chat 实例内快速查看和切换“正在运行 ufoo 的项目”，并让输入立即作用于切换后的项目。

核心目标：
- 支持 `ufoo -g` 和 `ufoo chat -g` 进入全局模式。
- 底部 Dashboard 变为两行，第一行为项目 rail（可选中），第二行为当前选中项目状态与操作提示。
- 键盘交互满足：
  - 输入框按 `↓` 进入 projects 选择态。
  - `←/→` 快速切换项目，同时刷新历史区域和第二行 dashboard。
  - `↑` 返回输入框，继续向“新项目”发送 prompt。
- 保持普通 `ufoo chat` 行为不变（默认单项目模式）。

## 2. 范围（Scope）

### 2.1 In Scope（V1）
- Global runtime project registry（全局运行项目注册表）。
- `ufoo -g` / `ufoo chat -g` 启动模式。
- Chat 两行 dashboard 与 project rail 状态机。
- 热切换 daemon 连接 + 历史显示上下文切换。
- CLI 命令：
  - `ufoo project list`
  - `ufoo project switch <index|path>`（V1 为 chat-only 语义）
  - `ufoo project current`

### 2.2 Out of Scope（V1 不做）
- 自动跨项目同步 `.ufoo/context` 内容。
- 跨项目统一消息总线（bus）聚合视图。
- 多项目并行实时流混合渲染（同屏混流）。
- GUI 弹窗式项目选择器（后续 V2）。

## 3. 用户体验与交互设计

### 3.1 启动入口

- `ufoo -g`
- `ufoo chat -g`

若 registry 为空：
- 仍进入 global chat。
- 第一行显示 `projects: none`。
- 第二行提示如何启动项目（例如“先在项目目录执行 ufoo chat 或 ufoo daemon start”）。

### 3.2 两行 Dashboard 规范

Line 1（项目 rail）：
- 结构：`projects: [proj-a] proj-b proj-c ...`
- 当前选中项目使用反显（inverse）。
- 过长时显示左右截断指示（`<` / `>`）。

Line 2（项目细节）：
- 显示当前选中项目关键信息：
  - daemon 状态
  - active agents 数
  - unread 数
  - open decisions 数
  - 快捷提示（`↑ back`, `Enter pin`, `Ctrl+X close-agent` 等）

### 3.3 键位行为（Global 模式）

Input Focus：
- `↓`：进入 projects focus。
- 其他输入保持原行为。

Projects Focus：
- `←/→`：切换选中项目，触发项目切换流程。
- `↑`：返回 input focus。
- `Enter`：确认当前项目并退出到 input focus（等价于“确认并回输入”）。
- `Esc`：返回 input focus（不改变当前项目）。

冲突规避：
- 仅在 `globalMode=true` 且 `dashboardView=projects` 时拦截该键位逻辑。
- 非 global 模式沿用现有 `agents/mode/provider/assistant/cron` 逻辑。

### 3.4 Global 模式与现有 Dashboard 视图关系

- Global 模式下，dashboard 默认主视图为 `projects`。
- 原有 `agents/mode/provider/assistant/cron` 不删除，但不放在左右导航主路径，避免键位冲突。
- 需要调整这些设置时，通过命令入口（如 `/settings`）进入，避免与项目切换争用 `←/→`。

## 4. 架构设计

### 4.1 总体架构

两层模型：
- **运行事实层**：由各项目 daemon 写入全局 registry（谁在运行、socket 在哪）。
- **交互层**：global chat 读取 registry，切换目标项目并重连目标 socket。

### 4.2 全局 Registry

为避免并发写竞态，V1 不使用单一 `registry.json` 聚合写入，改为“每项目独立 runtime 文件”。

建议路径：
- `~/.ufoo/projects/runtime/<project-id>.json`
- 可选索引：`~/.ufoo/projects/index.json`（仅缓存展示，不作为真源）

`project-id` 算法（见 4.4）固定后，文件天然按项目隔离，多个 daemon 不会写同一文件。

建议结构（单项目 runtime）：

```json
{
  "version": 1,
  "project_id": "2b8f8d2c6f4e",
  "project_root": "/Users/icy/Code/ufoo",
  "project_name": "ufoo",
  "daemon_pid": 12345,
  "socket_path": "/Users/icy/Code/ufoo/.ufoo/run/ufoo.sock",
  "status": "running",
  "last_seen": "2026-03-06T10:00:00.000Z",
  "last_switch_at": "2026-03-06T09:58:00.000Z"
}
```

写入策略：
- 使用原子写（tmp + rename）保证文件完整性。
- list 时扫描 `runtime/` 目录聚合，不依赖中心锁。

状态定义：
- `running`：pid/socket 校验通过。
- `stale`：历史记录存在，但当前不可连接。
- `stopped`：daemon 主动 stop 写入。

stale 策略：
- TTL：`last_seen` 超过 30s 且无法连通 socket => `stale`。
- 校验频率：
  - CLI `project list` 每次执行都校验一次。
  - Global chat 前台每 10s 校验一次当前选中项，后台每 30s 扫描全量。

### 4.3 Chat 连接切换策略

V1 采用“事务化热切换（connect-before-disconnect）”：
1. 标记 `switching=true`，暂停新请求发送。
2. 记录当前 input 草稿（按项目维度）。
3. 先建立目标项目连接（不关闭旧连接）。
4. 若目标连接成功：切换 active client -> 关闭旧连接 -> `requestStatus`。
5. 切换历史视图到目标项目上下文并恢复草稿，`switching=false`。
6. 若目标连接失败：保持旧连接不变，恢复旧项目上下文，`switching=false` 并提示错误。

优点：
- 不需要重启 TUI。
- 用户感知是“即时切换”。
- 避免“先断后连失败”导致会话悬空。

### 4.4 历史与输入草稿策略（含 project-id 算法）

`project-id` 计算：
- `canonical = realpath(project_root)`。
- 路径标准化：
  - macOS 默认保留大小写，不做 lower-case；
  - 去尾部 `/`。
- `project-id = sha1(canonical).slice(0, 12)`。

影响：
- 项目重命名/移动会产生新 `project-id`（视为新项目）。
- 不同路径同名项目不会冲突。

Global chat 下，历史和草稿按项目隔离：
- 历史文件：`~/.ufoo/chat/global-history/<project-id>.jsonl`
- 输入草稿：`~/.ufoo/chat/global-drafts.json`

说明：
- 不直接复用项目内 `.ufoo/chat/history.jsonl`，避免污染项目本地会话历史。
- 全局模式可提供独立的跨项目操作痕迹。

## 5. 代码改造点（文件级）

新增模块（建议）：
- `src/projects/registry.js`
  - `listProjects()`
  - `upsertProjectRuntime()`
  - `markProjectStopped()`
  - `validateProjectEntry()`
- `src/projects/projectId.js`
  - `buildProjectId(projectRoot)`
  - `canonicalProjectRoot(projectRoot)`
- `src/projects/selector.js`
  - project rail windowing 与 selection 算法（可复用 agentDirectory 思路）

改造文件：
- `bin/ufoo.js`
  - 支持 `-g` 顶层参数。
  - `runChat(process.cwd(), { globalMode: true })`。
- `src/cli.js`
  - 新增 `project list/switch/current` 命令。
- `src/daemon/index.js`
  - daemon start/heartbeat/stop 时写 registry。
- `src/chat/index.js`
  - `runChat(projectRoot, options)` 支持 `globalMode`。
  - 新增 global state：`projects`, `selectedProjectIndex`, `activeProjectRoot`。
  - 切换后刷新 logBox + dashboard 两行内容。
  - 增加 `switching` 事务态，防止切换时请求误投递。
- `src/chat/layout.js`
  - 支持 dashboard 高度参数（普通 1 行，global 2 行）。
  - 统一更新 `logBox/statusLine/inputTopLine/inputBottomLine` 高度与 bottom 公式。
- `src/chat/dashboardView.js`
  - 增加 global dashboard 计算逻辑。
- `src/chat/dashboardKeyController.js`
  - 增加 `projects` 视图与 `↑/↓/←/→` 状态转换。
- `src/chat/inputListenerController.js`
  - global 模式下 `↓` 进入 projects 选择态，`↑` 返回输入框。
- `src/chat/daemonConnection.js`
  - 增加 `switchProject({ projectRoot, sockPath })` 能力。

## 6. 命令与协议设计

CLI：
- `ufoo project list`
  - 默认表格输出：index/name/path/status/last_seen。
  - `--json` 输出机器可读格式。
- `ufoo project switch <index|path>`
  - V1 语义：仅在 global chat 中生效。
  - 非 chat 环境执行时返回明确错误码与提示：`project switch is chat-only in v1`。
- `ufoo project current`
  - 输出当前 active project。

Chat 内命令（V1 可一起做）：
- `/project list`
- `/project switch <index|path>`

`/project list` 输出格式（V1）：
- `[#] name status agents unread decisions path(last)` 单行摘要。
- 选中项前缀 `*`，stale 项显示 `{yellow-fg}stale{/yellow-fg}`。

## 7. Phase Plan（实施顺序）

### Phase A：Registry 与 CLI 基础
目标：先打通“发现项目”。

任务：
- 实现 `src/projects/registry.js`。
- daemon 接入 registry 写入。
- CLI `ufoo project list/current`。

验收：
- 同时运行两个项目 daemon，`ufoo project list` 能看到两个 running 项。

### Phase B0：Spike（必做风险闸门）
目标：先验证 `runChat` 可变 project context 改造可行性，避免大面积返工。

任务：
- 做最小原型：仅切换 daemon socket（不改完整 dashboard）。
- 评估 `src/chat/index.js` 中 `projectRoot` 闭包依赖点清单与改造策略。
- 产出 `impact list + patch strategy` 文档。

验收：
- 原型可在两项目间切换 status 且不崩溃。
- 明确列出需要改造的模块边界（至少：daemonConnection/chatLogController/dashboardKeyController）。

### Phase B：Global Chat 启动与双行 Dashboard
目标：`ufoo -g` 能看到 projects rail。

任务：
- `bin/ufoo.js` 支持 `-g`。
- layout 支持 dashboard 两行。
- dashboardView 增加 projects line1 + detail line2。

验收：
- `ufoo -g` 启动后底栏两行显示正确。

### Phase C：键盘切换 + 连接热切换
目标：实现核心交互闭环。

任务：
- `↓/↑/←/→` 全链路。
- daemonConnection 切换项目连接。
- 历史区与草稿按项目切换。

验收：
- 在项目 A 输入后切到 B，发送 prompt 确认进入 B；再切回 A 保留 A 草稿与历史上下文。
- 切换失败时自动回滚到 A，不丢连接。

### Phase D：稳定性与回归
目标：确保不破坏现有 chat。

任务：
- 异常场景：目标项目 daemon 下线、socket 不存在、registry stale。
- 回归单项目模式。

验收：
- 非 `-g` 模式行为与当前版本一致。

## 8. 测试计划

单元测试：
- `test/unit/projects/registry.test.js`
- `test/unit/chat/globalDashboard.test.js`
- `test/unit/chat/projectSwitch.test.js`
- `test/unit/chat/projectListRender.test.js`

集成测试：
- 两个临时项目目录启动 daemon，模拟 registry + switch 流程。
- 验证状态刷新、输入路由、历史隔离。
- 快速连续切换（>=20 次）无崩溃、无误投递。

手动测试清单：
- `ufoo -g` 启动。
- `↓` 进入 projects，`←/→` 切换。
- `↑` 回输入框并发送 prompt 到正确项目。
- 目标项目下线时错误提示与回退行为。
- registry 文件损坏时 graceful fallback（提示 + 自动跳过坏条目）。
- 项目数 > 20 时 rail 截断与滚动表现正确。

## 9. 风险与缓解

风险：registry 污染（stale 增长）  
缓解：list 时懒校验 + 定期清理（TTL）。

风险：切换时消息误投递到旧项目  
缓解：切换过程设原子状态 `switching=true`，暂停发送，连接确认后恢复。

风险：键位与现有 dashboard 模式冲突  
缓解：global 模式单独 `dashboardView=projects` 分支，不侵入旧分支。

## 10. 验收标准（Definition of Done）

- 支持 `ufoo -g` 进入 global chat。
- 两行 dashboard 正常展示并可交互。
- `↓/←/→/↑` 行为符合需求。
- prompt 路由到当前选中项目。
- 两项目间连续切换 50 次无崩溃、无卡死、无误投递。
- 单次切换中位耗时 < 500ms，P95 < 1200ms（本地环境）。
- 切换失败可回滚，失败后旧项目可继续发送 prompt。
- 普通 `ufoo chat` 无行为回归。

## 11. 后续扩展（V2）

- 项目搜索过滤（输入即过滤，提级为 V1.x 优先项）。
- 最近项目排序 + pin 项目。
- 可视化项目切换弹窗（非底栏模式）。
- 跨项目统一通知摘要（仅摘要，不混流）。
