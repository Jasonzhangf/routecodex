#!/bin/bash

set -euo pipefail

echo "🌍 安装 RouteCodex release snapshot（独立构建 + 安装 + 健康验证）..."

SOURCE_ROOT="$(pwd -P)"
INSTALL_BUILD_ROOT=""
source "$SOURCE_ROOT/scripts/lib/install-lifecycle-lock.sh"
acquire_routecodex_install_lock
VERIFY_PORT="${ROUTECODEX_INSTALL_VERIFY_PORT:-5520}"
VERIFY_HOST="${ROUTECODEX_INSTALL_VERIFY_HOST:-127.0.0.1}"
VERIFY_BASE_URL="http://${VERIFY_HOST}:${VERIFY_PORT}"
VERIFY_HEALTH_URL="http://${VERIFY_HOST}:${VERIFY_PORT}/health"
EXPECTED_VERSION="$(node -p "require('./package.json').version" 2>/dev/null || true)"

cleanup_isolated_build_root() {
  if [ -n "${INSTALL_BUILD_ROOT:-}" ] && [ "$INSTALL_BUILD_ROOT" != "$SOURCE_ROOT" ] && [ -d "$INSTALL_BUILD_ROOT" ]; then
    rm -rf "$INSTALL_BUILD_ROOT"
  fi
  release_routecodex_install_lock
}
trap cleanup_isolated_build_root EXIT

fail() {
  echo "❌ $1"
  exit 1
}

check_repo_root() {
  if [ ! -f "package.json" ] || [ ! -d "src" ]; then
    fail "请在 routecodex 仓库根目录下执行：scripts/install-release.sh"
  fi
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    fail "Node.js 未安装，需要版本 >=20 <26"
  fi
  local node_major
  node_major="$(node -p "process.versions.node.split('.')[0]")"
  if [ "$node_major" -lt 20 ] || [ "$node_major" -ge 26 ]; then
    fail "Node.js 版本不受支持：$(node -v)（要求 >=20 <26，与 package.json engines 一致）"
  fi
  echo "✅ Node.js: $(node -v)"
}

check_tmux() {
  if ! command -v tmux >/dev/null 2>&1; then
    echo "❌ tmux 未安装"
    echo "💡 RouteCodex/RCC 的 tmux 会话管理 / 注入 / heartbeat 依赖 tmux"
    echo "💡 请先安装 tmux 后再执行 release 安装，例如："
    echo "   macOS(Homebrew): brew install tmux"
    echo "   Ubuntu/Debian: apt-get install -y tmux"
    echo "   CentOS/RHEL: yum install -y tmux"
    exit 1
  fi
  echo "✅ tmux: $(tmux -V 2>/dev/null || echo tmux)"
}

check_rust() {
  local cargo_bin="${CARGO:-}"
  if [ -n "$cargo_bin" ] && "$cargo_bin" --version >/dev/null 2>&1; then
    echo "✅ Rust cargo: $("$cargo_bin" --version)"
    return
  fi
  if command -v cargo >/dev/null 2>&1; then
    echo "✅ Rust cargo: $(cargo --version)"
    return
  fi
  if [ -x "$HOME/.cargo/bin/cargo" ] && "$HOME/.cargo/bin/cargo" --version >/dev/null 2>&1; then
    echo "✅ Rust cargo: $("$HOME/.cargo/bin/cargo" --version)"
    return
  fi
  fail "cargo 未安装或不可用；build:min 需要 Rust native build（sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs）"
}

check_curl() {
  if ! command -v curl >/dev/null 2>&1; then
    fail "curl 未安装；release 安装后的 /health 验证依赖 curl"
  fi
  echo "✅ curl: $(curl --version | head -n 1)"
}

