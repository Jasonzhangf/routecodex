#!/bin/bash

# RouteCodex 快速构建和安装脚本
# 支持安装 routecodex 和 rcc 命令
set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 日志函数
log_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

log_header() {
    echo -e "${CYAN}$1${NC}"
}

# 检查系统要求
check_requirements() {
    log_header "🔍 检查系统要求"

    if ! command -v node &> /dev/null; then
        log_error "请先安装 Node.js (版本 >= 18.0.0)"
        exit 1
    fi

    if ! command -v npm &> /dev/null; then
        log_error "请先安装 npm"
        exit 1
    fi

    NODE_VERSION=$(node -v | cut -d'v' -f2)
    REQUIRED_NODE_VERSION="18.0.0"

    # 简单版本比较
    if ! node -e "const v='$NODE_VERSION'.split('.').map(Number); const r='$REQUIRED_NODE_VERSION'.split('.').map(Number);
    for(let i=0;i<Math.max(v.length,r.length);i++) {
      const a=v[i]||0, b=r[i]||0;
      if(a>b) process.exit(0);
      if(a<b) process.exit(1);
    } process.exit(0);" 2>/dev/null; then
        log_error "Node.js 版本过低，当前版本: $NODE_VERSION，要求版本: >= $REQUIRED_NODE_VERSION"
        exit 1
    fi

    log_success "系统要求检查通过 (Node.js $NODE_VERSION)"
}

# 清理旧文件
cleanup_old() {
    log_header "🧹 清理旧文件"

    # 进入项目根目录
    cd "$(dirname "$0")/.."

    log_info "清理构建目录..."
    rm -rf dist
    rm -f routecodex-*.tgz
    rm -f *.tar.gz

    log_success "清理完成"
}

# 安装依赖
install_dependencies() {
    log_header "📦 安装项目依赖"

    log_info "安装 npm 依赖..."
    if npm ci --prefer-offline --no-audit 2>/dev/null; then
        log_success "依赖安装成功"
    else
        log_warning "npm ci 失败，尝试 npm install"
        npm install
    fi
}

# 构建项目
build_project() {
    log_header "🔨 构建 TypeScript 项目"

    # 清理构建目录
    npm run clean 2>/dev/null || rm -rf dist

    # 构建项目
    log_info "编译 TypeScript..."
    if npm run build; then
        log_success "项目构建成功"
    else
        log_error "项目构建失败"
        exit 1
    fi

    # 确保CLI文件可执行
    if [ -f "dist/cli.js" ]; then
        chmod +x dist/cli.js
        log_success "设置 CLI 文件执行权限"
    fi
}

# 运行测试 (可选)
run_tests() {
    if [ "$SKIP_TESTS" = "true" ]; then
        log_info "跳过测试 (SKIP_TESTS=true)"
        return
    fi

    log_header "🧪 运行测试"

    if npm test 2>/dev/null; then
        log_success "测试通过"
    else
        log_warning "测试失败，但继续安装 (使用 --skip-tests 跳过测试)"
    fi
}

# 创建 npm 包
create_package() {
    log_header "📋 创建 npm 包"

    log_info "打包项目..."
    if npm pack; then
        PACKAGE_FILE=$(find . -maxdepth 1 -name "routecodex-*.tgz" -type f | head -1)
        if [ -z "$PACKAGE_FILE" ]; then
            log_error "包创建失败"
            exit 1
        fi
        PACKAGE_FILE=$(basename "$PACKAGE_FILE")
        log_success "包创建成功: $PACKAGE_FILE"
    else
        log_error "包创建失败"
        exit 1
    fi
}

# 卸载旧版本
uninstall_old() {
    log_header "🗑️ 卸载旧版本"

    # 检查并卸载 routecodex
    if npm list -g routecodex &> /dev/null; then
        log_info "卸载旧版本 routecodex..."
        npm uninstall -g routecodex
    fi

    # 检查并移除 rcc 命令 (如果存在)
    if command -v rcc &> /dev/null; then
        RCC_PATH=$(which rcc)
        log_info "发现现有 rcc 命令: $RCC_PATH"
        if [ -w "$(dirname "$RCC_PATH")" ]; then
            rm -f "$RCC_PATH"
            log_info "移除旧的 rcc 命令"
        else
            log_warning "无法移除 rcc 命令 (权限不足)"
        fi
    fi
}

# 安装新版本
install_new() {
    log_header "🔧 安装新版本"

    log_info "安装 routecodex 全局包..."
    if npm install -g "$PACKAGE_FILE"; then
        log_success "routecodex 安装成功"
    else
        log_error "routecodex 安装失败"
        exit 1
    fi

    # 创建 rcc 命令的符号链接
    create_rcc_alias
}

# 创建 rcc 别名
create_rcc_alias() {
    log_header "🔗 创建 rcc 命令别名"

    # 获取全局 bin 目录
    GLOBAL_BIN=$(npm config get prefix)/bin
    if [ ! -d "$GLOBAL_BIN" ]; then
        GLOBAL_BIN=$(npm root -g)/../bin
    fi

    if [ ! -d "$GLOBAL_BIN" ]; then
        log_warning "无法找到全局 bin 目录"
        return
    fi

    # 创建 rcc 符号链接到 routecodex
    RCC_PATH="$GLOBAL_BIN/rcc"
    ROUTECODEX_PATH="$GLOBAL_BIN/routecodex"

    if [ -f "$ROUTECODEX_PATH" ]; then
        try_create_link() {
            local method=$1
            case $method in
                "symlink")
                    ln -sf "$ROUTECODEX_PATH" "$RCC_PATH" 2>/dev/null
                    ;;
                "copy")
                    cp "$ROUTECODEX_PATH" "$RCC_PATH" 2>/dev/null
                    ;;
                "script")
                    cat > "$RCC_PATH" << 'EOF'
