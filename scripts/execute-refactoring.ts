/**
 * RouteCodex Configuration System Refactoring Executor
 * 执行配置系统重构
 */

import { RefactoringAgent } from '../src/config/refactoring-agent.js';

async function main() {
  console.log('🚀 Starting RouteCodex Configuration System Refactoring...\n');

  try {
    const agent = new RefactoringAgent();
    await agent.executeRefactoring();

    console.log('\n✅ Refactoring completed successfully!');
    console.log('📋 Please review the generated files and run tests to verify functionality.');

  } catch (error) {
    console.error('\n❌ Refactoring failed:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('❌ Failed to execute refactoring:', error);
  process.exit(1);
});