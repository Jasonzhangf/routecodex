#!/bin/bash

echo "🔧 批量修复未使用变量..."

# 修复函数参数未使用的情况
find src/ -name "*.ts" -type f -exec sed -i '' 's/private async updateModuleConfig(config: Record<string, any>): Promise<void> {/private async updateModuleConfig(_config: Record<string, any>): Promise<void> {/g' {} \;

# 移除未使用的导入
find src/ -name "*.ts" -type f -exec sed -i '' '/import.*LogLevel.*from.*types\.js.*;/d' {} \;

# 修复简单的未使用变量
find src/ -name "*.ts" -type f -exec sed -i '' 's/const history = logger\.getHistory();/\/\/ const history = logger.getHistory();/g' {} \;

echo "✅ 批量修复完成"