/**
 * OpenAI 协议族聚合器
 * - 基于 providerId/providerKey 选择最小家族差异
 * - 复用现有 GLM/LMStudio/iFlow 兼容模块
 * - Qwen 默认保持 OpenAI 形状（禁用“改形状”路径）
 */

import type { CompatAdapter } from '../provider-composite.js';
import type { CompositeContext } from '../provider-composite.js';
import type { ModuleDependencies } from '../../../../../interfaces/pipeline-interfaces.js';
import type { UnknownObject } from '../../../../../../../types/common-types.js';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 简单缓存，避免每次创建兼容模块实例
const glmCache = new Map<string, any>();
const lmstudioCache = new Map<string, any>();
const iflowCache = new Map<string, any>();

const compatModuleDir = typeof __dirname === 'string'
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));

async function importGLM(deps: ModuleDependencies) {
  let mod = glmCache.get('default');
  if (!mod) {
    try {
      if (String(process.env.RCC_TEST_FAKE_GLM || '') === '1') {
        const shim = {
          async initialize() {},
          async processIncoming(request: any) {
            const out: any = JSON.parse(JSON.stringify(request || {}));
            try {
              const tools = Array.isArray(out.tools) ? out.tools : [];
              for (const t of tools) {
                if (t && typeof t === 'object' && t.function && typeof t.function === 'object') {
                  delete (t.function as any).strict;
                }
              }
              if (!out.tools || out.tools.length === 0) {
                if ('tool_choice' in out) delete out.tool_choice;
              }
            } catch { /* ignore */ }
            return out;
          },
          async processOutgoing(response: any) {
            return response;
          }
        } as any;
        glmCache.set('default', shim);
        return shim;
      }
      let m: any;
      if (process.env.JEST_WORKER_ID) {
        // ts-jest 环境：直接 require TS 源文件
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        m = require('../../compatibility/glm/glm-compatibility.ts');
      } else {
        const resolved = path.resolve(compatModuleDir, '../../compatibility/glm/glm-compatibility.js');
        m = await import(pathToFileURL(resolved).href);
      }
      mod = new (m as any).GLMCompatibility(deps);
      await mod.initialize?.();
      glmCache.set('default', mod);
    } catch (e) {
      console.error('[openai-compat] Failed to load GLMCompatibility:', e);
      throw e;
    }
  }
  return mod;
}

async function importLMStudio(deps: ModuleDependencies) {
  let mod = lmstudioCache.get('default');
  if (!mod) {
    try {
      if (String(process.env.RCC_TEST_FAKE_LMSTUDIO || '') === '1') {
        const shim = {
          async initialize() {},
          async processIncoming(request: any) { return request; },
          async processOutgoing(response: any) { return response; }
        } as any;
        lmstudioCache.set('default', shim);
        return shim;
      }
      let m: any;
      if (process.env.JEST_WORKER_ID) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        m = require('../../compatibility/lmstudio-compatibility.ts');
      } else {
        const resolved = path.resolve(compatModuleDir, '../../compatibility/lmstudio-compatibility.js');
        m = await import(pathToFileURL(resolved).href);
      }
      mod = new (m as any).LMStudioCompatibility(deps);
      await mod.initialize?.();
      lmstudioCache.set('default', mod);
    } catch (e) {
      console.error('[openai-compat] Failed to load LMStudioCompatibility:', e);
      throw e;
    }
  }
  return mod;
}

async function importIFlow(deps: ModuleDependencies) {
  let mod = iflowCache.get('default');
  if (!mod) {
    try {
      if (String(process.env.RCC_TEST_FAKE_IFLOW || '') === '1') {
        const shim = {
          async initialize() {},
          async processIncoming(request: any) { return request; },
          async processOutgoing(response: any) { return response; }
        } as any;
        iflowCache.set('default', shim);
        return shim;
      }
      let m: any;
      if (process.env.JEST_WORKER_ID) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        m = require('../../compatibility/iflow/iflow-compatibility.ts');
      } else {
        const resolved = path.resolve(compatModuleDir, '../../compatibility/iflow/iflow-compatibility.js');
        m = await import(pathToFileURL(resolved).href);
      }
      mod = new (m as any).iFlowCompatibility(deps);
      await mod.initialize?.();
      iflowCache.set('default', mod);
    } catch (e) {
      console.error('[openai-compat] Failed to load iFlowCompatibility:', e);
      throw e;
    }
  }
  return mod;
}

