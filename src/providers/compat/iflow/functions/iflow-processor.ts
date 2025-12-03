import type { UnknownObject } from '../../../../modules/pipeline/types/common-types.js';
import type { ModuleDependencies } from '../../../../modules/pipeline/types/module.types.js';
import type { CompatibilityContext } from '../../compatibility-interface.js';
import { iFlowFieldMappingProcessor } from '../field-mapping/iflow-field-mapping-processor.js';
import { BaseCompatibility } from '../../base-compatibility.js';
import { sanitizeAndValidateOpenAIChat, type PreflightResult } from '../../../../modules/pipeline/modules/provider/utils/preflight-validator.js';

/**
 * iFlow处理配置接口
 */
export interface iFlowProcessConfig {
  shapeFilterConfigPath?: string;
  fieldMappingProcessor: iFlowFieldMappingProcessor;
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
 * iFlow工具Schema清理函数
 */
export const sanitizeiFlowToolsSchema = (data: UnknownObject): UnknownObject => {
  try {
    const tools = (data as any)?.tools;
    if (!Array.isArray(tools)) return data;

    const result = { ...data, tools: [...tools] };

    for (const t of result.tools) {
      if (!t || typeof t !== 'object') continue;
      const fn = (t as any).function;

      // 移除 OpenAI 扩展字段 strict（iFlow 不接受）
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
  } catch { /* ignore */ return data; }
};

/**
 * 检查Provider家族匹配
 */
export const shouldSkipProvider = (context: CompatibilityContext, providerType: string): boolean => {
  const providerFamily = String((context as any)?.providerType || '').toLowerCase();
  return Boolean(providerFamily && providerFamily !== providerType);
};

/**
 * iFlow预检验证函数
 */
export const performiFlowValidation = async (
  data: UnknownObject,
  dependencies: ModuleDependencies,
  requestId: string,
  compatibilityId: string
): Promise<UnknownObject> => {
  try {
    // iFlow使用openai兼容的验证
    const pre: PreflightResult = sanitizeAndValidateOpenAIChat(
      data as any,
      { target: 'openai', enableTools: true }
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
      dependencies.logger?.logModule('iflow-processor', 'preflight-warnings', {
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
 * iFlow请求处理核心函数
 */
export const processiFlowIncoming = async (
  request: UnknownObject,
  config: iFlowProcessConfig,
  context: CompatibilityContext
): Promise<UnknownObject> => {
  const requestId = (context as any)?.requestId || 'unknown';

  config.dependencies.logger?.logModule('iflow-processor', 'processIncoming-start', {
    compatibilityId: config.compatibilityId,
    requestId
  });

  try {
    // 检查Provider家族匹配
    if (shouldSkipProvider(context, 'iflow')) {
      return request;
    }

    // DTO解包
    const { payload, isDto, original } = unwrapDTO(request);

    // BaseCompatibility处理（包含快照、字段映射等）
    let processedPayload = await config.baseCompat.processIncoming(payload as UnknownObject, context);

    // iFlow特定工具Schema清理
    processedPayload = sanitizeiFlowToolsSchema(processedPayload);

    // 可选预检验证
    if (config.preflightEnabled) {
      processedPayload = await performiFlowValidation(processedPayload, config.dependencies, requestId, config.compatibilityId);
    }

    config.dependencies.logger?.logModule('iflow-processor', 'processIncoming-success', {
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
 * iFlow响应处理核心函数
 */
export const processiFlowOutgoing = async (
  response: UnknownObject,
  config: iFlowProcessConfig,
  context: CompatibilityContext
): Promise<UnknownObject> => {
  const requestId = (context as any)?.requestId || 'unknown';

  config.dependencies.logger?.logModule('iflow-processor', 'processOutgoing-start', {
    compatibilityId: config.compatibilityId,
    requestId
  });

  try {
    // 检查Provider家族匹配
    if (shouldSkipProvider(context, 'iflow')) {
      return response;
    }

    // BaseCompatibility处理
    const result = await config.baseCompat.processOutgoing(response as UnknownObject, context);

    config.dependencies.logger?.logModule('iflow-processor', 'processOutgoing-success', {
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
 * 创建iFlow处理配置
 */
export const createiFlowProcessConfig = async (
  dependencies: ModuleDependencies,
  fieldMappingProcessor: iFlowFieldMappingProcessor,
  baseCompat: BaseCompatibility,
  compatibilityId: string
): Promise<iFlowProcessConfig> => {
  // iFlow模块保持原始行为：preflight始终为false
  const preflightEnabled = false;

  return {
    fieldMappingProcessor,
    dependencies,
    baseCompat,
    preflightEnabled,
    compatibilityId
  };
};
