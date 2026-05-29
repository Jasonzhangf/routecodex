#!/bin/bash

set -euo pipefail

echo "🌍 全局安装 rcc（release，本地源码构建，不依赖 npm 包）..."

# 确保在项目根目录执行
if [ ! -f "package.json" ] || [ ! -d "src" ]; then
  echo "❌ 请在 routecodex 仓库根目录下执行：scripts/install-release.sh"
  exit 1
fi

# 读取版本号
VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
echo "📦 当前源码版本: routecodex@${VERSION}"

if command -v tmux >/dev/null 2>&1; then
  echo "✅ tmux: $(tmux -V 2>/dev/null || echo tmux)"
else
  echo "❌ tmux 未安装"
  echo "💡 RouteCodex/RCC 的 tmux 会话管理 / 注入 / heartbeat 依赖 tmux"
  echo "💡 请先安装 tmux 后再执行 release 安装，例如："
  echo "   macOS(Homebrew): brew install tmux"
  echo "   Ubuntu/Debian: apt-get install -y tmux"
  echo "   CentOS/RHEL: yum install -y tmux"
  exit 1
fi

GLOBAL_NODE_MODULES=$(npm root -g 2>/dev/null || true)

echo "🧹 清理 release 侧 npm 全局 routecodex 历史残留（若存在）..."
npm uninstall -g routecodex >/dev/null 2>&1 || true
if [ -n "${GLOBAL_NODE_MODULES:-}" ] && [ -e "${GLOBAL_NODE_MODULES}/routecodex" ]; then
  echo "🧹 删除旧全局包: ${GLOBAL_NODE_MODULES}/routecodex"
  rm -rf "${GLOBAL_NODE_MODULES}/routecodex"
fi

echo "🔨 构建 release dist（本地源码）..."
BUILD_MODE=release ROUTECODEX_SKIP_AUTO_BUMP=${ROUTECODEX_SKIP_AUTO_BUMP:-1} npm run build:min
npm run fix:cli-permission

echo "📦 安装 release snapshot（不可变运行时）..."
node scripts/install-release-snapshot.mjs
ROUTECODEX_SHIM_PREFER_RELEASE_SNAPSHOT=1 node scripts/ensure-cli-command-shim.mjs || true
node scripts/ensure-cli-executable.mjs || true

echo "🔍 验证 routecodex / rcc 安装..."
if command -v routecodex >/dev/null 2>&1; then
  echo "✅ routecodex 已全局安装：$(command -v routecodex)"
  routecodex --version || true
else
  echo "❌ 未找到 routecodex 命令，请检查 npm 全局安装路径"
  exit 1
fi

if command -v rcc >/dev/null 2>&1; then
  echo "✅ rcc 已可用：$(command -v rcc)"
  rcc --version || true
else
  echo "❌ 未找到 rcc 命令，请检查 shim 生成"
  exit 1
fi

echo "⏭️  release 安装不再执行端到端请求验证；仅验证 CLI/shim 可用。"

echo ""
echo "🎉 release 安装完成（snapshot 模式）！"
echo "使用命令: rcc"
