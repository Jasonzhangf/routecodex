#!/bin/bash

# RouteCodex Auto Build and Install Script
# 自动构建并全局安装脚本

set -e  # 遇到错误立即退出

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 日志函数
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# 检查Node.js和npm
check_prerequisites() {
    log_info "检查前置条件..."

    if ! command -v node &> /dev/null; then
        log_error "Node.js 未安装，请先安装 Node.js"
        exit 1
    fi

    if ! command -v npm &> /dev/null; then
        log_error "npm 未安装，请先安装 npm"
        exit 1
    fi

    log_success "前置条件检查通过"
}

# 清理旧的构建文件
clean_old_build() {
    log_info "清理旧的构建文件..."

    if [ -d "dist" ]; then
        rm -rf dist
        log_info "已清理 dist 目录"
    fi

    if [ -f "routecodex-*.tgz" ]; then
        rm -f routecodex-*.tgz
        log_info "已清理旧的 tarball 文件"
    fi
}

# 运行测试（可选）
run_tests() {
    if [ "$1" = "--skip-tests" ]; then
        log_warning "跳过测试"
        return
    fi

    log_info "运行测试..."
    if npm test > /dev/null 2>&1; then
        log_success "测试通过"
    else
        log_warning "测试失败，但继续构建..."
    fi
}

# 构建项目
build_project() {
    log_info "开始构建项目..."

    # 安装依赖
    log_info "安装依赖..."
    npm install > /dev/null 2>&1

    # 构建项目
    log_info "编译 TypeScript..."
    if npm run build > /dev/null 2>&1; then
        log_success "项目构建成功"
    else
        log_error "项目构建失败"
        exit 1
    fi
}

# 创建包
create_package() {
    echo "[INFO] 创建 npm 包..."

    # 临时重定向标准输出，避免颜色代码干扰
    if npm pack > /dev/null 2>&1; then
        # 使用更安全的方法获取文件名
        local package_file=$(find . -maxdepth 1 -name "routecodex-*.tgz" -type f | head -1)
        if [ -n "$package_file" ]; then
            # 只返回文件名，不包含路径
            package_file=$(basename "$package_file")
            echo "[SUCCESS] 包创建成功: $package_file"
            echo "$package_file"
        else
            echo "[ERROR] 无法找到创建的包文件"
            exit 1
        fi
    else
        echo "[ERROR] 包创建失败"
        exit 1
    fi
}

# 卸载旧版本
uninstall_old_version() {
    log_info "检查并卸载旧版本..."

    if npm list -g routecodex > /dev/null 2>&1; then
        log_info "发现旧版本，正在卸载..."
        if npm uninstall -g routecodex > /dev/null 2>&1; then
            log_success "旧版本卸载成功"
        else
            log_warning "旧版本卸载失败"
        fi
    else
        log_info "未发现旧版本"
    fi
}

# 安装新版本
install_new_version() {
    local package_file=$1
    log_info "安装新版本..."

    # 尝试安装并捕获错误
    if npm install -g "$package_file" > install.log 2>&1; then
        log_success "新版本安装成功"
        rm -f install.log
    else
        log_error "新版本安装失败"
        echo "错误详情:"
        cat install.log
        rm -f install.log
        exit 1
    fi
}

# 验证安装
verify_installation() {
    log_info "验证安装..."

    # 等待一下让npm完成安装
    sleep 2

    if routecodex --version &> /dev/null; then
        local version=$(routecodex --version)
        log_success "RouteCodex 安装成功，版本: $version"

        # 测试基本命令
        log_info "测试基本命令..."
        if routecodex --help &> /dev/null; then
            log_success "CLI 命令正常工作"
        fi

        if routecodex examples &> /dev/null; then
            log_success "示例命令正常工作"
        fi
    else
        log_error "RouteCodex 安装验证失败"
        exit 1
    fi
}

# 清理临时文件
cleanup() {
    log_info "清理临时文件..."

    if [ -f "routecodex-*.tgz" ]; then
        rm -f routecodex-*.tgz
        log_info "已清理 tarball 文件"
    fi
}

# 显示使用信息
show_usage() {
    cat << EOF
RouteCodex 自动构建和安装脚本

用法: $0 [选项]

选项:
    --skip-tests    跳过测试
    --help, -h      显示帮助信息
    --verbose, -v   详细输出

示例:
    $0              # 完整构建和安装
    $0 --skip-tests # 跳过测试的构建和安装
    $0 --help       # 显示帮助
EOF
}

# 主函数
main() {
    local skip_tests=false

    # 解析参数
    while [[ $# -gt 0 ]]; do
        case $1 in
            --skip-tests)
                skip_tests=true
                shift
                ;;
            --help|-h)
                show_usage
                exit 0
                ;;
            --verbose|-v)
                set -x  # 启用详细输出
                shift
                ;;
            *)
                log_error "未知参数: $1"
                show_usage
                exit 1
                ;;
        esac
    done

    log_info "开始 RouteCodex 自动构建和安装流程..."
    echo "========================================"

    # 执行构建流程
    check_prerequisites
    clean_old_build

    if [ "$skip_tests" = true ]; then
        run_tests --skip-tests
    else
        run_tests
    fi

    build_project

    local package_file=$(create_package)
    uninstall_old_version
    install_new_version "$package_file"
    verify_installation
    cleanup

    echo "========================================"
    log_success "RouteCodex 构建和安装完成！"

    # 显示使用提示
    echo ""
    log_info "快速开始："
    echo "  查看帮助:    routecodex --help"
    echo "  查看示例:    routecodex examples"
    echo "  初始化配置:  routecodex config init"
    echo "  启动服务器:  routecodex start"
    echo ""
}

# 捕获错误
trap 'log_error "脚本执行失败，请检查错误信息"' ERR

# 运行主函数
main "$@"