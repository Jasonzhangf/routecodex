import type { UnknownObject } from '../../../types/common-types.js';

type DebugLevel = 'basic' | 'detailed' | 'verbose';

type DebugConfigLike = {
  level: DebugLevel;
  maxDataSize: number;
};

type HookLike = {
  name: string;
  stage: string;
};

type DataPacketLike = {
  data: UnknownObject;
  metadata: {
    size: number;
  };
};

type DataChangeLike = {
  type: string;
  path: string;
  newValue?: unknown;
};

export function outputDebugInfo(args: {
  hook: HookLike;
  dataPacket: DataPacketLike;
  changes: DataChangeLike[];
  observations: string[];
  debugConfig: DebugConfigLike;
  formatDataForOutput: (data: UnknownObject) => UnknownObject;
}): void {
  console.log(`\n🔍 [DEBUG Hook] ${args.hook.name} (${args.hook.stage})`);
  console.log(`📊 数据大小: ${args.dataPacket.metadata.size} bytes`);
  console.log(`📝 变化数量: ${args.changes.length}`);
  console.log(`💭 观察记录: ${args.observations.length}`);

  if (args.debugConfig.level === 'detailed' || args.debugConfig.level === 'verbose') {
    console.log(`📋 数据快照:`, args.formatDataForOutput(args.dataPacket.data));
  }

  if (args.changes.length > 0) {
    console.log(`🔄 变化详情:`);
    args.changes.forEach(change => {
      console.log(`  ${change.type}: ${change.path} = ${JSON.stringify(change.newValue)}`);
    });
  }

  if (args.observations.length > 0 && args.debugConfig.level === 'verbose') {
    console.log(`👁️ 观察详情:`);
    args.observations.forEach(obs => console.log(`  - ${obs}`));
  }
}

export function outputFinalDebugInfo(args: {
  stage: string;
  target: string;
  changes: DataChangeLike[];
  observations: string[];
  executionTime: number;
}): void {
  console.log(`\n✅ [DEBUG Hook] ${args.stage} 阶段完成 (${args.target})`);
  console.log(`⏱️  总执行时间: ${args.executionTime}ms`);
  console.log(`🔄 总变化数量: ${args.changes.length}`);
  console.log(`💭 总观察记录: ${args.observations.length}`);

  if (args.changes.length > 0) {
    console.log(`📊 变化统计:`);
    const stats = args.changes.reduce((acc, change) => {
      acc[change.type] = (acc[change.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    Object.entries(stats).forEach(([type, count]) => {
      console.log(`  ${type}: ${count}`);
    });
  }
}

export function formatDataForOutput(
  data: UnknownObject,
  debugConfig: DebugConfigLike,
  calculateDataSize: (data: UnknownObject) => number
): UnknownObject {
  if (debugConfig.maxDataSize > 0 && calculateDataSize(data) > debugConfig.maxDataSize) {
    return {
      __truncated: true,
      __originalSize: calculateDataSize(data),
      __preview: `${JSON.stringify(data).substring(0, 200)  }...`
    };
  }
  return data;
}
