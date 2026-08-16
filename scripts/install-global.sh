#!/bin/bash

set -euo pipefail

echo "🌍 全局安装 routecodex..."

SOURCE_ROOT="$(pwd -P)"
INSTALL_BUILD_ROOT=""
for arg in "$@"; do
    case "$arg" in
        *) echo "❌ 不支持的 install:global 参数: $arg"; exit 1 ;;
    esac
done
source "$SOURCE_ROOT/scripts/lib/install-lifecycle-lock.sh"
acquire_routecodex_install_lock

cleanup_isolated_build_root() {
    if [ -n "${INSTALL_BUILD_ROOT:-}" ] && [ "$INSTALL_BUILD_ROOT" != "$SOURCE_ROOT" ] && [ -d "$INSTALL_BUILD_ROOT" ]; then
        rm -rf "$INSTALL_BUILD_ROOT"
    fi
    release_routecodex_install_lock
}
trap cleanup_isolated_build_root EXIT

# 检查npm配置
echo "📋 npm配置信息:"
NPM_PREFIX=$(npm config get prefix)
# 更可靠地获取全局 node_modules 路径
GLOBAL_NODE_MODULES=$(npm root -g 2>/dev/null || true)
if [ -z "${GLOBAL_NODE_MODULES:-}" ]; then
  GLOBAL_NODE_MODULES="$NPM_PREFIX/lib/node_modules"
fi
echo "   全局安装目录: $NPM_PREFIX"
echo "   全局包目录: $GLOBAL_NODE_MODULES"

# 检查权限（对于Homebrew安装的Node.js应该不需要sudo）
if [ -w "$NPM_PREFIX" ]; then
    echo "   ✅ 具有写入权限，无需sudo"
else
    echo "   ⚠️  警告：对 $NPM_PREFIX 没有写入权限"
    echo "   💡 建议：如果是Homebrew安装的Node.js，应该无需sudo"
    echo "   💡 如果需要权限，请先运行: npm config set prefix ~/.npm-global"
fi
echo ""

# 检查Node.js
check_node() {
    if ! command -v node &> /dev/null; then
        echo "❌ Node.js 未安装"
        exit 1
    fi
    
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 20 ] || [ "$NODE_VERSION" -ge 26 ]; then
        echo "❌ Node.js 版本不受支持，需要 >=20 <26（与 package.json engines 一致）"
        exit 1
    fi
    # Node 24/25 在部分原生依赖上仍可能触发编译，给出提示但不阻塞
    if [ "$NODE_VERSION" -ge 24 ]; then
        echo "⚠️  检测到 Node $(node -v)，某些原生依赖可能会尝试编译，建议使用 Node 22 以获得更快安装"
    fi

    echo "✅ Node.js: $(node -v)"
}


# 构建项目

# 全局安装



# 验证安装

verify_direct_v3_install() {
    local expected_bin="$HOME/.local/bin/rccv3"
    local expected_routecodex="$HOME/.local/bin/routecodex"
    local expected_rcc="$HOME/.local/bin/rcc"
    local rccv3_version
    local routecodex_version
    local rcc_version
    echo "🔍 验证直接 V3 binary 安装..."
    if [ ! -x "$expected_bin" ]; then
        echo "❌ V3 binary 未安装到 $expected_bin"
        exit 1
    fi
    if [ "$(command -v rccv3)" != "$expected_bin" ]; then
        local actual_rccv3
        actual_rccv3="$(command -v rccv3)"
        local actual_version
        actual_version="$("$actual_rccv3" --version 2>/dev/null || true)"
        local expected_version
        expected_version="$("$expected_bin" --version 2>/dev/null || true)"
        if [ -n "$actual_version" ] && { [ -z "$expected_version" ] || [ "$actual_version" = "$expected_version" ]; }; then
            echo "⚠️  rccv3 解析到其他同版本入口: $actual_rccv3（PATH 顺序；$expected_version）"
        else
            echo "❌ rccv3 未解析到直接安装路径: $actual_rccv3 ($actual_version)"
            exit 1
        fi
    fi
    if [ "$(command -v routecodex)" != "$expected_routecodex" ]; then
        echo "❌ routecodex 未解析到直接安装路径: $(command -v routecodex)"
        exit 1
    fi
    if [ "$(command -v rcc)" != "$expected_rcc" ]; then
        echo "❌ rcc 未解析到直接安装路径: $(command -v rcc)"
        exit 1
    fi
    rccv3_version="$(rccv3 --version)"
    routecodex_version="$(routecodex --version)"
    rcc_version="$(rcc --version)"
    if [ "$routecodex_version" != "$rccv3_version" ] || [ "$rcc_version" != "$rccv3_version" ]; then
        echo "❌ V3 command 版本不一致: rccv3=$rccv3_version routecodex=$routecodex_version rcc=$rcc_version"
        exit 1
    fi
    echo "✅ V3 command identity: $rccv3_version"
    rccv3 config check -c "$HOME/.rcc/config.v3.toml"
}


restart_managed_dev_server_if_requested() {
    local restart_only="${ROUTECODEX_BUILD_RESTART_ONLY:-${RCC_BUILD_RESTART_ONLY:-0}}"
    if [ "$restart_only" != "1" ] && [ "$restart_only" != "true" ]; then
        return
    fi

    local restart_config="${ROUTECODEX_INSTALL_VERIFY_CONFIG:-${RCC_INSTALL_VERIFY_CONFIG:-$HOME/.rcc/config.v3.toml}}"
    echo ""
    echo "🔄 尝试通过 V3 aggregate restart 刷新现有 RouteCodex 服务..."
    if routecodex restart -c "$restart_config"; then
        echo "✅ V3 聚合服务已重启"
        return
    fi
    echo "❌ V3 聚合重启失败: $restart_config"
    exit 1
}

# 清理旧安装

run_default_v3_install() {
    check_node
    cleanup_retired_v2_install
    node scripts/cleanup-stale-server-pids.mjs --quiet
    npm --prefix v3 run test:install-cleanup
    echo "🔁 install:global 默认入口走 V3-only: npm --prefix v3 run install"
    npm --prefix v3 run install
    node scripts/ensure-cli-command-shim.mjs
    node scripts/ensure-cli-executable.mjs
    verify_direct_v3_install
    restart_managed_dev_server_if_requested
    node scripts/cleanup-stale-server-pids.mjs --quiet
    echo "🎉 V3-only 全局安装完成: rcc -> rccv3"
}

cleanup_retired_v2_install() {
    local retired_install="$HOME/.rcc/install"
    if [ -e "$retired_install" ]; then
        echo "🧹 移除已退役 V2 install tree: $retired_install"
        rm -rf "$retired_install"
    fi
    if [ -e "$retired_install" ]; then
        echo "❌ 退役 V2 install tree 清理失败: $retired_install"
        exit 1
    fi
}

# 主函数
main() {
    run_default_v3_install
}

main "$@"

