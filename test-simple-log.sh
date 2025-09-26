#!/bin/bash

# RouteCodex 简单日志配置测试脚本

echo "🧪 开始测试 RouteCodex 简单日志配置功能..."
echo "=================================="

# 1. 测试简单日志命令是否存在
echo "1️⃣ 测试简单日志命令是否存在..."
if command -v routecodex &> /dev/null; then
    echo "✅ routecodex 命令可用"
    
    # 查看简单日志帮助
    echo "📖 查看简单日志帮助:"
    routecodex simple-log --help
else
    echo "❌ routecodex 命令不可用，请先构建项目"
    exit 1
fi

echo ""
echo "2️⃣ 测试简单日志状态查看..."
routecodex simple-log status

echo ""
echo "3️⃣ 测试开启简单日志..."
routecodex simple-log on --level debug --output both

echo ""
echo "4️⃣ 验证配置文件是否创建..."
CONFIG_FILE="$HOME/.routecodex/simple-log-config.json"
if [ -f "$CONFIG_FILE" ]; then
    echo "✅ 配置文件已创建: $CONFIG_FILE"
    echo "📄 配置内容:"
    cat "$CONFIG_FILE"
else
    echo "❌ 配置文件未创建"
fi

echo ""
echo "5️⃣ 测试修改日志级别..."
routecodex simple-log level info

echo ""
echo "6️⃣ 测试修改输出方式..."
routecodex simple-log output console

echo ""
echo "7️⃣ 再次查看状态..."
routecodex simple-log status

echo ""
echo "8️⃣ 测试关闭简单日志..."
routecodex simple-log off

echo ""
echo "9️⃣ 最终状态查看..."
routecodex simple-log status

echo ""
echo "🎉 测试完成！"
echo ""
echo "💡 现在你可以尝试启动服务器来测试实际效果:"
echo "   routecodex start --port 5506"
echo ""
echo "🔥 在服务器运行期间，你可以:"
echo "   - 修改 ~/.routecodex/simple-log-config.json 文件来测试热更新"
echo "   - 使用 'routecodex simple-log level debug' 动态修改日志级别"
echo "   - 使用 'routecodex simple-log output both' 修改输出方式"