#!/bin/bash
exec routecodex "$@"
EOF
                    chmod +x "$RCC_PATH" 2>/dev/null
                    ;;
            esac
        }

        # 尝试不同的方法创建 rcc 命令
        for method in symlink copy script; do
            if try_create_link "$method" && [ -f "$RCC_PATH" ]; then
                log_success "rcc 命令创建成功 ($method)"
                return
            fi
        done

        log_warning "无法创建 rcc 命令，您可以直接使用 routecodex 命令"
    else
        log_warning "routecodex 命令未找到，无法创建 rcc 别名"
    fi
}

# 验证安装
verify_installation() {
    log_header "🔍 验证安装"

    # 等待系统刷新
    sleep 2

    # 更新 PATH (如果需要)
    export PATH="$PATH:$(npm config get prefix)/bin"

    # 验证 routecodex 命令
    if command -v routecodex &> /dev/null; then
        VERSION=$(routecodex --version 2>/dev/null || echo "unknown")
        log_success "routecodex $VERSION 安装成功"
    else
        log_error "routecodex 命令不可用"
        return 1
    fi

    # 验证 rcc 命令
    if command -v rcc &> /dev/null; then
        RCC_VERSION=$(rcc --version 2>/dev/null || echo "unknown")
        log_success "rcc $RCC_VERSION 别名创建成功"
    else
        log_warning "rcc 命令不可用，但 routecodex 命令工作正常"
    fi

    # 运行时就绪验证移除：不在安装阶段拉起服务，避免 120s 看门狗误杀
    log_header "🧪 跳过运行时就绪验证"
    log_info "已跳过自动启动与超时看门狗；请用 'npm run start:bg' 或 'npm run start:fg' 手动启动。"
}

# 清理临时文件
cleanup_temp() {
    log_header "🧹 清理临时文件"

    if [ -n "$PACKAGE_FILE" ] && [ -f "$PACKAGE_FILE" ]; then
        rm -f "$PACKAGE_FILE"
        log_info "删除临时包文件: $PACKAGE_FILE"
    fi

    log_success "清理完成"
}

# 显示使用说明
show_usage() {
    log_header "🎯 安装完成！使用说明"
    echo
    echo -e "${CYAN}基本命令:${NC}"
    echo -e "  ${GREEN}routecodex start${NC}         - 启动 RouteCodex 服务器"
    echo -e "  ${GREEN}rcc start${NC}                - 启动 RouteCodex 服务器 (别名)"
    echo -e "  ${GREEN}routecodex config init${NC}   - 初始化配置"
    echo -e "  ${GREEN}rcc config init${NC}          - 初始化配置 (别名)"
    echo -e "  ${GREEN}routecodex --help${NC}        - 查看帮助"
    echo -e "  ${GREEN}rcc --help${NC}               - 查看帮助 (别名)"
    echo
    echo -e "${CYAN}快速开始:${NC}"
    echo -e "  1. ${GREEN}rcc config init --template lmstudio${NC}  # 创建 LMStudio 配置"
    echo -e "  2. ${GREEN}rcc start${NC}                               # 启动服务器"
    echo -e "  3. 访问 ${YELLOW}http://localhost:5506${NC} 测试"
    echo
    echo -e "${CYAN}配置文件位置:${NC}"
    echo -e "  ~/.routecodex/config.json"
    echo
    echo -e "${CYAN}更多帮助:${NC}"
    echo -e "  ${GREEN}routecodex examples${NC}     - 查看使用示例"
    echo -e "  ${GREEN}rcc examples${NC}            - 查看使用示例 (别名)"
    echo
    if command -v rcc &> /dev/null; then
        echo -e "${GREEN}✅ routecodex 和 rcc 命令都已安装并可用！${NC}"
    else
        echo -e "${YELLOW}⚠️  routecodex 命令已安装，rcc 命令不可用${NC}"
        echo -e "${YELLOW}    您可以直接使用 routecodex 命令${NC}"
    fi
}

# 主函数
main() {
    log_header "🚀 RouteCodex 快速构建和安装脚本"
    echo -e "${CYAN}支持安装 routecodex 和 rcc 命令${NC}"
    echo

    # 解析命令行参数
    SKIP_TESTS="false"
    BUILD_ONLY="false"

    while [[ $# -gt 0 ]]; do
        case $1 in
            --skip-tests)
                SKIP_TESTS="true"
                shift
                ;;
            --build-only)
                BUILD_ONLY="true"
                shift
                ;;
            --help|-h)
                echo "用法: $0 [选项]"
                echo
                echo "选项:"
                echo "  --skip-tests    跳过测试"
                echo "  --build-only    仅构建，不安装"
                echo "  --help, -h      显示帮助"
                echo
                exit 0
                ;;
            *)
                log_error "未知参数: $1"
                echo "使用 --help 查看帮助"
                exit 1
                ;;
        esac
    done

    # 执行安装步骤
    check_requirements
    cleanup_old
    install_dependencies
    build_project

    if [ "$BUILD_ONLY" = "false" ]; then
        run_tests
        create_package
        uninstall_old
        install_new
        verify_installation
        cleanup_temp
        show_usage
    else
        log_success "构建完成！使用 npm run install:global 进行安装"
    fi
}

# 错误处理
trap 'log_error "脚本执行失败，退出码: $?"' ERR

# 运行主函数
main "$@"