prepare_isolated_build_root() {
  if [ -n "${INSTALL_BUILD_ROOT:-}" ]; then
    return
  fi
  if [ "${ROUTECODEX_INSTALL_INPLACE_BUILD:-0}" = "1" ]; then
    INSTALL_BUILD_ROOT="$SOURCE_ROOT"
    echo "⚠️  ROUTECODEX_INSTALL_INPLACE_BUILD=1: 使用仓库目录构建（非隔离）"
    return
  fi

  INSTALL_BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/routecodex-release-build.XXXXXX")"
  echo "🧱 使用隔离构建目录: $INSTALL_BUILD_ROOT"

  copy_isolated_path() {
    local relative="$1"
    local source_path="$SOURCE_ROOT/$relative"
    local target_path="$INSTALL_BUILD_ROOT/$relative"
    if [ ! -e "$source_path" ]; then
      return
    fi
    mkdir -p "$(dirname "$target_path")"
    if [ -d "$source_path" ]; then
      if command -v rsync >/dev/null 2>&1; then
        rsync -a --delete "$source_path/" "$target_path/"
      else
        mkdir -p "$target_path"
        (cd "$source_path" && tar -cf - .) | (cd "$target_path" && tar -xf -)
      fi
    else
      cp -p "$source_path" "$target_path"
    fi
  }

  copy_llmswitch_core() {
    local relative="sharedmodule/llmswitch-core"
    local source_path="$SOURCE_ROOT/$relative"
    local target_path="$INSTALL_BUILD_ROOT/$relative"
    mkdir -p "$(dirname "$target_path")"
    mkdir -p "$target_path"
    (cd "$source_path" && COPYFILE_DISABLE=1 tar \
      --exclude './rust-core/target' \
      --exclude './node_modules' \
      --exclude './dist' \
      --exclude './coverage' \
      --exclude './test-results' \
      --exclude './tsconfig.tsbuildinfo' \
      -cf - .) | (cd "$target_path" && tar -xf -)
    if [ -d "$SOURCE_ROOT/$relative/node_modules" ]; then
      ln -s "$SOURCE_ROOT/$relative/node_modules" "$target_path/node_modules"
    fi
  }

  copy_agent_collab_contract() {
    copy_isolated_path ".agent-collab/PROTOCOL.md"
    copy_isolated_path ".agent-collab/schema"
    copy_isolated_path ".agent-collab/examples"
  }

  for item in \
    package.json package-lock.json tsconfig.json tsconfig.jest.json jest.config.js README.md LICENSE \
    .gitignore AGENTS.md \
    src scripts config configsamples docs tests webui vendor v3; do
    copy_isolated_path "$item"
  done
  copy_isolated_path ".agents/skills/rcc-dev-skills"
  copy_agent_collab_contract
  copy_isolated_path "samples/mock-provider"
  copy_llmswitch_core

  if [ -d "$SOURCE_ROOT/node_modules" ]; then
    ln -s "$SOURCE_ROOT/node_modules" "$INSTALL_BUILD_ROOT/node_modules"
  fi
}

production_dependencies_ready() {
  INSTALL_BUILD_ROOT="$INSTALL_BUILD_ROOT" node <<'NODE'
const fs = require('fs');
const path = require('path');

const root = process.env.INSTALL_BUILD_ROOT;
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const dependencies = Object.keys(pkg.dependencies || {}).sort();
const missing = dependencies.filter((dependencyName) => {
  const packageJsonPath = path.join(root, 'node_modules', ...dependencyName.split('/'), 'package.json');
  return !fs.existsSync(packageJsonPath);
});
if (missing.length > 0) {
  console.error(`missing production dependencies: ${missing.join(', ')}`);
  process.exit(1);
}
NODE
}

