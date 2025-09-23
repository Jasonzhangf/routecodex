#!/bin/bash

# RouteCodex 快速安装脚本
# 一键构建并安装最新版本

echo "🚀 RouteCodex 快速安装"
echo "========================"

# 检查是否有npm
if ! command -v npm &> /dev/null; then
    echo "❌ 错误: 请先安装 Node.js 和 npm"
    echo "下载地址: https://nodejs.org/"
    exit 1
fi

# 进入脚本所在目录
cd "$(dirname "$0")/.."

echo "📦 正在构建并安装 RouteCodex..."

# 构建和安装
if ./scripts/build-and-install.sh --skip-tests; then
    echo ""
    echo "✅ 安装成功！"
    echo ""
    echo "🎯 快速开始："
    echo "  routecodex examples    # 查看使用示例"
    echo "  routecodex config init # 初始化配置"
    echo "  routecodex start       # 启动服务器"
    echo ""
    echo "📚 更多帮助："
    echo "  routecodex --help"
    echo ""
else
    echo "❌ 安装失败，请检查错误信息"
    exit 1
fi