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

echo "🔨 构建源码..."
# release 包：显式使用 BUILD_MODE=release 以便在编译期区分 dev/release
BUILD_MODE=release npm run build

# 构建过程可能自动 bump 版本号，因此需要重新读取
NEW_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "${VERSION}")
if [ "${NEW_VERSION}" != "${VERSION}" ]; then
  echo "ℹ️  构建后版本变更: ${VERSION} → ${NEW_VERSION}"
  VERSION=${NEW_VERSION}
fi

TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/rcc-release.XXXXXX")
TARBALL="routecodex-${VERSION}.tgz"

echo "📦 打包当前源码为临时 npm 包..."
rm -f "routecodex-"*.tgz 2>/dev/null || true
npm pack --silent

if [ ! -f "${TARBALL}" ]; then
  echo "❌ 打包失败，未找到 ${TARBALL}"
  exit 1
fi

echo "📂 解包到临时目录: ${TMP_DIR}"
tar xzf "${TARBALL}" -C "${TMP_DIR}"
PKG_DIR="${TMP_DIR}/package"

if [ ! -d "${PKG_DIR}" ]; then
  echo "❌ 解包失败，未找到 ${PKG_DIR}"
  exit 1
fi

echo "🛠️  重写临时包为 @jsonstudio/rcc (release)..."
node - <<'EOF' "${PKG_DIR}"
const fs = require('fs');
const path = require('path');
const pkgDir = process.argv[2];
const pkgPath = path.join(pkgDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.name = '@jsonstudio/rcc';
pkg.bin = { rcc: './dist/cli.js' };
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
EOF

echo "📦 为 @jsonstudio/rcc (release) 生成独立 tgz 包..."
(
  cd "${PKG_DIR}"
  npm pack --silent
)
RCC_TARBALL="${PKG_DIR}/jsonstudio-rcc-${VERSION}.tgz"
if [ ! -f "${RCC_TARBALL}" ]; then
  echo "❌ 打包 @jsonstudio/rcc 失败，未找到 ${RCC_TARBALL}"
  exit 1
fi

echo "🧹 卸载已有 @jsonstudio/rcc 全局安装（若存在）..."
npm uninstall -g @jsonstudio/rcc >/dev/null 2>&1 || true

echo "🌍 全局安装 @jsonstudio/rcc (release)..."
npm install -g "${RCC_TARBALL}" --no-audit --no-fund

echo "🔍 验证 rcc 安装..."
if command -v rcc >/dev/null 2>&1; then
  echo "✅ @jsonstudio/rcc 已全局安装：$(command -v rcc)"
  rcc --version || true
else
  echo "❌ 未找到 rcc 命令，请检查 npm 全局安装路径"
  exit 1
fi

verify_server_request() {
  local VERIFY_CONFIG=${ROUTECODEX_INSTALL_VERIFY_CONFIG:-"$HOME/.routecodex/config.json"}
  local VERIFY_TIMEOUT=${ROUTECODEX_INSTALL_VERIFY_TIMEOUT:-240}
  local VERIFY_LOG="/tmp/routecodex-release-verify-$(date +%s).log"
  local TIMEOUT_BIN=""
  if command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_BIN="gtimeout"
  elif command -v timeout >/dev/null 2>&1; then
    TIMEOUT_BIN="timeout"
  fi
  local VERIFY_CMD=(node scripts/install-verify.mjs --launcher cli --cli-binary rcc --config "$VERIFY_CONFIG")
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