prepare_dependencies() {
  if [ -d "$INSTALL_BUILD_ROOT/node_modules" ]; then
    if production_dependencies_ready; then
      echo "✅ 根项目依赖闭包已验证，跳过安装"
      return
    fi
    echo "⚠️  根项目 node_modules 依赖闭包不完整，重建依赖"
    if [ "$INSTALL_BUILD_ROOT" != "$SOURCE_ROOT" ]; then
      rm -rf "$INSTALL_BUILD_ROOT/node_modules"
    fi
  fi

  echo "📦 安装根项目依赖..."
  export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
  export PUPPETEER_SKIP_DOWNLOAD=1
  if [ -f "$INSTALL_BUILD_ROOT/package-lock.json" ]; then
    (cd "$INSTALL_BUILD_ROOT" && npm ci --no-audit --no-fund --ignore-scripts --loglevel=warn)
  else
    (cd "$INSTALL_BUILD_ROOT" && npm install --no-audit --no-fund --ignore-scripts --prefer-offline --progress=false --loglevel=warn)
  fi
  if ! production_dependencies_ready; then
    fail "根项目 production dependency closure 仍不完整"
  fi
}

build_release_project() {
  echo "🔨 构建 release dist（隔离源码）..."
  prepare_isolated_build_root
  prepare_dependencies
  (
    cd "$INSTALL_BUILD_ROOT"
    node scripts/build-core.mjs
    BUILD_MODE=release ROUTECODEX_SKIP_AUTO_BUMP="${ROUTECODEX_SKIP_AUTO_BUMP:-1}" npm run build:min
    node scripts/ensure-cli-executable.mjs
  )
  if [ ! -f "$INSTALL_BUILD_ROOT/dist/cli.js" ]; then
    fail "构建失败：缺少 $INSTALL_BUILD_ROOT/dist/cli.js"
  fi
  echo "✅ release 构建完成"
}

cleanup_old_global_package() {
  echo "🧹 清理 release 侧 npm 全局 routecodex 历史残留（若存在）..."
  local global_node_modules
  global_node_modules="$(npm root -g 2>/dev/null || true)"
  npm uninstall -g routecodex >/dev/null 2>&1 || true
  if [ -n "${global_node_modules:-}" ] && [ -e "${global_node_modules}/routecodex" ]; then
    echo "🧹 删除旧全局包: ${global_node_modules}/routecodex"
    rm -rf "${global_node_modules}/routecodex"
  fi
}

install_release_snapshot() {
  echo "📦 安装 release snapshot（不可变运行时）..."
  (
    cd "$INSTALL_BUILD_ROOT"
    ROUTECODEX_RELEASE_SOURCE_ROOT="$SOURCE_ROOT" node scripts/install-release-snapshot.mjs
    node scripts/ensure-cli-executable.mjs
  )
  ROUTECODEX_SHIM_PREFER_RELEASE_SNAPSHOT=1 node "$SOURCE_ROOT/scripts/ensure-cli-command-shim.mjs"
}

verify_cli_commands() {
  echo "🔍 验证 routecodex / rcc 安装..."
  if ! command -v routecodex >/dev/null 2>&1; then
    fail "未找到 routecodex 命令，请检查 shim 生成和 PATH"
  fi
  if ! command -v rcc >/dev/null 2>&1; then
    fail "未找到 rcc 命令，请检查 shim 生成和 PATH"
  fi
  echo "✅ routecodex: $(command -v routecodex)"
  echo "✅ rcc: $(command -v rcc)"
  routecodex --version
  rcc --version
}

