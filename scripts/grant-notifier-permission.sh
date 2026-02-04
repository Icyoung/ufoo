#!/bin/bash

echo "=== Ufoo Notifier 权限设置 ==="
echo ""
echo "UfooNotifier 需要通知权限才能工作。"
echo ""
echo "请按照以下步骤操作："
echo ""
echo "1. 打开 '系统偏好设置' > '通知与专注模式'"
echo "2. 在左侧应用列表中找到 'Ufoo'"
echo "3. 如果没有，运行以下命令后再试："
echo ""
echo "   open /Users/icy/Code/ai-workspace/.ufoo/UfooNotifier.app"
echo ""
echo "4. 启用通知权限"
echo ""
echo "或者，运行这个命令自动打开应用（会触发权限请求）："
echo ""

read -p "按 Enter 键打开 UfooNotifier 应用（会请求权限）..." 

open "/Users/icy/Code/ai-workspace/.ufoo/UfooNotifier.app"

echo ""
echo "✓ 应用已启动"
echo ""
echo "如果看到权限请求对话框，请点击 '允许'"
echo "然后检查 系统偏好设置 > 通知 中的 Ufoo 设置"
