# Chat Commands - 修复完成

## ✅ 已修复的问题

### 1. `/status` - 卡顿问题
- **问题**: 命令卡在 "Fetching status" 不返回
- **原因**: 只请求状态但不等待响应
- **修复**: 直接显示当前活跃的 agents 状态

### 2. `/init` - UI 破坏问题
- **问题**: 执行后破坏整个 chat UI
- **原因**:
  - `initBus()` 使用 Promise 但未正确等待
  - console 输出未被捕获，直接输出到终端
- **修复**:
  - 将 `initBus()` 改为 async/await
  - 改进 console 捕获，立即输出到 log 区域
  - 添加 `screen.render()` 确保 UI 更新

### 3. `/ctx` - 函数错误
- **问题**: "ctx.doctor is not a function"
- **原因**: 属性名 `this.doctor` 和方法名 `doctor()` 冲突
- **修复**: 重命名属性为 `this.doctorInstance`

### 4. 其他修复
- `/doctor` - 修复方法调用和输出捕获
- `/skills` - 修复输出格式
- `/bus rename` - 修复方法名
- `/daemon start/stop` - 改用 async/await

## 📋 可用命令清单

### 系统状态
```bash
/status              # 显示活跃 agents 和 daemon 状态
/doctor              # 运行健康检查
```

### Daemon 管理
```bash
/daemon status       # 查看 daemon 状态
/daemon start        # 启动 daemon
/daemon stop         # 停止 daemon
/daemon restart      # 重启 daemon
```

### Bus 操作
```bash
/bus list            # 列出所有在线 agents
/bus status          # 显示 bus 状态
/bus send <agent> <message>       # 发送消息
/bus rename <agent> <nickname>    # 重命名 agent
/bus activate <agent>             # 激活 agent 终端
```

### 初始化
```bash
/init                # 初始化所有模块 (context,bus)
/init context        # 只初始化 context
/init bus            # 只初始化 bus
```

### Context 管理（决策日志）
```bash
/ctx                 # 显示 context 状态
/ctx doctor          # 检查 context 完整性
/ctx decisions       # 列出所有决策
```

### Skills 管理
```bash
/skills list         # 列出可用 skills
/skills install all  # 安装所有 skills
/skills install <name>  # 安装指定 skill
```

### 启动 Agents
```bash
/launch claude       # 启动 Claude agent
/launch codex        # 启动 Codex agent
/launch claude nickname=worker    # 带昵称启动
/launch claude count=2            # 启动多个实例
```

## 🎯 核心改进

1. **立即反馈**: 所有 console 输出立即显示在 log 区域
2. **错误处理**: 所有命令都有完善的错误捕获
3. **UI 稳定**: 命令执行不会破坏 UI，始终调用 screen.render()
4. **异步处理**: 正确使用 async/await，不阻塞 UI

## 🧪 测试建议

1. 启动 chat: `ufoo chat`
2. 测试基础命令:
   - `/status` - 应该立即显示
   - `/bus list` - 列出当前 agents
   - `/doctor` - 显示健康检查结果
3. 测试 init:
   - `/init` - UI 应该保持正常，输出显示在 log 区域
4. 测试 launch:
   - `/launch claude nickname=test` - 启动新 agent

## 💡 使用建议

- **常用命令**: `/status`, `/bus list`, `/launch`
- **可选命令**: `/ctx` (如果不需要决策管理，可以忽略)
- **调试命令**: `/doctor`, `/daemon status`

现在所有命令都应该正常工作！
