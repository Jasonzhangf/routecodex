import type { UnknownObject } from '../../../../modules/pipeline/types/common-types.js';
import type { ModuleDependencies } from '../../../../modules/pipeline/types/module.types.js';
import type { CompatibilityContext } from '../../compatibility-interface.js';
import { GLMFieldMappingProcessor } from '../field-mapping/field-mapping-processor.js';
import { BaseCompatibility } from '../../base-compatibility.js';
import { sanitizeAndValidateOpenAIChat, type PreflightResult } from '../../../core/utils/preflight-validator.js';
import { sanitizeGLMToolsSchema } from '../utils/tool-schema-helpers.js';

const isRecord = (value: unknown): value is UnknownObject => typeof value === 'object' && value !== null;

interface ValidationError extends Error {
  status?: number;
  code?: string;
}

/**
 * GLM处理配置接口
 */
export interface GLMProcessConfig {
  shapeFilterConfigPath?: string;
  fieldMappingProcessor: GLMFieldMappingProcessor;
  dependencies: ModuleDependencies;
  baseCompat: BaseCompatibility;
  preflightEnabled: boolean;
  compatibilityId: string;
}

interface DtoEnvelope {
  payload: UnknownObject;
  isDto: boolean;
  original: UnknownObject;
}

const hasDtoShape = (value: UnknownObject): boolean => (
  'data' in value || 'route' in value || 'metadata' in value
);

/**
 * DTO解包函数
 */
export const unwrapDTO = (request: UnknownObject): DtoEnvelope => {
  const isDto = hasDtoShape(request);
  if (isDto && isRecord((request as { data?: unknown }).data)) {
    const payload = { ...(request as { data: UnknownObject }).data };
    return { payload, isDto: true, original: request };
  }

  return { payload: request, isDto: false, original: request };
};

/**
 * DTO重新包装函数
 */
export const rewrapDTO = (original: UnknownObject, payload: UnknownObject, isDto: boolean): UnknownObject => {
  if (isDto) {
    return { ...original, data: payload };
  }
  return payload;
};

/**
 * 检查Provider家族匹配
 */
export const shouldSkipProvider = (context: CompatibilityContext, providerType: string): boolean => {
  const providerFamily = String(context.providerFamily || context.providerId || '').toLowerCase();
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
  const options = { target: 'glm', enableTools: true, glmPolicy: 'compat' } as UnknownObject;
  const pre: PreflightResult = sanitizeAndValidateOpenAIChat(data, options);

  if (Array.isArray(pre.issues) && pre.issues.length) {
    const errs = pre.issues.filter(issue => issue.level === 'error');
    if (errs.length) {
      const detail = errs.map(issue => issue.code).join(',');
      const validationError: ValidationError = new Error(`compat-validation-failed: ${detail}`);
      validationError.status = 400;
      validationError.code = 'compat_validation_failed';
      throw validationError;
    }
    dependencies.logger?.logModule('glm-processor', 'preflight-warnings', {
      compatibilityId,
      requestId,
      count: pre.issues.length
    });
  }

  return pre.payload as UnknownObject;
};

const sanitizeToolsSchema = (payload: UnknownObject): UnknownObject => sanitizeGLMToolsSchema(payload);

/**
 * GLM请求处理核心函数
 */
export const processGLMIncoming = async (
  request: UnknownObject,
  config: GLMProcessConfig,
  context: CompatibilityContext
): Promise<UnknownObject> => {
  const requestId = context.requestId || 'unknown';

  config.dependencies.logger?.logModule('glm-processor', 'processIncoming-start', {
    compatibilityId: config.compatibilityId,
    requestId
  });

  try {
    if (shouldSkipProvider(context, 'glm')) {
      return request;
    }

    const { payload, isDto, original } = unwrapDTO(request);

    let processedPayload = await config.baseCompat.processIncoming(payload, context);
    processedPayload = sanitizeToolsSchema(processedPayload);

    if (config.preflightEnabled) {
      processedPayload = await performGLMValidation(processedPayload, config.dependencies, requestId, config.compatibilityId);
    }

    config.dependencies.logger?.logModule('glm-processor', 'processIncoming-success', {
      compatibilityId: config.compatibilityId,
      requestId
    });

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
  const requestId = context.requestId || 'unknown';

  config.dependencies.logger?.logModule('glm-processor', 'processOutgoing-start', {
    compatibilityId: config.compatibilityId,
    requestId
  });

  try {
    if (shouldSkipProvider(context, 'glm')) {
      return response;
    }

    const result = await config.baseCompat.processOutgoing(response, context);

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
  _injectedConfig: UnknownObject | undefined,
  fieldMappingProcessor: GLMFieldMappingProcessor,
  baseCompat: BaseCompatibility,
  compatibilityId: string
): Promise<GLMProcessConfig> => {
  const preflightEnabled = false;

  return {
    fieldMappingProcessor,
    dependencies,
    baseCompat,
    preflightEnabled,
    compatibilityId
  };
};