verify_runtime_health() {
  echo "🚦 验证 release runtime 启动与健康状态..."
  if [ -z "${EXPECTED_VERSION:-}" ]; then
    fail "无法读取 package.json version，不能验证 release runtime 版本"
  fi
  echo "🔒 期望 release runtime version: ${EXPECTED_VERSION}"

  health_matches_expected_version() {
    local health_file="$1"
    node -e "const fs=require('fs');const p=process.argv[1];const expected=process.argv[2];const raw=fs.readFileSync(p,'utf8');const body=JSON.parse(raw);if(body.status==='ok'&&body.ready===true&&body.pipelineReady===true&&body.version===expected){process.exit(0)}process.exit(1)" "$health_file" "$EXPECTED_VERSION"
  }

  health_reports_ready_wrong_version() {
    local health_file="$1"
    node -e "const fs=require('fs');const p=process.argv[1];const expected=process.argv[2];const raw=fs.readFileSync(p,'utf8');const body=JSON.parse(raw);if(body.status==='ok'&&body.ready===true&&body.pipelineReady===true&&typeof body.version==='string'&&body.version!==expected){console.log(body.version);process.exit(0)}process.exit(1)" "$health_file" "$EXPECTED_VERSION"
  }

  probe_release_runtime_available() {
    curl -fsS --max-time 2 "$VERIFY_HEALTH_URL" >/dev/null 2>&1
  }

  restart_release_runtime_for_aggregate() {
    echo "♻️  使用成员端口 ${VERIFY_PORT} 定位并重启聚合 RouteCodex server instance（只请求一次）"
    ROUTECODEX_SHIM_PREFER_RELEASE_SNAPSHOT=1 \
    ROUTECODEX_RESTART_WAIT_MS="${ROUTECODEX_RESTART_WAIT_MS:-120000}" \
    RCC_RESTART_WAIT_MS="${RCC_RESTART_WAIT_MS:-120000}" \
    rcc restart --port "$VERIFY_PORT" --host "$VERIFY_HOST"
  }

  start_release_runtime_when_stopped() {
    ROUTECODEX_SHIM_PREFER_RELEASE_SNAPSHOT=1 \
    ROUTECODEX_START_DAEMON=1 \
    RCC_START_DAEMON=1 \
    ROUTECODEX_RESTART_WAIT_MS="${ROUTECODEX_RESTART_WAIT_MS:-120000}" \
    RCC_RESTART_WAIT_MS="${RCC_RESTART_WAIT_MS:-120000}" \
    rcc start --no-restart --port "$VERIFY_PORT"
  }

  if probe_release_runtime_available; then
    restart_release_runtime_for_aggregate
  else
    echo "ℹ️  ${VERIFY_HEALTH_URL} 当前不可用，按 stopped 状态启动 release runtime"
    start_release_runtime_when_stopped
  fi

  local attempt=1
  local max_attempts=20
  local health_dump="/tmp/routecodex-install-release-health.$$"
  local wrong_version=""
  while [ "$attempt" -le "$max_attempts" ]; do
    if curl -fsS "$VERIFY_HEALTH_URL" >"$health_dump"; then
      if health_matches_expected_version "$health_dump"; then
        echo "✅ /health 通过且版本匹配: $VERIFY_HEALTH_URL version=${EXPECTED_VERSION}"
        rm -f "$health_dump"
        return
      fi
      wrong_version="$(health_reports_ready_wrong_version "$health_dump" || true)"
      if [ -n "$wrong_version" ]; then
        echo "❌ live runtime version 仍不匹配: ${VERIFY_HEALTH_URL} expected=${EXPECTED_VERSION} actual=${wrong_version}"
        echo "最近一次响应:"
        cat "$health_dump"
        rm -f "$health_dump"
        exit 1
      fi
    fi
    sleep 1
    attempt=$((attempt + 1))
  done

  attempt=1
  while [ "$attempt" -le "$max_attempts" ]; do
    if curl -fsS "$VERIFY_HEALTH_URL" >"$health_dump"; then
      if health_matches_expected_version "$health_dump"; then
        echo "✅ /health 通过且版本匹配: $VERIFY_HEALTH_URL version=${EXPECTED_VERSION}"
        rm -f "$health_dump"
        return
      fi
    fi
    sleep 1
    attempt=$((attempt + 1))
  done

  echo "❌ /health 未通过或 live runtime 版本不匹配: $VERIFY_HEALTH_URL expected=${EXPECTED_VERSION}"
  if [ -f "$health_dump" ]; then
    echo "最近一次响应:"
    cat "$health_dump"
    rm -f "$health_dump"
  fi
  exit 1
}

main() {
  check_repo_root
  check_node
  check_tmux
  check_rust
  check_curl
  echo "📦 当前源码版本: routecodex@$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")"
  cleanup_old_global_package
  build_release_project
  install_release_snapshot
  verify_cli_commands
  verify_runtime_health
  echo ""
  echo "🎉 release 安装完成（snapshot 模式）"
  echo "使用命令: rcc"
}

main "$@"
