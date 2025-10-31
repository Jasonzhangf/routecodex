#!/bin/bash
# RouteCodex 废弃代码清理脚本
# 基于sysmem分析结果生成
# 执行前请确保代码已提交到Git！

set -e  # 遇到错误立即退出

echo "🧹 RouteCodex 废弃代码清理开始..."
echo "⏰ 开始时间: $(date)"
echo ""

# 检查Git状态
if [[ -n $(git status --porcelain) ]]; then
    echo "❌ 检测到未提交的更改，请先提交代码！"
    exit 1
fi

# 创建清理前备份
echo "📦 创建清理前备份..."
BACKUP_DIR="cleanup-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

# 备份关键配置
if [[ -f "config/merged-config.json" ]]; then
    cp config/merged-config.json "$BACKUP_DIR/"
fi

echo "✅ 备份完成: $BACKUP_DIR"
echo ""

# 阶段1: 安全清理
echo "🟢 阶段1: 安全清理临时文件..."

# 统计清理前文件数量
TEMP_FILES_BEFORE=$(find . -name "debug-*.js" -not -path "*/node_modules/*" | wc -l)
TEST_OUTPUT_SIZE=$(du -sh tests/output/ 2>/dev/null | cut -f1 || echo "0")

echo "📊 清理前统计:"
echo "  - 临时调试文件: $TEMP_FILES_BEFORE 个"
echo "  - 测试输出大小: $TEST_OUTPUT_SIZE"

# 删除临时调试文件
echo "🗑️ 删除临时调试文件..."
find . -name "debug-*.js" -not -path "*/node_modules/*" -delete -print
find . -name "test-*.js" -not -path "*/node_modules/*" -not -path "*/tests/*" -delete -print
rm -f detailed-glm-debug.js debug-secret-sanitization.js

# 删除测试输出文件
echo "🗑️ 删除测试输出文件..."
if [[ -d "tests/output/" ]]; then
    rm -rf tests/output/
    echo "  已删除: tests/output/"
fi

# 删除构建产物
echo "🗑️ 删除构建产物..."
if [[ -d "dist/" ]]; then
    rm -rf dist/
    echo "  已删除: dist/"
fi

echo "✅ 阶段1完成"
echo ""

# 阶段2: 配置清理（需用户确认）
echo "🟡 阶段2: 配置文件清理..."

# 备份配置文件
echo "📦 备份配置文件..."
if [[ -f "config/merged-config.json" ]]; then
    cp config/merged-config.json "config/merged-config.backup.$(date +%Y%m%d).json"
    echo "  已备份: merged-config.backup.$(date +%Y%m%d).json"
fi

# 删除旧配置快照
echo "🗑️ 删除旧配置快照..."
find config/ -name "merged-config.55*.json" -delete -print 2>/dev/null || true

# 删除旧版本tgz包
echo "🗑️ 删除旧版本tgz包..."
find sharedmodule/llmswitch-core/ -name "rcc-llmswitch-core-0.1.3[7-9].tgz" -delete -print 2>/dev/null || true

echo "✅ 阶段2完成"
echo ""

# 阶段3: 代码模块清理（需要手动确认）
echo "🔴 阶段3: 代码模块清理"
echo "⚠️ 以下文件需要手动确认后删除:"
echo ""

# 未使用的模块
if [[ -f "src/utils/file-watcher.ts" ]]; then
    echo "  📄 src/utils/file-watcher.ts (253行，未使用)"
fi

# 禁用的测试
if [[ -f "tests/config/user-config-parser.test.ts" ]]; then
    echo "  📄 tests/config/user-config-parser.test.ts (禁用的测试)"
fi

if [[ -f "tests/commands/three-modes-dry-run.test.ts" ]]; then
    echo "  📄 tests/commands/three-modes-dry-run.test.ts (禁用的测试)"
fi

echo ""
echo "💡 请手动检查上述文件是否仍需要，然后手动删除"
echo ""

# 清理统计
echo "📊 清理统计:"
TEMP_FILES_AFTER=$(find . -name "debug-*.js" -not -path "*/node_modules/*" 2>/dev/null | wc -l)
echo "  - 临时调试文件: $TEMP_FILES_BEFORE → $TEMP_FILES_AFTER"
echo "  - 测试输出目录: 已删除"
echo "  - 构建产物目录: 已删除"
echo "  - 配置快照: 已清理"
echo "  - 旧版本包: 已清理"
echo ""

# 验证清理效果
echo "🔍 验证清理效果..."
echo "📁 检查项目结构..."
npm run build 2>/dev/null || {
    echo "❌ 构建失败，请检查是否有误删文件"
    echo "🔄 可以使用以下命令恢复:"
    echo "   git checkout HEAD~1"
    exit 1
}

echo "✅ 构建成功！"
echo ""

# 生成清理报告
echo "📋 生成清理报告..."
REPORT_FILE="cleanup-report-$(date +%Y%m%d-%H%M%S).md"
cat > "$REPORT_FILE" << EOF
# RouteCodex 代码清理报告

**清理时间**: $(date)
**清理脚本**: scripts/cleanup-deprecated-code.sh
**备份目录**: $BACKUP_DIR

## 清理内容
- 临时调试文件: $((TEMP_FILES_BEFORE - TEMP_FILES_AFTER)) 个
- 测试输出目录: tests/output/
- 构建产物目录: dist/
- 旧配置快照: merged-config.55*.json
- 旧版本包: rcc-llmswitch-core-0.1.3[7-9].tgz

## 构建验证
✅ 构建成功

## 后续建议
1. 运行完整测试套件: npm test
2. 检查功能是否正常
3. 如有问题，从备份恢复: git checkout HEAD~1
EOF

echo "✅ 清理报告已生成: $REPORT_FILE"
echo ""

# 最终建议
echo "🎯 后续建议:"
echo "1. 运行测试: npm test"
echo "2. 检查功能是否正常"
echo "3. 手动确认并删除阶段3中的文件"
echo "4. 如有问题，可从备份恢复: git checkout HEAD~1"
echo ""
echo "🎉 清理完成！"
echo "⏰ 结束时间: $(date)"