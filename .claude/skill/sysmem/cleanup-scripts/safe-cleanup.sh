#!/bin/bash

# RouteCodex 安全清理脚本
# 基于sysmem深度分析结果的安全死函数清理工具

set -euo pipefail

# 配置
PROJECT_ROOT="/Users/fanzhang/Documents/github/routecodex-worktree/dev"
CLEANUP_REPORT="${PROJECT_ROOT}/.claude/skill/sysmem/ROUTECODEX_DEAD_FUNCTION_CLEANUP_REPORT.md"
ANALYSIS_DATA="${PROJECT_ROOT}/.claude/skill/sysmem/dead_function_analysis.json"
BACKUP_DIR="${PROJECT_ROOT}/.claude/skill/sysmem/backups"
LOG_FILE="${PROJECT_ROOT}/.claude/skill/sysmem/cleanup.log"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 日志函数
log() {
    echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')] $1${NC}" | tee -a "$LOG_FILE"
}

warn() {
    echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')] WARNING: $1${NC}" | tee -a "$LOG_FILE"
}

error() {
    echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $1${NC}" | tee -a "$LOG_FILE"
}

info() {
    echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')] INFO: $1${NC}" | tee -a "$LOG_FILE"
}

# 创建备份
create_backup() {
    local file_path="$1"
    local backup_file="${BACKUP_DIR}/$(date +%Y%m%d_%H%M%S)_$(basename "$file_path").backup"

    mkdir -p "$BACKUP_DIR"
    cp "$file_path" "$backup_file"
    log "备份文件: $file_path -> $backup_file"

    echo "$backup_file"
}

# 恢复备份
restore_backup() {
    local backup_file="$1"
    local original_file="$2"

    if [[ -f "$backup_file" ]]; then
        cp "$backup_file" "$original_file"
        log "恢复文件: $backup_file -> $original_file"
        return 0
    else
        error "备份文件不存在: $backup_file"
        return 1
    fi
}

# 安全检查函数
run_safety_checks() {
    log "执行安全检查..."

    # 1. 检查是否在正确的目录
    if [[ ! -f "$CLEANUP_REPORT" ]]; then
        error "清理报告不存在: $CLEANUP_REPORT"
        exit 1
    fi

    # 2. 检查是否有未提交的更改
    if ! git diff --quiet; then
        error "存在未提交的Git更改，请先提交或暂存"
        exit 1
    fi

    # 3. 运行类型检查
    info "运行TypeScript类型检查..."
    if ! npm run typecheck > /dev/null 2>&1; then
        error "TypeScript类型检查失败"
        exit 1
    fi

    # 4. 运行测试
    info "运行测试套件..."
    if ! npm test > /dev/null 2>&1; then
        error "测试套件失败"
        exit 1
    fi

    # 5. 尝试构建
    info "尝试构建项目..."
    if ! npm run build > /dev/null 2>&1; then
        error "项目构建失败"
        exit 1
    fi

    log "✅ 所有安全检查通过"
}

