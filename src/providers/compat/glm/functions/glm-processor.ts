import type { UnknownObject } from '../../../../modules/pipeline/types/common-types.js';
import type { ModuleDependencies } from '../../../../modules/pipeline/types/module.types.js';
import type { CompatibilityContext } from '../../compatibility-interface.js';
import { GLMFieldMappingProcessor } from '../field-mapping/field-mapping-processor.js';
import { BaseCompatibility } from '../../base-compatibility.js';
import { sanitizeAndValidateOpenAIChat, type PreflightResult } from '../../../../modules/pipeline/modules/provider/utils/preflight-validator.js';

/**
 * GLM处理配置接口
 */
export interface GLMProcessConfig {
  shapeFilterConfigPath?: string;
  fieldMappingProcessor: GLMFieldMappingProcessor;
  dependencies: ModuleDependencies;
  baseCompat: BaseCompatibility;
  preflightEnabled: boolean;
  compatibilityId: string; // 用于日志跟踪的唯一ID
}

/**
 * DTO解包函数
 */
export const unwrapDTO = (request: UnknownObject): { payload: UnknownObject; isDto: boolean; original: UnknownObject } => {
  const isDto = request && typeof request === 'object' && (
    Object.prototype.hasOwnProperty.call(request as Record<string, unknown>, 'data') ||
    Object.prototype.hasOwnProperty.call(request as Record<string, unknown>, 'route') ||
    Object.prototype.hasOwnProperty.call(request as Record<string, unknown>, 'metadata')
  );

  const payload: UnknownObject = (isDto && (request as any).data && typeof (request as any).data === 'object')
    ? ((request as any).data as UnknownObject)
    : (request as UnknownObject);

  return { payload, isDto, original: request };
};

/**
 * DTO重新包装函数
 */
export const rewrapDTO = (original: UnknownObject, payload: UnknownObject, isDto: boolean): UnknownObject => {
  if (isDto) {
    const dto: any = original || {};
    return { ...dto, data: payload } as UnknownObject;
  }
  return payload;
};

/**
 * GLM工具Schema清理函数
 */
export const sanitizeGLMToolsSchema = (data: UnknownObject): UnknownObject => {
  try {
    const tools = (data as any)?.tools;
    if (!Array.isArray(tools)) return data;

    const result = { ...data, tools: [...tools] };

    for (const t of result.tools) {
      if (!t || typeof t !== 'object') continue;
      const fn = (t as any).function;

      // 移除 OpenAI 扩展字段 strict（GLM 不接受）
      try {
        if (fn && typeof fn === 'object' && 'strict' in fn) {
          delete (fn as any).strict;
        }
      } catch { /* ignore */ }

      const name = typeof fn?.name === 'string' ? fn.name : undefined;
      const params = fn?.parameters && typeof fn.parameters === 'object' ? fn.parameters : undefined;
      if (!params || !name) continue;

      const props = (params as any).properties && typeof (params as any).properties === 'object' ? (params as any).properties : undefined;
      if (!props) continue;

      if (name === 'shell' && props.command) {
        const cmd = props.command as any;
        if (cmd && typeof cmd === 'object') {
          delete cmd.oneOf;
          cmd.type = 'array';
          cmd.items = { type: 'string' };
          if (typeof cmd.description !== 'string' || !cmd.description) {
            cmd.description = 'Shell command argv tokens. Use ["bash","-lc","<cmd>"] form.';
          }
        } else {
          (props as any).command = {
            description: 'Shell command argv tokens. Use ["bash","-lc","<cmd>"] form.',
            type: 'array',
            items: { type: 'string' }
          };
        }

        if (!Array.isArray((params as any).required)) (params as any).required = [];
        const req: string[] = (params as any).required;
        if (!req.includes('command')) req.push('command');
        if (typeof (params as any).type !== 'string') (params as any).type = 'object';
        if (typeof (params as any).additionalProperties !== 'boolean') (params as any).additionalProperties = false;
      }
    }

    return result;
  } catch (e) { throw e; }
};

/**
 * 检查Provider家族匹配
 */
export const shouldSkipProvider = (context: CompatibilityContext, providerType: string): boolean => {
  const providerFamily = String((context as any)?.providerType || '').toLowerCase();
  return Boolean(providerFamily && providerFamily !== providerType);
};

/**
 * GLM预检验证函数
 */
