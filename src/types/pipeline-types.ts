/**
 * 流水线系统类型定义
 * 用于定义RouteCodex中流水线架构的类型
 */

import { HttpRequest, HttpResponse, UnknownObject } from './http-types';
import { BaseModuleConfig } from './config-types';

/**
 * 流水线上下文对象
 */
export interface PipelineContext {
  /** 请求对象 */
  request: HttpRequest;
  /** 响应对象 */
  response?: HttpResponse;
  /** 共享数据 */
  sharedData: UnknownObject;
  /** 配置数据 */
  config: UnknownObject;
  /** 元数据 */
  metadata: UnknownObject;
}

/**
 * 流水线模块接口
 */
export interface PipelineModule {
  /** 模块ID */
  id: string;
  /** 模块名称 */
  name: string;
  /** 模块类型 */
  type: string;
  /** 执行方法 */
  execute(context: PipelineContext): Promise<PipelineContext>;
  /** 初始化方法 */
  initialize(config: BaseModuleConfig): Promise<void>;
  /** 销毁方法 */
  destroy(): Promise<void>;
}

/**
 * 流水线阶段
 */
export type PipelineStage = 
  | 'request-processing'
  | 'provider-routing'
  | 'protocol-conversion'
  | 'response-processing'
  | 'error-handling';

/**
 * 流水线事件
 */
export interface PipelineEvent {
  /** 事件类型 */
  type: string;
  /** 事件时间戳 */
  timestamp: number;
  /** 事件数据 */
  data: UnknownObject;
  /** 事件来源 */
  source: string;
}

/**
 * 流水线状态
 */
export interface PipelineState {
  /** 当前阶段 */
  currentStage: PipelineStage;
  /** 已完成阶段 */
  completedStages: PipelineStage[];
  /** 是否出错 */
  hasError: boolean;
  /** 错误信息 */
  error?: Error;
  /** 开始时间 */
  startTime: number;
  /** 结束时间 */
  endTime?: number;
}

/**
 * 流水线执行结果
 */
export interface PipelineResult {
  /** 是否成功 */
  success: boolean;
  /** 响应对象 */
  response?: HttpResponse;
  /** 错误信息 */
  error?: Error;
  /** 执行时间 */
  executionTime: number;
  /** 流水线状态 */
  state: PipelineState;
}

/**
 * 流水线配置
 */
export interface PipelineConfiguration {
  /** 流水线ID */
  id: string;
  /** 流水线名称 */
  name: string;
  /** 流水线阶段 */
  stages: PipelineStage[];
  /** 模块配置 */
  modules: BaseModuleConfig[];
  /** 是否启用 */
  enabled: boolean;
}

/**
 * 流水线管理器接口
 */
export interface PipelineManager {
  /** 创建流水线 */
  createPipeline(config: PipelineConfiguration): Promise<Pipeline>;
  /** 获取流水线 */
  getPipeline(id: string): Promise<Pipeline | null>;
  /** 执行流水线 */
  executePipeline(id: string, context: PipelineContext): Promise<PipelineResult>;
  /** 删除流水线 */
  removePipeline(id: string): Promise<void>;
}

/**
 * 流水线接口
 */
export interface Pipeline {
  /** 流水线ID */
  id: string;
  /** 执行流水线 */
  execute(context: PipelineContext): Promise<PipelineResult>;
  /** 添加模块 */
  addModule(module: PipelineModule, stage: PipelineStage): void;
  /** 移除模块 */
  removeModule(moduleId: string): void;
  /** 获取状态 */
  getState(): PipelineState;
}

/**
 * 模块元数据
 */
export interface ModuleMetadata {
  /** 模块版本 */
  version: string;
  /** 模块描述 */
  description: string;
  /** 模块作者 */
  author?: string;
  /** 模块依赖 */
  dependencies?: string[];
  /** 模块配置模式 */
  configSchema?: UnknownObject;
}

/**
 * 模块工厂接口
 */
export interface ModuleFactory {
  /** 创建模块实例 */
  create(config: BaseModuleConfig): Promise<PipelineModule>;
  /** 获取模块元数据 */
  getMetadata(): ModuleMetadata;
  /** 验证配置 */
  validateConfig(config: BaseModuleConfig): boolean;
}