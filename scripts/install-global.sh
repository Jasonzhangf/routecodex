#!/bin/bash

set -euo pipefail

echo "🌍 全局安装 routecodex..."

SOURCE_ROOT="$(pwd -P)"
INSTALL_BUILD_ROOT=""
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

check_tmux() {
    if command -v tmux &> /dev/null; then
        echo "✅ tmux: $(tmux -V 2>/dev/null || echo tmux)"
        return
    fi

    echo "❌ tmux 未安装"
    echo "💡 RouteCodex 的 tmux 会话管理 / 注入 / heartbeat 依赖 tmux"
    echo "💡 请先安装 tmux 后再执行全局安装，例如："
    echo "   macOS(Homebrew): brew install tmux"
    echo "   Ubuntu/Debian: apt-get install -y tmux"
    echo "   CentOS/RHEL: yum install -y tmux"
    exit 1
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

    INSTALL_BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/routecodex-install-build.XXXXXX")"
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

    copy_v3_source() {
        local relative="v3"
        local source_path="$SOURCE_ROOT/$relative"
        local target_path="$INSTALL_BUILD_ROOT/$relative"
        if [ ! -d "$source_path" ]; then
            return
        fi
        mkdir -p "$(dirname "$target_path")"
        mkdir -p "$target_path"
        if command -v rsync >/dev/null 2>&1; then
            rsync -a --delete \
                --exclude '/target' \
                --exclude '/node_modules' \
                --exclude '/dist' \
                --exclude '/coverage' \
                --exclude '/test-results' \
                "$source_path/" "$target_path/"
        else
            (cd "$source_path" && COPYFILE_DISABLE=1 tar \
                --exclude './target' \
                --exclude './node_modules' \
                --exclude './dist' \
                --exclude './coverage' \
                --exclude './test-results' \
                -cf - .) | (cd "$target_path" && tar -xf -)
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
        src scripts config configsamples docs tests webui vendor; do
        copy_isolated_path "$item"
    done
    copy_v3_source
    copy_isolated_path ".agents/skills/rcc-dev-skills"
    copy_agent_collab_contract
    copy_isolated_path "samples/mock-provider"
    copy_llmswitch_core

    if [ -d "$SOURCE_ROOT/node_modules" ]; then
        ln -s "$SOURCE_ROOT/node_modules" "$INSTALL_BUILD_ROOT/node_modules"
    fi
}

# 构建项目
build_project() {
    if [ "${ROUTECODEX_INSTALL_SKIP_BUILD:-0}" = "1" ]; then
        echo "🔨 使用 build:min 已通过审计的产物，跳过 install:global 内部构建"
        INSTALL_BUILD_ROOT="$SOURCE_ROOT"
        if [ ! -f "$INSTALL_BUILD_ROOT/dist/cli.js" ]; then
            echo "❌ 缺少 build:min 产物：dist/cli.js"
            echo "💡 先执行: npm run build:min"
            exit 1
        fi
        if [ ! -f "$INSTALL_BUILD_ROOT/dist/error-handling/route-error-hub.js" ]; then
            echo "❌ 缺少 build:min 产物：dist/error-handling/route-error-hub.js"
            echo "💡 先执行: npm run build:min"
            exit 1
        fi
        return
    fi

    prepare_isolated_build_root
    echo "🔁 install:global 默认入口走 build:min（直面审计 gate）"
    (
        cd "$INSTALL_BUILD_ROOT"
        BUILD_MODE=dev \
        ROUTECODEX_SKIP_AUTO_BUMP="${ROUTECODEX_SKIP_AUTO_BUMP:-1}" \
        BUILD_SKIP_AUTO_BUMP="${BUILD_SKIP_AUTO_BUMP:-1}" \
        ROUTECODEX_BUILD_RESTART_ONLY="${ROUTECODEX_BUILD_RESTART_ONLY:-1}" \
        ROUTECODEX_INSTALL_VERIFY_PORT="${ROUTECODEX_INSTALL_VERIFY_PORT:-5555}" \
        npm run build:native-hotpath
        BUILD_MODE=dev \
        ROUTECODEX_SKIP_AUTO_BUMP="${ROUTECODEX_SKIP_AUTO_BUMP:-1}" \
        BUILD_SKIP_AUTO_BUMP="${BUILD_SKIP_AUTO_BUMP:-1}" \
        ROUTECODEX_BUILD_RESTART_ONLY="${ROUTECODEX_BUILD_RESTART_ONLY:-1}" \
        ROUTECODEX_INSTALL_VERIFY_PORT="${ROUTECODEX_INSTALL_VERIFY_PORT:-5555}" \
        npm run build:min
    )
}

# 全局安装
global_install() {
    echo "🌍 执行全局安装..."

    # 先检查当前用户是否对npm prefix有写权限
    NPM_PREFIX=$(npm config get prefix)
    if [ ! -w "$NPM_PREFIX" ]; then
        echo "❌ 错误：对 $NPM_PREFIX 没有写入权限"
        echo "💡 解决方案（三选一）："
        echo "   1. 如果使用Homebrew，确保正确安装: brew install node"
        echo "   2. 设置用户级全局目录: npm config set prefix ~/.npm-global"
        echo "   3. 修复Homebrew权限: sudo chown -R $(whoami) $NPM_PREFIX"
        echo ""
        echo "🔧 尝试自动设置用户级全局目录..."
        USER_GLOBAL_DIR="$HOME/.npm-global"
        mkdir -p "$USER_GLOBAL_DIR/bin"
        npm config set prefix "$USER_GLOBAL_DIR"

        # 更新PATH提示
        if [[ ":$PATH:" != *":$USER_GLOBAL_DIR/bin:"* ]]; then
            echo "⚠️  请将 $USER_GLOBAL_DIR/bin 添加到 PATH:"
            echo "   echo 'export PATH=\"$USER_GLOBAL_DIR/bin:\$PATH\"' >> ~/.zshrc"
            echo "   source ~/.zshrc"
        fi
    fi

    # 依赖隔离 build root 中已完成的 dist；使用 release pack 真源，把 production deps
    # bundle 进 tarball，避免全局安装阶段联网解析依赖或和 release shim 生命周期互相打架。
    (cd "$INSTALL_BUILD_ROOT" && RCC_LLMS_INLINE_LOCAL=1 node scripts/pack-mode.mjs --name routecodex --bin routecodex)
    local packed_path="$INSTALL_BUILD_ROOT/artifacts/pack/routecodex-$(node -p "require('$INSTALL_BUILD_ROOT/package.json').version").tgz"
    if [ ! -f "$packed_path" ]; then
        echo "❌ 全局安装失败：release pack 未生成 tarball: $packed_path"
        exit 1
    fi
    # The release shim may predate this install, but no concurrent installer can recreate it after this point.
    rm -f "$NPM_PREFIX/bin/routecodex" "$NPM_PREFIX/bin/routecodex-v3"
    npm install -g "$packed_path" --no-audit --no-fund --omit=optional --ignore-scripts --offline --progress=false --loglevel=warn

    # 全局安装后再次修复可执行位（解决偶发 permission denied）
    node "$INSTALL_BUILD_ROOT/scripts/ensure-cli-executable.mjs" || true
    ROUTECODEX_SHIM_PREFER_RELEASE_SNAPSHOT=1 node "$SOURCE_ROOT/scripts/ensure-cli-command-shim.mjs" || true

    if [ $? -eq 0 ]; then
        echo "✅ 全局安装成功"
    else
        echo "❌ 全局安装失败"
        exit 1
    fi
}

link_global_llms_dev() {
    echo "🔗 链接全局 rcc-llmswitch-core 到本地 sharedmodule (dev 模式)..."
    node scripts/link-global-llms-local.mjs --package routecodex --require-target --skip-install-current
}

refresh_rcc_install_current_snapshots() {
    echo "📦 刷新 RCC install/current runtime snapshot..."
    local roots=()
    if [ -n "${RCC_HOME:-}" ]; then
        roots+=("$RCC_HOME")
    fi
    if [ -n "${ROUTECODEX_HOME:-}" ]; then
        roots+=("$ROUTECODEX_HOME")
    fi
    if [ -n "${ROUTECODEX_USER_DIR:-}" ]; then
        roots+=("$ROUTECODEX_USER_DIR")
    fi
    roots+=("$HOME/.rcc")
    if [ -d "/Volumes/extension/.rcc" ]; then
        roots+=("/Volumes/extension/.rcc")
    fi

    local seen=""
    local refreshed=0
    for root in "${roots[@]}"; do
        if [ -z "$root" ]; then
            continue
        fi
        case "$root" in
            ~/*) root="$HOME/${root#~/}" ;;
        esac
        root="$(cd "$(dirname "$root")" 2>/dev/null && pwd)/$(basename "$root")"
        case " $seen " in
            *" $root "*) continue ;;
        esac
        seen="$seen $root"
        mkdir -p "$root"
        echo "   -> $root"
        (cd "$INSTALL_BUILD_ROOT" && RCC_HOME="$root" ROUTECODEX_HOME="$root" ROUTECODEX_USER_DIR="$root" node scripts/install-release-snapshot.mjs)
        refreshed=$((refreshed + 1))
    done
    if [ "$refreshed" -eq 0 ]; then
        echo "⚠️  未找到可刷新的 RCC home"
    fi
}

# 验证安装
verify_install() {
    echo "🔍 验证全局安装..."
    if command -v routecodex &> /dev/null; then
        echo "✅ routecodex 已全局安装"
        ROUTECODEX_SHIM_PREFER_RELEASE_SNAPSHOT=1 node scripts/ensure-cli-command-shim.mjs || true
        routecodex --version
        if ! command -v routecodex-v3 >/dev/null 2>&1; then
            echo "❌ 全局安装失败（未找到 routecodex-v3 命令）"
            exit 1
        fi
        routecodex-v3 --help >/dev/null
        node -e "const path=require('path');const cp=require('child_process');const root=cp.execSync('npm root -g').toString().trim();const pkg=path.join(root,'routecodex','node_modules','rcc-llmswitch-core','package.json');const fs=require('fs');if(fs.existsSync(pkg)){const v=require(pkg).version;console.log('🔎 全局 rcc-llmswitch-core 版本:',v);}else{console.log('⚠️  未找到全局 rcc-llmswitch-core package.json');}"
    else
        echo "❌ 全局安装失败（未找到 routecodex 命令）"
        exit 1
    fi
}


restart_managed_dev_server_if_requested() {
    local restart_only="${ROUTECODEX_BUILD_RESTART_ONLY:-${RCC_BUILD_RESTART_ONLY:-0}}"
    if [ "$restart_only" != "1" ] && [ "$restart_only" != "true" ]; then
        return
    fi

    local restart_port="${ROUTECODEX_DEV_RESTART_PORT:-${RCC_DEV_RESTART_PORT:-5555}}"
    echo ""
    echo "🔄 尝试通过服务端 restart 入口刷新现有 RouteCodex 服务 (port=${restart_port})..."
    if routecodex restart --port "$restart_port"; then
        echo "✅ 受管服务已重启: ${restart_port}"
        return
    fi
    echo "⚠ ${restart_port} 自动重启未完成；全局安装已完成，但运行中的服务可能尚未刷新到最新构建。"
    echo "ℹ 请根据上方 routecodex restart 日志继续处理；当前 CLI 已支持 HTTP restart 与 legacy signal restart。"
}

# 清理旧安装
cleanup_old_install() {
    echo "🧹 检查并清理旧安装..."

    NPM_PREFIX=$(npm config get prefix)
    GLOBAL_NODE_MODULES=$(npm root -g 2>/dev/null || true)
    if [ -z "${GLOBAL_NODE_MODULES:-}" ]; then
      GLOBAL_NODE_MODULES="$NPM_PREFIX/lib/node_modules"
    fi

    # 清理旧的符号链接
    if [ -L "$GLOBAL_NODE_MODULES/routecodex" ]; then
        echo "🗑️  删除旧的routecodex链接..."
        rm -f "$GLOBAL_NODE_MODULES/routecodex"
    fi

    # 清理旧的可执行文件
    if [ -e "$NPM_PREFIX/bin/routecodex" ]; then
        echo "🗑️  删除旧的routecodex可执行文件..."
        rm -f "$NPM_PREFIX/bin/routecodex"
    fi

    # 清理异常生成的本地配置目录（历史脚本bug）
    if [ -d "$HOME/.routecodexundefined" ]; then
        echo "🗑️  移除异常目录 ~/.routecodexundefined ..."
        rm -rf "$HOME/.routecodexundefined" || true
    fi

    echo "✅ 清理完成"
}

# 主函数
main() {
    check_node
    check_tmux
    cleanup_old_install
    node scripts/cleanup-stale-server-pids.mjs --quiet || true
    build_project
    global_install
    refresh_rcc_install_current_snapshots
    link_global_llms_dev
    verify_install
    restart_managed_dev_server_if_requested
    node scripts/cleanup-stale-server-pids.mjs --quiet || true

    echo ""
    echo "🎉 全局安装完成!"
    echo ""
    echo "使用方法:"
    echo "  routecodex         # 全局 CLI 命令（dev 包）"
    echo ""

    # 如果有权限问题，给出提示
    NPM_CACHE=$(npm config get cache)
    if find "$NPM_CACHE" -not -user $(whoami) -print -quit | grep -q . 2>/dev/null; then
        echo "⚠️  注意：npm缓存存在权限问题，可能影响后续使用"
        echo "💡 建议运行: sudo chown -R \$(id -u):\$(id -g) \"$NPM_CACHE\""
        echo ""
    fi
}

main "$@"