function buildCompatContext(ctx: CompositeContext, direction: 'incoming' | 'outgoing') {
  return {
    compatibilityId: `compat_${ctx.requestId}`,
    profileId: ctx.pipelineId || ctx.routeName || 'default',
    providerType: (ctx.providerId || 'openai'),
    direction,
    stage: 'provider-composite',
    requestId: ctx.requestId,
    executionId: ctx.requestId,
    timestamp: Date.now(),
    startTime: Date.now(),
    entryEndpoint: (ctx as any)?.entryEndpoint,
    metadata: { dataSize: 0, dataKeys: [] }
  } as any; // 兼容旧接口
}

function minimalOpenAIRequest(body: UnknownObject): UnknownObject {
  // 确保不修改 OpenAI Chat 形状；做最小安全清理
  const b: any = { ...(body as any) };
  // 删除不被上游接受的 envelope 字段
  try { if ('metadata' in b) delete b.metadata; } catch {}
  return b;
}

function minimalOpenAIResponse(wire: unknown): unknown { return wire; }
function passthrough<T>(x: T): T { return x; }

export function createOpenAICompatAggregator(): CompatAdapter<'openai-chat'> {
  return {
    protocol: 'openai-chat',
    async request(body, ctx, deps) {
      const family = (ctx.providerId || ctx.providerKey || '').toLowerCase();
      if (family === 'glm') {
        try {
          const mod = await importGLM(deps);
          const compatCtx = buildCompatContext(ctx, 'incoming');
          return await mod.processIncoming(minimalOpenAIRequest(body), compatCtx);
        } catch { return minimalOpenAIRequest(body); }
      }
      if (family === 'lmstudio') {
        try {
          const mod = await importLMStudio(deps);
          const compatCtx = buildCompatContext(ctx, 'incoming');
          return await mod.processIncoming(minimalOpenAIRequest(body), compatCtx);
        } catch { return minimalOpenAIRequest(body); }
      }
      if (family === 'iflow') {
        try {
          const mod = await importIFlow(deps);
          const compatCtx = buildCompatContext(ctx, 'incoming');
          return await mod.processIncoming(minimalOpenAIRequest(body), compatCtx);
        } catch { return minimalOpenAIRequest(body); }
      }
      if (family === 'qwen') {
        // 保持 OpenAI 形状，不启用旧 qwen-compat 的改形状逻辑
        return minimalOpenAIRequest(body);
      }
      return passthrough(body);
    },
    async response(wire, ctx, deps) {
      const family = (ctx.providerId || ctx.providerKey || '').toLowerCase();
      if (family === 'glm') {
        try {
          const mod = await importGLM(deps);
          const compatCtx = buildCompatContext(ctx, 'outgoing');
          return await mod.processOutgoing(wire, compatCtx);
        } catch { return minimalOpenAIResponse(wire); }
      }
      if (family === 'lmstudio') {
        try {
          const mod = await importLMStudio(deps);
          const compatCtx = buildCompatContext(ctx, 'outgoing');
          return await mod.processOutgoing(wire, compatCtx);
        } catch { return minimalOpenAIResponse(wire); }
      }
      if (family === 'iflow') {
        try {
          const mod = await importIFlow(deps);
          const compatCtx = buildCompatContext(ctx, 'outgoing');
          return await mod.processOutgoing(wire, compatCtx);
        } catch { return minimalOpenAIResponse(wire); }
      }
      if (family === 'qwen') {
        return minimalOpenAIResponse(wire);
      }
      return passthrough(wire);
    }
  };
}

export default createOpenAICompatAggregator;
