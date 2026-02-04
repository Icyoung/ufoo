#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$PROJECT_ROOT/.ufoo/build"
APP_DIR="$PROJECT_ROOT/.ufoo/UfooNotifier.app"

echo "Building Ufoo Notifier..."

# 创建构建目录
mkdir -p "$BUILD_DIR"

# 创建 Swift 源文件
cat > "$BUILD_DIR/main.swift" << 'SWIFT'
import Cocoa
import UserNotifications

class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // 设置通知中心代理
        UNUserNotificationCenter.current().delegate = self
        
        // 请求通知权限
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            if granted {
                self.sendNotification()
            } else {
                print("Notification permission denied")
                NSApp.terminate(nil)
            }
        }
    }
    
    func sendNotification() {
        let args = CommandLine.arguments
        var title = "Ufoo"
        var subtitle = ""
        var message = ""
        var executeScript = ""
        
        // 解析参数
        var i = 1
        while i < args.count {
            if args[i] == "-title" && i + 1 < args.count {
                title = args[i + 1]
                i += 2
            } else if args[i] == "-subtitle" && i + 1 < args.count {
                subtitle = args[i + 1]
                i += 2
            } else if args[i] == "-message" && i + 1 < args.count {
                message = args[i + 1]
                i += 2
            } else if args[i] == "-execute" && i + 1 < args.count {
                executeScript = args[i + 1]
                i += 2
            } else {
                i += 1
            }
        }
        
        let content = UNMutableNotificationContent()
        content.title = title
        if !subtitle.isEmpty {
            content.subtitle = subtitle
        }
        content.body = message
        content.sound = .default
        
        if !executeScript.isEmpty {
            content.userInfo = ["executeScript": executeScript]
        }
        
        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )
        
        UNUserNotificationCenter.current().add(request) { error in
            if let error = error {
                print("Error: \(error)")
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                NSApp.terminate(nil)
            }
        }
    }
    
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let userInfo = response.notification.request.content.userInfo
        if let script = userInfo["executeScript"] as? String {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/bin/bash")
            task.arguments = [script]
            try? task.run()
        }
        completionHandler()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
SWIFT

# 创建 Info.plist
cat > "$BUILD_DIR/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>UfooNotifier</string>
    <key>CFBundleIdentifier</key>
    <string>com.ufoo.notifier</string>
    <key>CFBundleName</key>
    <string>Ufoo</string>
    <key>CFBundleDisplayName</key>
    <string>Ufoo</string>
    <key>CFBundleVersion</key>
    <string>1.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
</dict>
</plist>
PLIST

# 编译
echo "Compiling..."
swiftc "$BUILD_DIR/main.swift" -o "$BUILD_DIR/UfooNotifier" \
    -framework Cocoa \
    -framework UserNotifications

if [ ! -f "$BUILD_DIR/UfooNotifier" ]; then
    echo "❌ Compilation failed"
    exit 1
fi

echo "✓ Compiled successfully"

# 创建应用 bundle
echo "Creating app bundle..."
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

cp "$BUILD_DIR/UfooNotifier" "$APP_DIR/Contents/MacOS/"
cp "$BUILD_DIR/Info.plist" "$APP_DIR/Contents/"

echo "✓ App bundle created at $APP_DIR"

# 测试
echo ""
echo "Testing notification..."
"$APP_DIR/Contents/MacOS/UfooNotifier" \
    -title "Ufoo · test" \
    -subtitle "From: build-script" \
    -message "📬 Ufoo Notifier 构建成功！"

echo ""
echo "✓ Check your notification center!"
echo "  The notification should show as 'Ufoo' application"