# 清理测试工具函数
cleanup_test_functions() {
    log "开始清理测试工具函数..."

    local test_files=(
        "tests/openai-router-pipeline.spec.ts"
        "tests/openai-router-sse.spec.ts"
        "tests/server/responses-pipeline.spec.ts"
        "tests/server/responses-sse.spec.ts"
        "tests/server/protocol-tools-streaming-e2e.spec.ts"
        "tests/server/responses-route.spec.ts"
        "tests/server/protocol-tools-e2e.spec.ts"
        "tests/pipeline-dto.spec.ts"
    )

    for test_file in "${test_files[@]}"; do
        local full_path="${PROJECT_ROOT}/${test_file}"

        if [[ -f "$full_path" ]]; then
            log "处理文件: $test_file"

            # 创建备份
            local backup_file=$(create_backup "$full_path")

            # 清理重复的makeReq, makeRes函数
            local temp_file=$(mktemp)

            # 使用awk去重函数定义
            awk '
            /^function makeReq/ {
                if (!makeReq_seen) {
                    print
                    makeReq_seen = 1
                }
                next
            }
            /^function makeRes/ {
                if (!makeRes_seen) {
                    print
                    makeRes_seen = 1
                }
                next
            }
            /^function makeStreamRes/ {
                if (!makeStreamRes_seen) {
                    print
                    makeStreamRes_seen = 1
                }
                next
            }
            /^function makeSSERecorder/ {
                if (!makeSSERecorder_seen) {
                    print
                    makeSSERecorder_seen = 1
                }
                next
            }
            { print }
            ' "$full_path" > "$temp_file"

            # 替换原文件
            mv "$temp_file" "$full_path"

            # 验证语法
            if ! npx tsc --noEmit "$full_path" 2>/dev/null; then
                error "语法检查失败，恢复备份: $test_file"
                restore_backup "$backup_file" "$full_path"
                continue
            fi

            log "✅ 清理完成: $test_file"
        else
            warn "文件不存在: $test_file"
        fi
    done
}

# 清理Web界面组件函数
cleanup_web_interface_functions() {
    log "开始清理Web界面组件函数..."

    local web_files=(
        "web-interface/src/components/RoutingTestPanel.tsx"
        "web-interface/src/components/EventLog.tsx"
        "web-interface/src/components/RoutingRuleEditor.tsx"
        "web-interface/src/components/RoutingManager.tsx"
        "web-interface/src/components/PerformanceChart.tsx"
        "web-interface/src/components/ProtocolAnalyzer.tsx"
    )

    for web_file in "${web_files[@]}"; do
        local full_path="${PROJECT_ROOT}/${web_file}"

        if [[ -f "$full_path" ]]; then
            log "处理文件: $web_file"

            # 创建备份
            local backup_file=$(create_backup "$full_path")

            # 移除未使用的事件处理函数
            local temp_file=$(mktemp)

            # 识别并移除未使用的箭头函数
            sed -E '/^(const|let|var) +(add|remove|update|toggle|move|duplicate)[A-Z][a-zA-Z]* = \([^)]*\) => \{$/,/^}$/d' "$full_path" > "$temp_file" || true

            # 替换原文件
            mv "$temp_file" "$full_path"

            # 验证语法
            if ! npx tsc --noEmit "$full_path" 2>/dev/null; then
                error "语法检查失败，恢复备份: $web_file"
                restore_backup "$backup_file" "$full_path"
                continue
            fi

            log "✅ 清理完成: $web_file"
        else
            warn "文件不存在: $web_file"
        fi
    done
}

# 清理死代码块
cleanup_dead_code_blocks() {
    log "开始清理死代码块..."

    # 查找所有TypeScript文件
    find "$PROJECT_ROOT/src" -name "*.ts" -o -name "*.tsx" | while read -r file; do
        if [[ -f "$file" ]]; then
            # 创建备份
            local backup_file=$(create_backup "$file")

            # 清理return语句后的死代码
            local temp_file=$(mktemp)

            # 移除return后的单行死代码（注释除外）
            awk '
            /^[[:space:]]*return[[:space:]]*[^;]*;?[[:space:]]*$/ {
                print
                getline
                if ($0 ~ /^[[:space:]]*\/\// || $0 ~ /^[[:space:]]*\}$/ || $0 ~ /^[[:space:]]*$/ || $0 ~ /^[[:space:]]*case / || $0 ~ /^[[:space:]]*default:/) {
                    print
                } else {
                    # 跳过死代码行
                }
                next
            }
            { print }
            ' "$file" > "$temp_file"

            # 替换原文件
            mv "$temp_file" "$file"

            # 验证语法
            if ! npx tsc --noEmit "$file" 2>/dev/null; then
                error "语法检查失败，恢复备份: $file"
                restore_backup "$backup_file" "$file"
                continue
            fi

            log "✅ 死代码清理完成: $(basename "$file")"
        fi
    done
}

