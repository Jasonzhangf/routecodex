#!/bin/bash

set -euo pipefail

echo "🌍 全局安装 rcc (release 包)..."

# 确保在项目根目录执行
if [ ! -f "package.json" ] || [ ! -d "src" ]; then
  echo "❌ 请在 routecodex 仓库根目录下执行：scripts/install-release.sh"
  exit 1
fi

# 读取版本号
VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
echo "📦 当前源码版本: routecodex@${VERSION}"

echo "🔨 构建源码..."
npm run build

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

echo "🛠️  重写临时包为 rcc (release)..."
node - <<'EOF' "${PKG_DIR}"
const fs = require('fs');
const path = require('path');
const pkgDir = process.argv[2];
const pkgPath = path.join(pkgDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.name = 'rcc';
pkg.bin = { rcc: './dist/cli.js' };
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
EOF

echo "📦 为 rcc (release) 生成独立 tgz 包..."
(
  cd "${PKG_DIR}"
  npm pack --silent
)
RCC_TARBALL="${PKG_DIR}/rcc-${VERSION}.tgz"
if [ ! -f "${RCC_TARBALL}" ]; then
  echo "❌ 打包 rcc 失败，未找到 ${RCC_TARBALL}"
  exit 1
fi

echo "🧹 卸载已有 rcc 全局安装（若存在）..."
npm uninstall -g rcc >/dev/null 2>&1 || true

echo "🌍 全局安装 rcc (release)..."
npm install -g "${RCC_TARBALL}" --no-audit --no-fund

echo "🔍 验证 rcc 安装..."
if command -v rcc >/dev/null 2>&1; then
  echo "✅ rcc 已全局安装：$(command -v rcc)"
  rcc --version || true
else
  echo "❌ 未找到 rcc 命令，请检查 npm 全局安装路径"
  exit 1
fi

echo ""
echo "🎉 release 安装完成！"
echo "使用命令: rcc"
