#!/bin/bash

set -e

echo "⚡ RouteCodex 快速安装..."

# 检查当前状态
if [ ! -d "node_modules" ]; then
    echo "❌ 缺少依赖，请先运行："
    echo "   npm install"
    exit 1
fi

if [ ! -f "package-lock.json" ]; then
    echo "❌ 缺少 package-lock.json，请先运行："
    echo "   npm install"
    exit 1
fi

# 检查Node.js版本
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo "❌ Node.js 版本过低，需要 >=20"
    exit 1
fi

echo "✅ Node.js: $(node -v)"

# 清理旧安装
echo "🧹 清理旧安装..."
NPM_PREFIX=$(npm config get prefix)
rm -f "$NPM_PREFIX/lib/node_modules/routecodex"
rm -f "$NPM_PREFIX/bin/routecodex"
rm -f "$NPM_PREFIX/bin/rcc"

# 快速构建
echo "🔨 构建项目..."
rm -rf dist
npm run build

if [ ! -f "dist/cli.js" ]; then
    echo "❌ 构建失败"
    exit 1
fi

chmod +x dist/cli.js

# 全局安装
echo "🌍 全局安装..."
npm install -g . --no-audit --no-fund

# 验证安装
if command -v routecodex &> /dev/null; then
    echo "✅ 安装成功！"
    routecodex --version
else
    echo "❌ 安装失败"
    exit 1
fi

echo ""
echo "🎉 快速安装完成！"
echo "使用命令: routecodex"
