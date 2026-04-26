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

echo "🧹 清理历史 @jsonstudio/rcc 残留（若存在）..."
npm uninstall -g @jsonstudio/rcc >/dev/null 2>&1 || true
GLOBAL_NODE_MODULES=$(npm root -g 2>/dev/null || true)
if [ -n "${GLOBAL_NODE_MODULES:-}" ] && [ -d "${GLOBAL_NODE_MODULES}/@jsonstudio/rcc" ]; then
  echo "🧹 删除旧目录: ${GLOBAL_NODE_MODULES}/@jsonstudio/rcc"
  rm -rf "${GLOBAL_NODE_MODULES}/@jsonstudio/rcc"
fi

echo "🔨 构建 release dist（本地源码）..."
BUILD_MODE=release ROUTECODEX_SKIP_AUTO_BUMP=${ROUTECODEX_SKIP_AUTO_BUMP:-1} npm run build:min
npm run fix:cli-permission

echo "🌍 全局安装 routecodex（release 产物）..."
npm install -g . --no-audit --no-fund --omit=optional --ignore-scripts
node scripts/ensure-cli-command-shim.mjs || true
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

verify_server_request() {
  local VERIFY_CONFIG=${ROUTECODEX_INSTALL_VERIFY_CONFIG:-"$HOME/.rcc/config.json"}
  local VERIFY_TIMEOUT=${ROUTECODEX_INSTALL_VERIFY_TIMEOUT:-240}
  local VERIFY_LOG="/tmp/routecodex-release-verify-$(date +%s).log"
  local TIMEOUT_BIN=""
  if command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_BIN="gtimeout"
  elif command -v timeout >/dev/null 2>&1; then
    TIMEOUT_BIN="timeout"
  fi
  local VERIFY_CMD=(node scripts/install-verify.mjs --launcher cli --cli-binary rcc --mode responses --config "$VERIFY_CONFIG")
  echo ""
  echo "🧪 验证 release 安装的端到端工具链路..."
  if [ ! -f "$VERIFY_CONFIG" ]; then
    echo "❌ 未找到验证配置文件: $VERIFY_CONFIG"
    echo "💡 请先准备该 provider 配置后重试"
    exit 1
  fi
  echo "   使用配置: $VERIFY_CONFIG"
  echo "   日志: $VERIFY_LOG"
  if [ -n "$TIMEOUT_BIN" ]; then
    echo "   使用 ${TIMEOUT_BIN} 超时保护 (${VERIFY_TIMEOUT}s)"
    "$TIMEOUT_BIN" "$VERIFY_TIMEOUT" "${VERIFY_CMD[@]}" >"$VERIFY_LOG" 2>&1 &
  else
    echo "⚠️  未找到 gtimeout/timeout，验证过程无额外超时保护"
    "${VERIFY_CMD[@]}" >"$VERIFY_LOG" 2>&1 &
  fi
  local VERIFY_PID=$!
  echo "   校验后台PID=${VERIFY_PID}"
  set +e
  wait "$VERIFY_PID"
  local VERIFY_STATUS=$?
  set -e
  if [ "$VERIFY_STATUS" -ne 0 ]; then
    echo "❌ 工具请求验证失败 (exit $VERIFY_STATUS)，请查看日志: $VERIFY_LOG"
    tail -n 160 "$VERIFY_LOG" 2>/dev/null || true
    exit 1
  fi
  echo "✅ 工具请求验证完成"
}

if [ "${ROUTECODEX_INSTALL_VERIFY_SKIP:-0}" = "1" ]; then
  echo "⚠️  已设置 ROUTECODEX_INSTALL_VERIFY_SKIP=1，跳过 release 安装端到端验证"
else
  verify_server_request
fi

echo ""
echo "🎉 release 安装完成（本地源码模式）！"
echo "使用命令: rcc"
