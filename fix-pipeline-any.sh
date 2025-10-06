#!/bin/bash

echo "🔧 批量替换pipeline模块中的any类型..."

# 替换常见的any类型为unknown
find src/modules/pipeline/ -name "*.ts" -type f -exec sed -i '' 's/: any\[\]/: unknown[]/g' {} \;
find src/modules/pipeline/ -name "*.ts" -type f -exec sed -i '' 's/: any\[\] =/: unknown[] =/g' {} \;
find src/modules/pipeline/ -name "*.ts" -type f -exec sed -i '' 's/\]: any)/]: unknown)/g' {} \;
find src/modules/pipeline/ -name "*.ts" -type f -exec sed -i '' 's/\]: any\[\]/]: unknown[]/g' {} \;
find src/modules/pipeline/ -name "*.ts" -type f -exec sed -i '' 's/\]: any =/]: unknown =/g' {} \;
find src/modules/pipeline/ -name "*.ts" -type f -exec sed -i '' 's/\]: any,/]: unknown,/g' {} \;
find src/modules/pipeline/ -name "*.ts" -type f -exec sed -i '' 's/\]: any;/]: unknown;/g' {} \;

# 替换复杂类型
find src/modules/pipeline/ -name "*.ts" -type f -exec sed -i '' 's/Record<string, any>/Record<string, unknown>/g' {} \;
find src/modules/pipeline/ -name "*.ts" -type f -exec sed -i '' 's/{ \[key: string\]: any }/{ [key: string]: unknown }/g' {} \;
find src/modules/pipeline/ -name "*.ts" -type f -exec sed -i '' 's/Promise<any>/Promise<unknown>/g' {} \;
find src/modules/pipeline/ -name "*.ts" -type f -exec sed -i '' 's/Array<any>/Array<unknown>/g' {} \;
find src/modules/pipeline/ -name "*.ts" -type f -exec sed -i '' 's/any\[\]/unknown[]/g' {} \;

echo "✅ 批量替换完成"