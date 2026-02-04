# macOS 通知优化指南

## 功能特性

### 1. 友好的通知显示

通知现在会显示：
- **应用名称**: Ufoo
- **标题**: Ufoo · Agent 昵称（或 ID）
- **副标题**: From: 发送者
- **消息**: 📬 消息预览（前 50 字符）
- **分组**: 所有通知归类到 "ufoo" 组

### 2. 点击激活支持

点击通知时，会自动激活对应的终端：

#### Terminal.app 模式
- 自动定位到对应的 tab
- 窗口提升到最前
- tab 设为选中状态

#### Tmux 模式
- 自动切换到对应的 pane
- 如果在不同的 window，会先切换 window

#### Internal 模式
- 后台运行，无终端
- 通知不包含点击激活功能

## 安装 terminal-notifier（可选）

为了获得最佳的通知体验，推荐安装 `terminal-notifier`：

```bash
# 使用 Homebrew 安装
brew install terminal-notifier
```

### terminal-notifier 的优势

- 支持自定义点击动作
- 更好的通知样式
- 可以添加按钮
- 支持通知声音自定义

如果没有安装 `terminal-notifier`，系统会 fallback 到标准的 osascript 通知。

## 配置选项

### 禁用自动触发

如果只想要通知，不想自动触发终端输入：

```bash
export UFOO_AUTO_TRIGGER=0
uclaude  # 或 ucodex
```

### 测试通知

```bash
# 在 ufoo chat 中
/bus send <agent-name> 测试消息

# 或者使用命令行
ufoo bus send <agent-name> "测试消息"
```

## 手动激活终端

如果需要手动激活某个 agent 的终端：

```bash
# 在 ufoo chat 中
/bus activate <agent-id>

# 或者使用命令行
ufoo bus activate <agent-id>
```

## 通知工作流程

```
1. 消息到达 → pending.jsonl
              ↓
2. AgentNotifier 检测到新消息
              ↓
3. 发送 macOS 通知（带激活脚本）
              ↓
4. 自动注入 /ubus 命令（如果启用）
              ↓
5. Agent 处理消息
              ↓
6. 【用户点击通知】→ 激活对应终端
```

## 故障排查

### 通知没有显示

1. 检查 macOS 系统偏好设置 → 通知
2. 确保终端/tmux 的通知权限已启用
3. 检查 `UFOO_AUTO_TRIGGER` 环境变量

### 点击通知没有激活终端

1. 检查是否安装了 `terminal-notifier`：
   ```bash
   which terminal-notifier
   ```

2. 检查 tty 或 tmux_pane 信息是否保存：
   ```bash
   cat .ufoo/bus/bus.json | jq '.subscribers'
   ```

3. 手动测试激活：
   ```bash
   ufoo bus activate <agent-id>
   ```

### Internal 模式收不到消息

Internal 模式使用直接轮询，不依赖通知：
- 检查 agent 进程是否在运行
- 查看日志：`.ufoo/run/agent-*.log`

## 示例

### Terminal.app 模式

```bash
# 终端 1: 启动 agent
uclaude

# 终端 2: 发送消息
ufoo chat
/bus send claude 你好

# 结果：
# - 终端 1 收到通知
# - 点击通知 → 自动切换到终端 1
# - 自动输入并执行 /ubus
```

### Tmux 模式

```bash
# 启动 tmux
tmux new-session -s work

# 窗口 1: 启动 agent
uclaude

# 窗口 2: 发送消息
ufoo chat
/bus send claude 你好

# 结果：
# - 通知出现
# - 点击通知 → 自动切换到窗口 1
# - 自动输入并执行 /ubus
```

### Internal 模式

```bash
# 启动 internal agent
ufoo chat
/launch claude nickname=worker

# 发送消息
/bus send worker 你好

# 结果：
# - worker 自动处理（无需通知交互）
# - 回复自动发送回 chat
```

## 通知外观

### 使用 terminal-notifier

```
┌─────────────────────────────────────┐
│ Ufoo · worker                       │  ← 标题
│ From: ufoo-chat                     │  ← 副标题
│ 📬 请帮我处理这个任务                │  ← 消息
└─────────────────────────────────────┘
  [点击激活终端]
```

### 使用 osascript (fallback)

```
┌─────────────────────────────────────┐
│ Ufoo · worker                       │  ← 标题
│ From: ufoo-chat                     │  ← 副标题
│ 📬 请帮我处理这个任务                │  ← 消息
└─────────────────────────────────────┘
  [点击激活发送通知的应用]
```

## 通知分组

所有 Ufoo 通知会自动分组在一起，在通知中心可以：
- 查看所有未读消息
- 一键清除所有通知
- 统一管理通知设置
