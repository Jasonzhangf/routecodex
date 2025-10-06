/**
 * HTTP请求和响应类型定义
 * 用于定义RouteCodex中HTTP通信的标准类型
 */

/**
 * HTTP请求方法枚举
 */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';

/**
 * HTTP请求头对象
 */
export interface HttpHeaders {
  [key: string]: string | string[];
}

/**
 * 基础HTTP请求对象
 */
export interface HttpRequest {
  /** 请求方法 */
  method: HttpMethod;
  /** 请求URL */
  url: string;
  /** 请求头 */
  headers?: HttpHeaders;
  /** 请求体 */
  body?: unknown;
  /** 查询参数 */
  query?: Record<string, string | string[]>;
  /** 路径参数 */
  params?: Record<string, string>;
}

/**
 * HTTP响应状态码
 */
export type HttpStatusCode = number;

/**
 * 基础HTTP响应对象
 */
export interface HttpResponse {
  /** 状态码 */
  status: HttpStatusCode;
  /** 响应头 */
  headers?: HttpHeaders;
  /** 响应体 */
  body?: unknown;
  /** 状态消息 */
  statusMessage?: string;
}

/**
 * 流式HTTP响应对象
 */
export interface StreamHttpResponse extends HttpResponse {
  /** 是否为流式响应 */
  isStream: boolean;
}

/**
 * 错误响应对象
 */
export interface HttpError extends HttpResponse {
  /** 错误消息 */
  message: string;
  /** 错误码 */
  code?: string;
  /** 错误详情 */
  details?: Record<string, unknown>;
}

/**
 * JSON响应对象
 */
export interface JsonResponse extends HttpResponse {
  /** JSON格式的响应体 */
  body: Record<string, unknown> | Array<unknown>;
}

/**
 * OpenAI兼容的聊天完成请求
 */
export interface OpenAIChatCompletionRequest {
  /** 模型名称 */
  model: string;
  /** 消息列表 */
  messages: ChatMessage[];
  /** 是否流式响应 */
  stream?: boolean;
  /** 温度参数 */
  temperature?: number;
  /** 最大token数 */
  max_tokens?: number;
  /** 工具列表 */
  tools?: Tool[];
  /** 工具选择策略 */
  tool_choice?: 'none' | 'auto' | { type: 'function'; function: { name: string } };
  /** 其他参数 */
  [key: string]: unknown;
}

/**
 * 聊天消息类型
 */
export interface ChatMessage {
  /** 角色 */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** 内容 */
  content: string | null;
  /** 工具调用ID */
  tool_call_id?: string;
  /** 工具调用 */
  tool_calls?: ToolCall[];
}

/**
 * 工具定义
 */
export interface Tool {
  /** 工具类型 */
  type: 'function';
  /** 函数定义 */
  function: FunctionDefinition;
}

/**
 * 函数定义
 */
export interface FunctionDefinition {
  /** 函数名称 */
  name: string;
  /** 函数描述 */
  description?: string;
  /** 参数定义 */
  parameters?: Record<string, unknown>;
}

/**
 * 工具调用
 */
export interface ToolCall {
  /** 工具调用ID */
  id: string;
  /** 工具类型 */
  type: 'function';
  /** 函数调用 */
  function: {
    /** 函数名称 */
    name: string;
    /** 参数 */
    arguments: string;
  };
}