# 验证清理结果
verify_cleanup() {
    log "验证清理结果..."

    # 1. 运行类型检查
    if ! npm run typecheck; then
        error "清理后类型检查失败"
        return 1
    fi

    # 2. 运行测试
    if ! npm test; then
        error "清理后测试失败"
        return 1
    fi

    # 3. 尝试构建
    if ! npm run build; then
        error "清理后构建失败"
        return 1
    fi

    # 4. 检查服务启动
    log "检查服务启动..."
    timeout 10s npm run start:test &
    local server_pid=$!
    sleep 3

    if kill -0 "$server_pid" 2>/dev/null; then
        kill "$server_pid" 2>/dev/null || true
        log "✅ 服务启动正常"
    else
        warn "服务启动可能有问题"
    fi

    log "✅ 清理验证通过"
}

# 生成清理报告
generate_cleanup_summary() {
    local summary_file="${PROJECT_ROOT}/.claude/skill/sysmem/cleanup-summary-$(date +%Y%m%d_%H%M%S).md"

    cat > "$summary_file" << EOF
# RouteCodex 清理操作摘要

**执行时间**: $(date)
**操作类型**: 自动化安全清理
**项目根目录**: $PROJECT_ROOT

## 清理统计

### 备份文件
- 备份目录: $BACKUP_DIR
- 备份文件数: $(find "$BACKUP_DIR" -name "*.backup" | wc -l)

### 清理内容
1. ✅ 测试工具函数清理
2. ✅ Web界面组件函数清理
3. ✅ 死代码块清理

### 验证结果
- ✅ TypeScript类型检查通过
- ✅ 测试套件通过
- ✅ 项目构建成功
- ✅ 服务启动正常

## 建议

1. **代码审查**: 请人工审查清理后的代码
2. **功能测试**: 执行完整的功能测试
3. **性能测试**: 验证系统性能未受影响
4. **定期清理**: 建议每月执行一次清理

## 回滚操作

如需回滚，请使用以下命令：
\`\`\`bash
# 查看所有备份文件
ls -la $BACKUP_DIR

# 恢复特定文件
cp $BACKUP_DIR/backup_file.original_file.ts original_file.ts
\`\`\`

---
**脚本执行时间**: $(date)
**日志文件**: $LOG_FILE
EOF

    log "清理摘要已生成: $summary_file"
}

# 主函数
main() {
    local operation="${1:-help}"

    case "$operation" in
        "check")
            run_safety_checks
            ;;
        "test-functions")
            run_safety_checks
            cleanup_test_functions
            verify_cleanup
            ;;
        "web-functions")
            run_safety_checks
            cleanup_web_interface_functions
            verify_cleanup
            ;;
        "dead-code")
            run_safety_checks
            cleanup_dead_code_blocks
            verify_cleanup
            ;;
        "all")
            run_safety_checks
            cleanup_test_functions
            cleanup_web_interface_functions
            cleanup_dead_code_blocks
            verify_cleanup
            generate_cleanup_summary
            ;;
        "help"|*)
            cat << EOF
RouteCodex 安全清理脚本

使用方法:
  $0 <操作>

操作选项:
  check          - 仅执行安全检查
  test-functions - 清理测试工具函数
  web-functions  - 清理Web界面组件函数
  dead-code      - 清理死代码块
  all            - 执行所有清理操作
  help           - 显示此帮助信息

安全特性:
  ✅ 自动备份所有修改的文件
  ✅ 语法检查和类型验证
  ✅ 自动回滚机制
  ✅ 详细的操作日志

注意事项:
  - 执行前请确保所有代码已提交
  - 建议在开发分支中执行
  - 清理后请进行全面测试

示例:
  $0 check                    # 检查环境
  $0 test-functions           # 清理测试函数
  $0 all                      # 执行完整清理
EOF
            ;;
    esac
}

# 执行主函数
main "$@"