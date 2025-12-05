import type { UnknownObject } from '../../../../modules/pipeline/types/common-types.js';
import type { ModuleDependencies } from '../../../../modules/pipeline/types/module.types.js';
import type { CompatibilityContext } from '../../compatibility-interface.js';
import { iFlowFieldMappingProcessor } from '../field-mapping/iflow-field-mapping-processor.js';
import { BaseCompatibility } from '../../base-compatibility.js';
import { sanitizeAndValidateOpenAIChat, type PreflightResult } from '../../../core/utils/preflight-validator.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

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
  profileId?: string;
}

/**
 * DTO解包函数
 */
export const unwrapDTO = (request: UnknownObject): { payload: UnknownObject; isDto: boolean; original: UnknownObject } => {
  const isDto =
    isRecord(request) &&
    ('data' in request || 'route' in request || 'metadata' in request);

  const dataField = isDto && isRecord((request as Record<string, unknown>).data)
    ? (request as Record<string, unknown>).data as UnknownObject
    : undefined;

  const payload: UnknownObject = dataField ?? request;

  return { payload, isDto, original: request };
};

/**
 * DTO重新包装函数
 */
export const rewrapDTO = (original: UnknownObject, payload: UnknownObject, isDto: boolean): UnknownObject => {
  if (!isDto) {
    return payload;
  }

  const dto: UnknownObject = { ...original };
  dto.data = payload;
  return dto;
};

/**
 * iFlow工具Schema清理函数
 */
export const sanitizeiFlowToolsSchema = (data: UnknownObject): UnknownObject => {
  try {
    const toolsCandidate = (data as { tools?: unknown }).tools;
    if (!Array.isArray(toolsCandidate)) {
      return data;
    }

    const normalizedTools = toolsCandidate.map(tool => (isRecord(tool) ? { ...tool } : tool));
    const result: UnknownObject = { ...data, tools: normalizedTools };

    for (const toolItem of normalizedTools) {
      if (!isRecord(toolItem)) {
        continue;
      }

      const fnCandidate = toolItem['function'];
      const fn = isRecord(fnCandidate) ? fnCandidate : undefined;
      if (!fn) {
        continue;
      }

      if ('strict' in fn) {
        delete (fn as Record<string, unknown>).strict;
      }

      const name = typeof fn.name === 'string' ? fn.name : undefined;
      const params = isRecord(fn.parameters) ? fn.parameters : undefined;
      if (!params || !name) {
        continue;
      }

      const props = isRecord(params.properties) ? (params.properties as Record<string, unknown>) : undefined;
      if (!props) {
        continue;
      }

      if (name === 'shell') {
        const commandSchema = props.command;
        if (isRecord(commandSchema)) {
          delete commandSchema.oneOf;
          commandSchema.type = 'array';
          commandSchema.items = { type: 'string' };
          if (typeof commandSchema.description !== 'string' || commandSchema.description.length === 0) {
            commandSchema.description = 'Shell command argv tokens. Use ["bash","-lc","<cmd>"] form.';
          }
        } else {
          props.command = {
            description: 'Shell command argv tokens. Use ["bash","-lc","<cmd>"] form.',
            type: 'array',
            items: { type: 'string' }
          };
        }

        if (!Array.isArray(params.required)) {
          params.required = [];
        }
        const required = params.required as unknown[];
        if (!required.includes('command')) {
          required.push('command');
        }

        if (typeof params.type !== 'string') {
          params.type = 'object';
        }
        if (typeof params.additionalProperties !== 'boolean') {
          params.additionalProperties = false;
        }
      }
    }

    return result;
  } catch {
    return data;
  }
};

/**
 * 检查Provider家族匹配
 */
export const shouldSkipProvider = (context: CompatibilityContext, expectedProfile?: string): boolean => {
  if (!expectedProfile) {
    return false;
  }
  const profile = context.profileId?.toLowerCase();
  return profile ? profile !== expectedProfile.toLowerCase() : false;
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
  const pre: PreflightResult = sanitizeAndValidateOpenAIChat(
    data,
    { target: 'openai', enableTools: true }
  );

  if (Array.isArray(pre.issues) && pre.issues.length > 0) {
    const errs = pre.issues.filter((issue) => issue.level === 'error');
    if (errs.length) {
      const detail = errs.map((issue) => `${issue.code}`).join(',');
      const validationError = new Error(`compat-validation-failed: ${detail}`);
      (validationError as { status?: number; code?: string }).status = 400;
      (validationError as { status?: number; code?: string }).code = 'compat_validation_failed';
      throw validationError;
    }
    dependencies.logger?.logModule('iflow-processor', 'preflight-warnings', {
      compatibilityId,
      requestId,
      count: pre.issues.length
    });
  }

  return pre.payload as UnknownObject;
};

/**
 * iFlow请求处理核心函数
 */
export const processiFlowIncoming = async (
  request: UnknownObject,
  config: iFlowProcessConfig,
  context: CompatibilityContext
): Promise<UnknownObject> => {
  const requestId = context.requestId || 'unknown';

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
    let processedPayload = await config.baseCompat.processIncoming(payload, context);

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
  const requestId = context.requestId || 'unknown';

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
    const result = await config.baseCompat.processOutgoing(response, context);

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
