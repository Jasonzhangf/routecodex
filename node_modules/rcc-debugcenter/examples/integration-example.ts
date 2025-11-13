/**
 * DebugCenter 集成示例
 * 演示如何将 DebugCenter 与 BaseModule 或其他模块集成
 */

import { DebugCenter, DebugEventBus, type DebugEvent } from '../src/index';

// 模拟 BaseModule 接口
interface BaseModuleLike {
  id: string;
  name: string;
  version: string;
  setExternalDebugHandler: (handler: (event: DebugEvent) => void) => void;
  startIOTracking: (operationId: string, input: any, method?: string) => void;
  endIOTracking: (operationId: string, output: any, success?: boolean, error?: string) => void;
}

// 模拟的 BaseModule 实现
class MockBaseModule implements BaseModuleLike {
  public id: string;
  public name: string;
  public version: string;
  private externalDebugHandler?: (event: DebugEvent) => void;

  constructor(info: { id: string; name: string; version: string }) {
    this.id = info.id;
    this.name = info.name;
    this.version = info.version;
  }

  public setExternalDebugHandler(handler: (event: DebugEvent) => void): void {
    this.externalDebugHandler = handler;
  }

  public startIOTracking(operationId: string, input: any, method?: string): void {
    if (!this.externalDebugHandler) return;

    const event: DebugEvent = {
      sessionId: 'session-123',
      moduleId: this.id,
      operationId,
      timestamp: Date.now(),
      type: 'start',
      position: 'middle',
      data: {
        input,
        method,
        moduleInfo: {
          id: this.id,
          name: this.name,
          version: this.version
        }
      }
    };

    this.externalDebugHandler(event);
    console.log(`[MockBaseModule] Started tracking: ${operationId}`);
  }

  public endIOTracking(operationId: string, output: any, success: boolean = true, error?: string): void {
    if (!this.externalDebugHandler) return;

    const event: DebugEvent = {
      sessionId: 'session-123',
      moduleId: this.id,
      operationId,
      timestamp: Date.now(),
      type: success ? 'end' : 'error',
      position: 'middle',
      data: {
        output,
        success,
        error,
        moduleInfo: {
          id: this.id,
          name: this.name,
          version: this.version
        }
      }
    };

    this.externalDebugHandler(event);
    console.log(`[MockBaseModule] Ended tracking: ${operationId} (${success ? 'success' : 'failed'})`);
  }
}

// 集成示例 1: 手动集成
async function example1_ManualIntegration() {
  console.log('\n=== 示例 1: 手动集成 ===');

  // 创建 DebugCenter 实例
  const debugCenter = new DebugCenter({
    enabled: true,
    outputDirectory: './debug-logs',
    enableRealTimeUpdates: true
  });

  // 创建 BaseModule 实例
  const baseModule = new MockBaseModule({
    id: 'test-module',
    name: 'Test Module',
    version: '1.0.0'
  });

  // 手动设置调试处理器
  baseModule.setExternalDebugHandler((event) => {
    debugCenter.processDebugEvent(event);
  });

  // 模拟模块操作
  baseModule.startIOTracking('process-data', { input: 'test-data' }, 'processData');

  // 模拟处理过程
  await new Promise(resolve => setTimeout(resolve, 100));

  baseModule.endIOTracking('process-data', { output: 'processed-data' }, true);

  // 查看结果
  const sessions = debugCenter.getActiveSessions();
  console.log('活跃会话:', sessions.length);

  // 导出数据
  const exportData = debugCenter.exportData({ format: 'json', includeStats: true });
  console.log('导出数据长度:', JSON.stringify(exportData).length);

  // 清理
  await debugCenter.destroy();
}

