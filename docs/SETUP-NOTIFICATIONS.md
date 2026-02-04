# Ufoo 通知系统设置指南

## ✨ 新的通知系统

现在 Ufoo 使用**自己的通知应用**，通知会正确显示为 "Ufoo" 而不是 "Terminal" 或 "terminal-notifier"！

## 🚀 快速设置

### 1. 构建 UfooNotifier（自动）

当你第一次运行 `uclaude` 或 `ucodex` 时，系统会自动构建 UfooNotifier.app。

或者手动构建：
```bash
bash scripts/build-ufoo-notifier.sh
```

### 2. 授予通知权限（重要！）

**方法 A: 使用辅助脚本**
```bash
bash scripts/grant-notifier-permission.sh
```

**方法 B: 手动设置**

1. 打开 `系统偏好设置` / `系统设置`
2. 进入 `通知与专注模式` / `通知`
3. 在左侧列表找到 **"Ufoo"**
4. 启用通知权限

如果列表中没有 Ufoo，先运行一次：
```bash
open .ufoo/UfooNotifier.app
```

### 3. 测试通知

```bash
.ufoo/UfooNotifier.app/Contents/MacOS/UfooNotifier \
  -title "Ufoo · test" \
  -subtitle "From: system" \
  -message "📬 测试通知"
```

## 🎯 工作原理

### 通知发送优先级

1. **UfooNotifier.app** (优先) - 显示为 "Ufoo" ✨
2. **terminal-notifier** (fallback) - 显示为 "terminal-notifier"
3. **osascript** (最后) - 显示为 "Script Editor" 或 "Terminal"

### UfooNotifier.app 结构

```
.ufoo/UfooNotifier.app/
├── Contents/
│   ├── Info.plist          # Bundle 元数据
│   │   ├── CFBundleIdentifier: com.ufoo.notifier
│   │   └── CFBundleDisplayName: Ufoo
│   └── MacOS/
│       └── UfooNotifier    # Swift 编译的可执行文件
```

## 📋 使用说明

### 自动通知

当你的 agent 收到消息时，会自动：
1. 显示 macOS 通知（应用名称为 "Ufoo"）
2. 自动注入 `/ubus` 命令到终端
3. 处理消息并回复

### 点击通知

点击通知会：
- **Terminal.app**: 自动切换到对应的 tab
- **Tmux**: 自动切换到对应的 pane
- **Internal**: 无操作（后台模式）

### 手动激活

```bash
# 在 chat 中
/bus activate <agent-name>

# 命令行
ufoo bus activate <agent-name>
```

## 🔧 故障排查

### 问题 1: 通知没有显示

**解决方案**:
1. 检查权限：系统偏好设置 > 通知 > Ufoo
2. 确保 UfooNotifier.app 存在：
   ```bash
   ls -la .ufoo/UfooNotifier.app/Contents/MacOS/UfooNotifier
   ```
3. 重新构建：
   ```bash
   rm -rf .ufoo/UfooNotifier.app
   bash scripts/build-ufoo-notifier.sh
   ```

### 问题 2: 通知显示为 "terminal-notifier"

这意味着系统在使用 fallback。检查：
```bash
ls -la .ufoo/UfooNotifier.app
```

如果不存在，运行：
```bash
bash scripts/build-ufoo-notifier.sh
```

### 问题 3: 权限被拒绝

运行：
```bash
bash scripts/grant-notifier-permission.sh
```

然后在系统设置中启用 Ufoo 的通知权限。

### 问题 4: 点击通知没有激活终端

1. 检查激活脚本：
   ```bash
   ls -la .ufoo/bus/.notify-scripts/
   ```

2. 检查 tty/tmux_pane 信息：
   ```bash
   cat .ufoo/bus/bus.json | jq '.subscribers'
   ```

3. 手动测试激活：
   ```bash
   ufoo bus activate <agent-id>
   ```

## 📚 技术细节

### Swift 实现

UfooNotifier 使用 Swift 编写，使用 macOS 原生的 `UserNotifications` 框架：

```swift
import Cocoa
import UserNotifications

// 创建通知内容
let content = UNMutableNotificationContent()
content.title = "Ufoo · agent-name"
content.subtitle = "From: sender"
content.body = "Message preview"
content.sound = .default

// 发送通知
UNUserNotificationCenter.current().add(request)
```

### Bundle ID

- **com.ufoo.notifier** - 唯一标识符
- macOS 通过此 ID 识别应用
- 通知中心显示为 "Ufoo"

### 通知分组

所有通知自动分组到 "ufoo" 组，方便管理。

## 🎉 完成

现在你的通知系统已经完全配置好了！

当 agent 收到消息时，你会看到：
```
┌─────────────────────────────────────┐
│ Ufoo                            👆  │ ← 应用名称
│ ─────────────────────────────────   │
│ Ufoo · worker                       │ ← 标题
│ From: ufoo-chat                     │ ← 副标题
│ 📬 新消息预览...                     │ ← 内容
└─────────────────────────────────────┘
```

享受你的新通知系统！🚀
