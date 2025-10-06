#!/bin/bash

echo "🔧 批量修复DataValidator中的未使用参数..."

# 给未使用的参数添加下划线前缀
sed -i '' 's/, warnings: ValidationWarning[], fixes: ValidationFix[]/, _warnings: ValidationWarning[], _fixes: ValidationFix[]/g' src/logging/validator/DataValidator.ts
sed -i '' 's/, warnings: LogWarning[], fixes: LogFix[]/, _warnings: LogWarning[], _fixes: LogFix[]/g' src/logging/validator/DataValidator.ts
sed -i '' 's/, fixes: ValidationFix[]/, _fixes: ValidationFix[]/g' src/logging/validator/DataValidator.ts

echo "✅ DataValidator未使用参数修复完成"