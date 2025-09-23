#!/bin/bash

# RouteCodex 简化安装脚本
set -e

echo "🚀 RouteCodex 自动安装"
echo "========================"

# 检查npm
if ! command -v npm &> /dev/null; then
    echo "❌ 错误: 请先安装 Node.js 和 npm"
    exit 1
fi

# 进入项目根目录
cd "$(dirname "$0")/.."

# 清理
echo "🧹 清理旧文件..."
rm -rf dist
rm -f routecodex-*.tgz

# 构建项目
echo "📦 构建项目..."
npm install > /dev/null 2>&1
npm run build > /dev/null 2>&1

# 创建包
echo "📋 创建npm包..."
npm pack > /dev/null 2>&1

# 查找包文件
PACKAGE_FILE=$(find . -maxdepth 1 -name "routecodex-*.tgz" -type f | head -1)
if [ -z "$PACKAGE_FILE" ]; then
    echo "❌ 包创建失败"
    exit 1
fi

PACKAGE_FILE=$(basename "$PACKAGE_FILE")
echo "✅ 包创建成功: $PACKAGE_FILE"

# 卸载旧版本
if npm list -g routecodex > /dev/null 2>&1; then
    echo "🗑️  卸载旧版本..."
    npm uninstall -g routecodex > /dev/null 2>&1
fi

# 安装新版本
echo "🔧 安装新版本..."
if npm install -g "$PACKAGE_FILE" > /dev/null 2>&1; then
    echo "✅ 安装成功！"
else
    echo "❌ 安装失败"
    exit 1
fi

# 验证安装
echo "🔍 验证安装..."
sleep 1
if routecodex --version > /dev/null 2>&1; then
    VERSION=$(routecodex --version)
    echo "✅ RouteCodex $VERSION 安装成功！"
else
    echo "❌ 安装验证失败"
    exit 1
fi

# 清理
echo "🧹 清理临时文件..."
rm -f "$PACKAGE_FILE"

echo ""
echo "🎯 快速开始："
echo "  routecodex examples    # 查看使用示例"
echo "  routecodex config init # 初始化配置"
echo "  routecodex start       # 启动服务器"
echo ""
echo "📚 更多帮助: routecodex --help"