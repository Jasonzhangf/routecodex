const { execSync } = require('child_process');
const path = require('path');

try {
  console.log('开始TypeScript编译检查...');

  // 运行TypeScript编译检查
  const result = execSync('npx tsc --noEmit', {
    encoding: 'utf8',
    cwd: path.join(__dirname),
    stdio: 'pipe'
  });

  console.log('✅ TypeScript编译检查通过！');
  console.log('没有发现类型错误或语法错误。');

} catch (error) {
  console.log('❌ TypeScript编译检查失败：');
  console.log(error.stdout || error.message);
  process.exit(1);
}