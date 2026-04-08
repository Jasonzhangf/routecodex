#!/bin/bash

set -euo pipefail

echo "🌍 全局安装 @jsonstudio/rcc (release 包)..."

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

echo "🔨 构建并打包 rcc（本地内联 llms）..."
# 统一走 pack:rcc（内部会 release build + 生成 @jsonstudio/rcc tgz），
# 并默认内联本地 sharedmodule/llmswitch-core 到包内，避免依赖外部 npm 版本。
RCC_LLMS_INLINE_LOCAL=1 npm run pack:rcc

# 构建过程可能自动 bump 版本号，因此需要重新读取
NEW_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "${VERSION}")
if [ "${NEW_VERSION}" != "${VERSION}" ]; then
  echo "ℹ️  构建后版本变更: ${VERSION} → ${NEW_VERSION}"
  VERSION=${NEW_VERSION}
fi

RCC_TARBALL="jsonstudio-rcc-${VERSION}.tgz"
if [ ! -f "${RCC_TARBALL}" ]; then
  echo "❌ 打包失败，未找到 ${RCC_TARBALL}"
  exit 1
fi

echo "🧹 卸载已有 @jsonstudio/rcc 全局安装（若存在）..."
npm uninstall -g @jsonstudio/rcc >/dev/null 2>&1 || true

echo "🌍 全局安装 @jsonstudio/rcc (release)..."
npm install -g "${RCC_TARBALL}" --no-audit --no-fund
node scripts/ensure-cli-command-shim.mjs || true

echo "🔍 验证 rcc 安装..."
if command -v rcc >/dev/null 2>&1; then
  echo "✅ @jsonstudio/rcc 已全局安装：$(command -v rcc)"
  rcc --version || true
  node -e "const fs=require('fs');const path=require('path');const cp=require('child_process');const root=cp.execSync('npm root -g').toString().trim();const llmsPath=path.join(root,'@jsonstudio','rcc','node_modules','@jsonstudio','llms');const pkgPath=path.join(llmsPath,'package.json');const link=fs.existsSync(llmsPath)&&fs.lstatSync(llmsPath).isSymbolicLink();const target=link?fs.readlinkSync(llmsPath):'(inline)';const version=fs.existsSync(pkgPath)?JSON.parse(fs.readFileSync(pkgPath,'utf8')).version:'unknown';console.log('🔎 全局 rcc @jsonstudio/llms:',version,'link=',link,'target=',target);"
else
  echo "❌ 未找到 rcc 命令，请检查 npm 全局安装路径"
  exit 1
fi

ensure_rcc_zod_runtime() {
  local GLOBAL_NODE_MODULES
  GLOBAL_NODE_MODULES=$(npm root -g 2>/dev/null || true)
  if [ -z "${GLOBAL_NODE_MODULES:-}" ]; then
    echo "⚠️  无法解析 npm 全局 node_modules 路径，跳过 zod 运行时自检"
    return
  fi
  local RCC_DIR="${GLOBAL_NODE_MODULES}/@jsonstudio/rcc"
  if [ ! -d "$RCC_DIR" ]; then
    echo "⚠️  未找到全局 rcc 目录: $RCC_DIR，跳过 zod 运行时自检"
    return
  fi

  if node -e "require.resolve('zod/v4', { paths: [process.argv[1]] });" "$RCC_DIR" >/dev/null 2>&1; then
    echo "✅ zod/v4 运行时可解析"
    return
  fi

  echo "⚠️  检测到全局 rcc 的 zod/v4 缺失，执行本地自愈..."
  local LOCAL_ZOD_DIR="${PWD}/node_modules/zod"
  local TARGET_ZOD_DIR="${RCC_DIR}/node_modules/zod"
  if [ -d "$LOCAL_ZOD_DIR" ]; then
    rm -rf "$TARGET_ZOD_DIR"
    mkdir -p "${RCC_DIR}/node_modules"
    cp -R "$LOCAL_ZOD_DIR" "$TARGET_ZOD_DIR"
  else
    echo "❌ 本地 zod 依赖不存在：$LOCAL_ZOD_DIR"
    echo "💡 请先执行 npm install 后重试 release 安装"
    exit 1
  fi

  if node -e "require.resolve('zod/v4', { paths: [process.argv[1]] });" "$RCC_DIR" >/dev/null 2>&1; then
    local ZOD_VER
    ZOD_VER=$(node -e "const fs=require('fs');const p=process.argv[1]+'/node_modules/zod/package.json';const j=JSON.parse(fs.readFileSync(p,'utf8'));process.stdout.write(String(j.version||'unknown'));" "$RCC_DIR")
    echo "✅ zod/v4 自愈完成（version=${ZOD_VER}）"
    return
  fi

  echo "❌ zod/v4 运行时仍不可解析，请检查全局安装目录权限与依赖完整性"
  exit 1
}

ensure_rcc_zod_runtime

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
echo "🎉 release 安装完成！"
echo "使用命令: rcc"
