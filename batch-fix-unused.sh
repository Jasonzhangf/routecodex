#!/bin/bash

echo "🔧 批量修复剩余未使用变量..."

# 批量添加下划线前缀到未使用的参数
find src/ -name "*.ts" -type f -exec sed -i '' 's/: data,/\/\/: data,/g' {} \;
find src/ -name "*.ts" -type f -exec sed -i '' 's/: condition,/\/\/: condition,/g' {} \;
find src/ -name "*.ts" -type f -exec sed -i '' 's/: transformation,/\/\/: transformation,/g' {} \;
find src/ -name "*.ts" -type f -exec sed -i '' 's/: request,/\/\/: request,/g' {} \;
find src/ -name "*.ts" -type f -exec sed -i '' 's/: response,/\/\/: response,/g' {} \;
find src/ -name "*.ts" -type f -exec sed -i '' 's/: result,/\/\/: result,/g' {} \;

# 批量移除未使用的导入
find src/ -name "*.ts" -type f -exec sed -i '' '/import.*ResourceInfo.*from/d' {} \;
find src/ -name "*.ts" -type f -exec sed -i '' '/import.*ResourceType.*from/d' {} \;

echo "✅ 批量修复完成"