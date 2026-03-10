/**
 * 序列化器相关类型定义
 */

// 基础序列化选项
export interface SerializationOptions {
  /** 是否启用格式化 */
  pretty?: boolean;
  /** 是否启用压缩 */
  compress?: boolean;
  /** 字符编码 */
  encoding?: 'utf8' | 'ascii' | 'base64';
  /** 自定义分隔符 */
  delimiter?: string;
}

// Chat事件序列化选项
export interface ChatSerializationOptions extends SerializationOptions {
  /** 是否包含系统指纹 */
  includeSystemFingerprint?: boolean;
  /** 是否包含logprobs */
  includeLogprobs?: boolean;
  /** 自定义事件映射 */
  eventMapping?: Record<string, string>;
}

// Responses事件序列化选项
export interface ResponsesSerializationOptions extends SerializationOptions {
  /** 是否包含元数据 */
  includeMetadata?: boolean;
  /** 是否包含统计信息 */
  includeStats?: boolean;
  /** 自定义事件过滤 */
  eventFilter?: (event: any) => boolean;
}

// 通用事件序列化器接口
export interface EventSerializer<TOptions extends SerializationOptions = SerializationOptions> {
  /** 序列化单个事件 */
  serialize(event: any, options?: TOptions): string;
  /** 反序列化单个事件 */
  deserialize(data: string, options?: TOptions): any;
  /** 批量序列化 */
  serializeBatch(events: any[], options?: TOptions): string[];
  /** 批量反序列化 */
  deserializeBatch(data: string[], options?: TOptions): any[];
}

// Chat事件序列化器
export interface ChatEventSerializer extends EventSerializer<ChatSerializationOptions> {
  /** 序列化Chat Completion Chunk */
  serializeChatChunk(chunk: any, options?: ChatSerializationOptions): string;
  /** 反序列化Chat Completion Chunk */
  deserializeChatChunk(data: string, options?: ChatSerializationOptions): any;
}

// Responses事件序列化器
export interface ResponsesEventSerializer extends EventSerializer<ResponsesSerializationOptions> {
  /** 序列化Responses事件 */
  serializeResponsesEvent(event: any, options?: ResponsesSerializationOptions): string;
  /** 反序列化Responses事件 */
  deserializeResponsesEvent(data: string, options?: ResponsesSerializationOptions): any;
}