// 集成示例 2: 使用便捷方法
async function example2_ConvenienceMethod() {
  console.log('\n=== 示例 2: 使用便捷方法 ===');

  // 创建 DebugCenter 实例
  const debugCenter = new DebugCenter({
    enabled: true,
    outputDirectory: './debug-logs',
    enableRealTimeUpdates: true
  });

  // 创建 BaseModule 实例
  const baseModule = new MockBaseModule({
    id: 'test-module-2',
    name: 'Test Module 2',
    version: '1.0.0'
  });

  // 使用便捷方法连接
  debugCenter.connectBaseModule(baseModule);

  // 模拟模块操作
  baseModule.startIOTracking('analyze-data', { input: 'raw-data' }, 'analyzeData');

  // 模拟处理过程
  await new Promise(resolve => setTimeout(resolve, 150));

  baseModule.endIOTracking('analyze-data', { output: 'analysis-result' }, true);

  // 查看统计信息
  const stats = debugCenter.getStats();
  console.log('统计信息:', stats);

  // 清理
  await debugCenter.destroy();
}

// 集成示例 3: 事件驱动架构
async function example3_EventDrivenArchitecture() {
  console.log('\n=== 示例 3: 事件驱动架构 ===');

  // 创建 DebugCenter 实例
  const debugCenter = new DebugCenter({
    enabled: true,
    outputDirectory: './debug-logs',
    enableRealTimeUpdates: true
  });

  // 创建事件总线
  const eventBus = DebugEventBus.getInstance();

  // 订阅 DebugCenter 事件
  eventBus.subscribe('*', (event: DebugEvent) => {
    console.log(`[EventBus] 事件类型: ${event.type}, 操作: ${event.operationId}`);
  });

  // 创建多个模块
  const module1 = new MockBaseModule({ id: 'module-1', name: 'Module 1', version: '1.0.0' });
  const module2 = new MockBaseModule({ id: 'module-2', name: 'Module 2', version: '1.0.0' });

  // 连接模块到 DebugCenter
  debugCenter.connectBaseModule(module1);
  debugCenter.connectBaseModule(module2);

  // 模拟并发操作
  module1.startIOTracking('task-1', { data: 'input1' });
  module2.startIOTracking('task-2', { data: 'input2' });

  await new Promise(resolve => setTimeout(resolve, 100));

  module1.endIOTracking('task-1', { result: 'output1' }, true);
  module2.endIOTracking('task-2', { result: 'output2' }, true);

  // 查看所有会话
  const allSessions = debugCenter.getActiveSessions();
  console.log('所有会话:', allSessions.map(s => ({ id: s.sessionId, status: s.status })));

  // 清理
  await debugCenter.destroy();
}

// 集成示例 4: 独立使用 DebugCenter
async function example4_StandaloneUsage() {
  console.log('\n=== 示例 4: 独立使用 DebugCenter ===');

  // 创建 DebugCenter 实例
  const debugCenter = new DebugCenter({
    enabled: true,
    outputDirectory: './debug-logs',
    enableRealTimeUpdates: true
  });

  // 直接使用 DebugCenter API
  const sessionId = debugCenter.startPipelineSession('standalone-pipeline', 'Standalone Pipeline');

  // 记录操作
  debugCenter.recordOperation(
    sessionId,
    'custom-module',
    'custom-operation',
    { input: 'custom-input' },
    { output: 'custom-output' },
    'customMethod',
    true
  );

  // 结束会话
  debugCenter.endPipelineSession(sessionId, true);

  // 查看统计
  const stats = debugCenter.getStats();
  console.log('独立模式统计:', stats);

  // 清理
  await debugCenter.destroy();
}

// 运行所有示例
async function runAllExamples() {
  try {
    await example1_ManualIntegration();
    await example2_ConvenienceMethod();
    await example3_EventDrivenArchitecture();
    await example4_StandaloneUsage();

    console.log('\n=== 所有示例运行完成 ===');
  } catch (error) {
    console.error('示例运行失败:', error);
  }
}

// 如果直接运行此文件
if (require.main === module) {
  runAllExamples();
}

export {
  example1_ManualIntegration,
  example2_ConvenienceMethod,
  example3_EventDrivenArchitecture,
  example4_StandaloneUsage,
  MockBaseModule
};