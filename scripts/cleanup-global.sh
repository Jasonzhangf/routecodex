#!/bin/bash

set -e

echo "🧹 清理RouteCodex全局安装残留..."

# 检查npm配置
NPM_PREFIX=$(npm config get prefix)
echo "📍 npm全局目录: $NPM_PREFIX"

# 清理node_modules中的routecodex相关链接
echo "🗑️  清理node_modules中的routecodex链接..."
if [ -d "$NPM_PREFIX/lib/node_modules" ]; then
    find "$NPM_PREFIX/lib/node_modules" -name "*routecodex*" -type l -exec rm -v {} \; 2>/dev/null || true
    find "$NPM_PREFIX/lib/node_modules" -name "@routecodex" -type d -exec rm -rfv {} \; 2>/dev/null || true
fi

# 清理bin目录中的routecodex命令
echo "🗑️  清理bin目录中的routecodex命令..."
if [ -d "$NPM_PREFIX/bin" ]; then
    rm -fv "$NPM_PREFIX/bin/routecodex" 2>/dev/null || true
    rm -fv "$NPM_PREFIX/bin/rcc" 2>/dev/null || true
fi

# 检查npm缓存权限问题
echo "🔍 检查npm缓存权限..."
NPM_CACHE=$(npm config get cache)
echo "📍 npm缓存目录: $NPM_CACHE"

if [ -d "$NPM_CACHE" ]; then
    # 检查是否有root-owned文件
    if find "$NPM_CACHE" -not -user $(whoami) -print -quit | grep -q .; then
        echo "⚠️  发现权限问题：npm缓存包含其他用户的文件"
        echo "💡 请运行以下命令修复权限："
        echo "   sudo chown -R $(id -u):$(id -g) \"$NPM_CACHE\""
        echo ""
        echo "或者删除缓存重新生成："
        echo "   rm -rf \"$NPM_CACHE\""
        echo ""
    else
        echo "✅ npm缓存权限正常"
    fi
fi

# 检查当前目录是否有构建产物
echo "🔍 检查当前目录构建状态..."
if [ -f "dist/cli.js" ]; then
    echo "✅ 发现构建产物"
else
    echo "❌ 未发现构建产物，需要先运行 npm run build"
fi

echo ""
echo "🎉 清理完成！现在可以重新安装："
echo "   npm run install:global"
echo ""
echo "或者手动安装："
echo "   npm run build"
echo "   npm install -g ."