#!/bin/bash
# RouteCodex 低风险废弃函数清理脚本
# 自动生成 - 仅清理低风险函数

set -e

echo '🧹 开始清理低风险废弃函数...'
echo '📊 将清理 61 个低风险函数'

BACKUP_DIR="cleanup-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
echo "📦 备份目录: $BACKUP_DIR"

echo '🗑️ 清理函数: import (tests/e2e-glm-real.spec.ts:15)'
if [[ -f 'tests/e2e-glm-real.spec.ts' ]]; then
  cp 'tests/e2e-glm-real.spec.ts' "$BACKUP_DIR/$(basename tests/e2e-glm-real.spec.ts).backup"
  echo '  ✅ 已备份: $(basename tests/e2e-glm-real.spec.ts)'
  # TODO: 实现精确的函数删除逻辑
  echo '  ⚠️ 需要手动删除函数定义'
else
  echo '  ❌ 文件不存在: tests/e2e-glm-real.spec.ts'
fi

echo '🗑️ 清理函数: import (tests/e2e-glm-real.spec.ts:16)'
if [[ -f 'tests/e2e-glm-real.spec.ts' ]]; then
  cp 'tests/e2e-glm-real.spec.ts' "$BACKUP_DIR/$(basename tests/e2e-glm-real.spec.ts).backup"
  echo '  ✅ 已备份: $(basename tests/e2e-glm-real.spec.ts)'
  # TODO: 实现精确的函数删除逻辑
  echo '  ⚠️ 需要手动删除函数定义'
else
  echo '  ❌ 文件不存在: tests/e2e-glm-real.spec.ts'
fi

echo '🗑️ 清理函数: import (tests/e2e-glm-real.spec.ts:17)'
if [[ -f 'tests/e2e-glm-real.spec.ts' ]]; then
  cp 'tests/e2e-glm-real.spec.ts' "$BACKUP_DIR/$(basename tests/e2e-glm-real.spec.ts).backup"
  echo '  ✅ 已备份: $(basename tests/e2e-glm-real.spec.ts)'
  # TODO: 实现精确的函数删除逻辑
  echo '  ⚠️ 需要手动删除函数定义'
else
  echo '  ❌ 文件不存在: tests/e2e-glm-real.spec.ts'
fi

echo '🗑️ 清理函数: pm (tests/server/protocol-tools-streaming-e2e.spec.ts:77)'
if [[ -f 'tests/server/protocol-tools-streaming-e2e.spec.ts' ]]; then
  cp 'tests/server/protocol-tools-streaming-e2e.spec.ts' "$BACKUP_DIR/$(basename tests/server/protocol-tools-streaming-e2e.spec.ts).backup"
  echo '  ✅ 已备份: $(basename tests/server/protocol-tools-streaming-e2e.spec.ts)'
  # TODO: 实现精确的函数删除逻辑
  echo '  ⚠️ 需要手动删除函数定义'
else
  echo '  ❌ 文件不存在: tests/server/protocol-tools-streaming-e2e.spec.ts'
fi

echo '🗑️ 清理函数: hasAssistantToolCall (tests/server/protocol-tools-streaming-e2e.spec.ts:101)'
if [[ -f 'tests/server/protocol-tools-streaming-e2e.spec.ts' ]]; then
  cp 'tests/server/protocol-tools-streaming-e2e.spec.ts' "$BACKUP_DIR/$(basename tests/server/protocol-tools-streaming-e2e.spec.ts).backup"
  echo '  ✅ 已备份: $(basename tests/server/protocol-tools-streaming-e2e.spec.ts)'
  # TODO: 实现精确的函数删除逻辑
  echo '  ⚠️ 需要手动删除函数定义'
else
  echo '  ❌ 文件不存在: tests/server/protocol-tools-streaming-e2e.spec.ts'
fi

echo '🗑️ 清理函数: pm (tests/server/protocol-tools-streaming-e2e.spec.ts:112)'
if [[ -f 'tests/server/protocol-tools-streaming-e2e.spec.ts' ]]; then
  cp 'tests/server/protocol-tools-streaming-e2e.spec.ts' "$BACKUP_DIR/$(basename tests/server/protocol-tools-streaming-e2e.spec.ts).backup"
  echo '  ✅ 已备份: $(basename tests/server/protocol-tools-streaming-e2e.spec.ts)'
  # TODO: 实现精确的函数删除逻辑
  echo '  ⚠️ 需要手动删除函数定义'
else
  echo '  ❌ 文件不存在: tests/server/protocol-tools-streaming-e2e.spec.ts'
fi

echo '🗑️ 清理函数: hasToolUse (tests/server/protocol-tools-streaming-e2e.spec.ts:137)'
if [[ -f 'tests/server/protocol-tools-streaming-e2e.spec.ts' ]]; then
  cp 'tests/server/protocol-tools-streaming-e2e.spec.ts' "$BACKUP_DIR/$(basename tests/server/protocol-tools-streaming-e2e.spec.ts).backup"
  echo '  ✅ 已备份: $(basename tests/server/protocol-tools-streaming-e2e.spec.ts)'
  # TODO: 实现精确的函数删除逻辑
  echo '  ⚠️ 需要手动删除函数定义'
else
  echo '  ❌ 文件不存在: tests/server/protocol-tools-streaming-e2e.spec.ts'
fi

echo '🗑️ 清理函数: pm (tests/server/protocol-tools-streaming-e2e.spec.ts:148)'
if [[ -f 'tests/server/protocol-tools-streaming-e2e.spec.ts' ]]; then
  cp 'tests/server/protocol-tools-streaming-e2e.spec.ts' "$BACKUP_DIR/$(basename tests/server/protocol-tools-streaming-e2e.spec.ts).backup"
  echo '  ✅ 已备份: $(basename tests/server/protocol-tools-streaming-e2e.spec.ts)'
  # TODO: 实现精确的函数删除逻辑
  echo '  ⚠️ 需要手动删除函数定义'
else
  echo '  ❌ 文件不存在: tests/server/protocol-tools-streaming-e2e.spec.ts'
fi

echo '🗑️ 清理函数: hasToolUse (tests/server/protocol-tools-streaming-e2e.spec.ts:173)'
if [[ -f 'tests/server/protocol-tools-streaming-e2e.spec.ts' ]]; then
  cp 'tests/server/protocol-tools-streaming-e2e.spec.ts' "$BACKUP_DIR/$(basename tests/server/protocol-tools-streaming-e2e.spec.ts).backup"
  echo '  ✅ 已备份: $(basename tests/server/protocol-tools-streaming-e2e.spec.ts)'
  # TODO: 实现精确的函数删除逻辑
  echo '  ⚠️ 需要手动删除函数定义'
else
  echo '  ❌ 文件不存在: tests/server/protocol-tools-streaming-e2e.spec.ts'
fi

echo '🗑️ 清理函数: hasReasoning (tests/server/responses-glm-config.spec.ts:81)'
if [[ -f 'tests/server/responses-glm-config.spec.ts' ]]; then
  cp 'tests/server/responses-glm-config.spec.ts' "$BACKUP_DIR/$(basename tests/server/responses-glm-config.spec.ts).backup"
  echo '  ✅ 已备份: $(basename tests/server/responses-glm-config.spec.ts)'
  # TODO: 实现精确的函数删除逻辑
  echo '  ⚠️ 需要手动删除函数定义'
else
  echo '  ❌ 文件不存在: tests/server/responses-glm-config.spec.ts'
fi

echo '✅ 低风险函数清理脚本生成完成！'
echo '💡 请手动检查并执行函数删除操作'
echo '🔄 如需恢复，可从备份目录恢复文件'
