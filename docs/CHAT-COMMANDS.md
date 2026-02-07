# Ufoo Chat 命令参考

## 🎯 工作原理

Ufoo Chat 中的命令通过 **ufoo-agent** 处理。当你输入命令时：

1. 命令发送给 ufoo daemon
2. Daemon 调用 ufoo-agent（内部 AI agent）
3. Agent 解析命令并执行相应操作
4. 结果返回到 chat 界面

**COMMAND_REGISTRY** 只用于命令自动补全，实际执行由 ufoo-agent 负责。

## 📋 可用命令

### `/doctor` - 健康检查诊断
**用途**: 检查项目配置和依赖是否正常

**实现状态**: ✅ 已实现（通过 ufoo-agent）

**示例**:
```
/doctor
```

**说明**:
- 检查 .ufoo 目录结构
- 验证 bus 配置
- 检查 context 完整性
- 报告潜在问题

---

### `/status` - 状态显示
**用途**: 显示项目当前状态

**实现状态**: ✅ 已实现（通过 ufoo-agent）

**示例**:
```
/status
```

**说明**:
- 显示活跃的 agents
- 未读消息数量
- 未处理决策数量
- Bus 和 daemon 状态

---

### `/daemon` - Daemon 管理
**用途**: 管理 ufoo daemon 进程

**实现状态**: ✅ 已实现

**子命令**:
- `start` - 启动 daemon
- `stop` - 停止 daemon
- `restart` - 重启 daemon
- `status` - 查看 daemon 状态

**示例**:
```
/daemon start
/daemon stop
/daemon restart
/daemon status
```

**说明**: Daemon 负责协调 agents 和处理消息路由

---

### `/init` - 初始化模块
**用途**: 在项目中初始化 ufoo 模块

**实现状态**: ✅ 已实现（通过 ufoo-agent）

**示例**:
```
/init
/init context
/init bus
/init context,bus
```

**说明**:
- 创建 .ufoo 目录结构
- 初始化 context/bus/resources 模块
- 设置项目配置文件
- 更新 AGENTS.md

---

### `/bus` - Event Bus 操作
**用途**: 管理事件总线和消息

**实现状态**: ✅ 已实现

**子命令**:
- `send <target> <message>` - 发送消息给指定 agent
- `rename <agent> <nickname>` - 重命名 agent 昵称
- `list` - 列出所有在线 agents
- `status` - 显示 bus 状态
- `activate <agent>` - 激活 agent 的终端窗口

**示例**:
```
/bus send claude 请帮我分析这段代码
/bus rename claude-code:abc123 worker
/bus list
/bus status
/bus activate worker
```

**说明**:
- Bus 是 agents 之间的消息通道
- 支持直接消息和广播
- 可以通过昵称或完整 ID 寻址

---

### `/ctx` - Context 管理
**用途**: 管理项目上下文和决策

**实现状态**: ✅ 已实现（通过 ufoo-agent）

**示例**:
```
/ctx
/ctx doctor
/ctx decisions
```

**说明**:
- 管理项目决策（DECISIONS/）
- 检查 context 完整性
- 查看未处理决策

---

### `/skills` - Skills 管理
**用途**: 管理 Claude/Codex skills

**实现状态**: ✅ 已实现

**示例**:
```
/skills list
/skills install all
/skills install ubus
```

**说明**:
- 列出可用 skills
- 安装 skills 到 ~/.claude/skills 或 ~/.codex/skills
- Skills 是 Claude/Codex 的扩展功能

---

### `/launch` - 启动新 Agent
**用途**: 启动新的 agent 实例

**实现状态**: ✅ 已实现（通过 ufoo-agent）

**子命令**:
- `claude` - 启动 Claude agent
- `codex` - 启动 Codex agent

**选项**:
- `nickname=<name>` - 设置昵称
- `count=<n>` - 启动多个实例

**示例**:
```
/launch claude
/launch claude nickname=worker
/launch codex count=2
/launch claude nickname=analyzer
```

**说明**:
- 根据配置的 launch_mode 启动（terminal/tmux/internal）
- 支持设置昵称方便识别
- 可批量启动多个实例

---

### `/resume` - 恢复 Agent 会话
**用途**: 恢复已保存 session 的 agent（可选昵称）

**实现状态**: ✅ 已实现

**示例**:
```
/resume
/resume worker
```

**说明**:
- 不带参数默认恢复全部可恢复的 agents
- 带昵称时只恢复指定 agent
- 你也可以在 Dashboard 里选择：**Resume previous session** 或 **Start new session**

---

## 🚫 已移除的命令

以下命令**不属于 chat**，它们是 **Skills**（仅在 Claude/Codex 中使用）：

- ~~`/ubus`~~ → 使用 `/bus` 替代（在 chat 中）或 `/ubus` skill（在 Claude/Codex 中）
- ~~`/uctx`~~ → 使用 `/ctx` 替代
- ~~`/uinit`~~ → 使用 `/init` 替代
- ~~`/ustatus`~~ → 使用 `/status` 替代

## 📚 Skills vs Chat 命令

### Chat 命令（在 ufoo chat 中）
- 前缀: `/`
- 示例: `/bus send`, `/launch claude`
- 通过 ufoo-agent 处理
- 用于管理整个系统

### Skills（在 Claude/Codex 中）
- Claude: `/ubus`, `/uctx` 等
- Codex: `ubus`, `uctx` 等
- 直接在 agent 会话中调用
- 用于 agent 自身操作

## 🎯 常用工作流

### 1. 启动新项目
```
/init context,bus
/launch claude nickname=main
```

### 2. 检查系统状态
```
/status
/bus list
```

### 3. Agent 之间协作
```
/launch claude nickname=frontend
/launch claude nickname=backend
/bus send frontend 请实现登录页面
/bus send backend 请实现用户认证 API
```

### 4. 诊断问题
```
/doctor
/daemon status
/bus status
```

### 5. 激活 Agent 终端
```
/bus activate frontend
```

## 📝 注意事项

1. **命令补全**: 输入 `/` 后按 Tab 可以看到所有可用命令

2. **子命令补全**: 输入 `/bus ` 后按 Tab 可以看到子命令

3. **命令执行**: 所有命令都通过 ufoo-agent 处理，agent 会：
   - 解析命令参数
   - 执行相应操作
   - 返回结果或错误信息

4. **Dashboard**: 按 `↓` 键可以进入 dashboard 模式，快速选择 agent

5. **直接消息**: 在 dashboard 选择 agent 后，所有输入会直接发送给该 agent

## 🔧 故障排查

### 命令无响应
1. 检查 daemon 状态: `/daemon status`
2. 检查 agent 是否在线: `/bus list`
3. 重启 daemon: `/daemon restart`

### Agent 无法通信
1. 检查 bus 状态: `/bus status`
2. 验证 agent ID: `/bus list`
3. 尝试激活终端: `/bus activate <agent>`

### 命令执行错误
1. 运行诊断: `/doctor`
2. 检查日志: `.ufoo/run/ufoo-daemon.log`
3. 重新初始化: `/init`
