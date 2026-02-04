#!/bin/bash

# 在项目目录中创建 Ufoo.app bundle
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UFOO_APP="$PROJECT_ROOT/.ufoo/Ufoo.app"
CONTENTS="$UFOO_APP/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"

echo "Creating Ufoo.app bundle in project directory..."

# 创建目录结构
mkdir -p "$MACOS"
mkdir -p "$RESOURCES"

# 创建 Info.plist
cat > "$CONTENTS/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>Ufoo</string>
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
    <key>NSHumanReadableCopyright</key>
    <string>Ufoo Multi-Agent Workspace</string>
</dict>
</plist>
PLIST

# 创建一个简单的可执行文件
cat > "$MACOS/Ufoo" << 'EXEC'
#!/bin/bash
# Ufoo notification helper
# This is a minimal executable for notification purposes
exit 0
EXEC

chmod +x "$MACOS/Ufoo"

echo "✓ Ufoo.app created at $UFOO_APP"
echo "✓ Bundle ID: com.ufoo.notifier"
echo ""
echo "Testing bundle..."
defaults read "$CONTENTS/Info.plist" CFBundleIdentifier

echo ""
echo "Now updating notifier to use this bundle..."