export const performGLMValidation = async (
  data: UnknownObject,
  dependencies: ModuleDependencies,
  requestId: string,
  compatibilityId: string
): Promise<UnknownObject> => {
  try {
    const pre: PreflightResult = sanitizeAndValidateOpenAIChat(
      data as any,
      { target: 'glm', enableTools: true, glmPolicy: 'compat' }
    );

    if (Array.isArray(pre.issues) && pre.issues.length) {
      const errs = pre.issues.filter((issue) => issue.level === 'error');
      if (errs.length) {
        const detail = errs.map((issue) => `${issue.code}`).join(',');
        const err: any = new Error(`compat-validation-failed: ${detail}`);
        err.status = 400;
        err.code = 'compat_validation_failed';
        throw err;
      }
      dependencies.logger?.logModule('glm-processor', 'preflight-warnings', {
        compatibilityId,
        requestId,
        count: pre.issues.length
      });
    }

    return pre.payload as UnknownObject;
  } catch (e) {
    throw e;
  }
};

/**
 * GLM请求处理核心函数
 */
export const processGLMIncoming = async (
  request: UnknownObject,
  config: GLMProcessConfig,
  context: CompatibilityContext
): Promise<UnknownObject> => {
  const requestId = (context as any)?.requestId || 'unknown';

  config.dependencies.logger?.logModule('glm-processor', 'processIncoming-start', {
    compatibilityId: config.compatibilityId,
    requestId
  });

  try {
    // 检查Provider家族匹配
    if (shouldSkipProvider(context, 'glm')) {
      return request;
    }

    // DTO解包
    const { payload, isDto, original } = unwrapDTO(request);

    // BaseCompatibility处理（包含快照、字段映射等）
    let processedPayload = await config.baseCompat.processIncoming(payload as UnknownObject, context);

    // GLM特定工具Schema清理
    processedPayload = sanitizeGLMToolsSchema(processedPayload);

    // 可选预检验证
    if (config.preflightEnabled) {
      processedPayload = await performGLMValidation(processedPayload, config.dependencies, requestId, config.compatibilityId);
    }

    config.dependencies.logger?.logModule('glm-processor', 'processIncoming-success', {
      compatibilityId: config.compatibilityId,
      requestId
    });

    // DTO重新包装
    return rewrapDTO(original, processedPayload, isDto);

  } catch (error) {
    config.dependencies.logger?.logError?.(error as Error, {
      compatibilityId: config.compatibilityId,
      requestId,
      stage: 'processIncoming'
    });
    throw error;
  }
};

/**
 * GLM响应处理核心函数
 */
export const processGLMOutgoing = async (
  response: UnknownObject,
  config: GLMProcessConfig,
  context: CompatibilityContext
): Promise<UnknownObject> => {
  const requestId = (context as any)?.requestId || 'unknown';

  config.dependencies.logger?.logModule('glm-processor', 'processOutgoing-start', {
    compatibilityId: config.compatibilityId,
    requestId
  });

  try {
    // 检查Provider家族匹配
    if (shouldSkipProvider(context, 'glm')) {
      return response;
    }

    // BaseCompatibility处理
    const result = await config.baseCompat.processOutgoing(response as UnknownObject, context);

    config.dependencies.logger?.logModule('glm-processor', 'processOutgoing-success', {
      compatibilityId: config.compatibilityId,
      requestId
    });

    return result;

  } catch (error) {
    config.dependencies.logger?.logError?.(error as Error, {
      compatibilityId: config.compatibilityId,
      requestId,
      stage: 'processOutgoing'
    });
    throw error;
  }
};

/**
 * 创建GLM处理配置
 */
export const createGLMProcessConfig = async (
  dependencies: ModuleDependencies,
  injectedConfig: any,
  fieldMappingProcessor: GLMFieldMappingProcessor,
  baseCompat: BaseCompatibility,
  compatibilityId: string
): Promise<GLMProcessConfig> => {
  // 检查是否启用预检验证 - 保持与原始实现完全一致
  // 原始逻辑：enabled = Boolean((this as any)?.config?.config?.policy?.preflight === true);
  // 但this.config不存在，所以原始行为应该是preflight始终为false
  // 这里保持原始行为以确保功能一致性
  const preflightEnabled = false; // 保持原始行为，避免意外的preflight启用

  return {
    fieldMappingProcessor,
    dependencies,
    baseCompat,
    preflightEnabled,
    compatibilityId
  };
};
