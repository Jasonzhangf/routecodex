/**
 * SSE事件类型定义
 * 基于OpenAI Responses协议的事件规范
 */

import type { JsonValue } from './core-interfaces.js';

// 标准SSE事件类型
export type SseEventType =
  // Response生命周期事件
  | 'response.created'
  | 'response.in_progress'
  | 'response.completed'
  | 'response.required_action'
  | 'response.done'

  // Output Item事件
  | 'response.output_item.added'
  | 'response.output_item.done'

  // Content Part事件
  | 'response.content_part.added'
  | 'response.content_part.done'

  // 内容增量事件
  | 'response.output_text.delta'
  | 'response.output_text.done'
  | 'response.reasoning_text.delta'
  | 'response.reasoning_text.done'
  | 'response.function_call_arguments.delta'
  | 'response.function_call_arguments.done';

// 基础SSE事件接口
export interface BaseSseEvent {
  type: SseEventType;
  timestamp?: string;
  sequence_number: number;
}

// Response生命周期事件
export interface ResponseCreatedEvent extends BaseSseEvent {
  type: 'response.created';
  response: {
    id: string;
    object: 'response';
    created_at: number;
    status: 'in_progress';
    model: string;
    output: OutputItem[];
    previous_response_id: string | null;
  };
}

export interface ResponseInProgressEvent extends BaseSseEvent {
  type: 'response.in_progress';
  response: ResponseObject;
}

export interface ResponseCompletedEvent extends BaseSseEvent {
  type: 'response.completed';
  response: ResponseObject;
}

export interface ResponseRequiredActionEvent extends BaseSseEvent {
  type: 'response.required_action';
  response: ResponseObject;
  required_action: RequiredAction;
}

export interface ResponseDoneEvent extends BaseSseEvent {
  type: 'response.done';
}

// Output Item事件
export interface OutputItemAddedEvent extends BaseSseEvent {
  type: 'response.output_item.added';
  output_index: number;
  item: OutputItem;
}

export interface OutputItemDoneEvent extends BaseSseEvent {
  type: 'response.output_item.done';
  output_index: number;
  item: OutputItem;
}

// Content Part事件
export interface ContentPartAddedEvent extends BaseSseEvent {
  type: 'response.content_part.added';
  item_id: string;
  output_index: number;
  content_index: number;
  part: ContentPart;
}

export interface ContentPartDoneEvent extends BaseSseEvent {
  type: 'response.content_part.done';
  item_id: string;
  output_index: number;
  content_index: number;
  part: ContentPart;
}

// 内容增量事件
export interface OutputTextDeltaEvent extends BaseSseEvent {
  type: 'response.output_text.delta';
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
  logprobs?: JsonValue[];
}

export interface OutputTextDoneEvent extends BaseSseEvent {
  type: 'response.output_text.done';
  item_id: string;
  output_index: number;
  content_index: number;
}

export interface ReasoningTextDeltaEvent extends BaseSseEvent {
  type: 'response.reasoning_text.delta';
  item_id: string;
  output_index: number;
  content_index: number;
  delta: string;
}

export interface ReasoningTextDoneEvent extends BaseSseEvent {
  type: 'response.reasoning_text.done';
  item_id: string;
  output_index: number;
  content_index: number;
  text: string;
}

export interface FunctionCallArgumentsDeltaEvent extends BaseSseEvent {
  type: 'response.function_call_arguments.delta';
  item_id: string;
  output_index: number;
  delta: string;
}

export interface FunctionCallArgumentsDoneEvent extends BaseSseEvent {
  type: 'response.function_call_arguments.done';
  item_id: string;
  output_index: number;
  arguments: string;
}

// 联合类型
export type SseEvent =
  | ResponseCreatedEvent
  | ResponseInProgressEvent
  | ResponseCompletedEvent
  | ResponseRequiredActionEvent
  | ResponseDoneEvent
  | OutputItemAddedEvent
  | OutputItemDoneEvent
  | ContentPartAddedEvent
  | ContentPartDoneEvent
  | OutputTextDeltaEvent
  | OutputTextDoneEvent
  | ReasoningTextDeltaEvent
  | ReasoningTextDoneEvent
  | FunctionCallArgumentsDeltaEvent
  | FunctionCallArgumentsDoneEvent;

// 数据类型定义
export interface ResponseObject {
  id: string;
  object: 'response';
  created_at: number;
  status: 'in_progress' | 'requires_action' | 'completed';
  model: string;
  output: OutputItem[];
  usage?: UsageInfo;
  previous_response_id: string | null;
  required_action?: RequiredAction;
  output_text?: string;
}

export interface OutputItem {
  id: string;
  type: 'reasoning' | 'message' | 'function_call' | 'system_message';
  status?: 'in_progress' | 'completed';
  content?: ContentPart[];
  summary?: JsonValue[];
  role?: string;
  arguments?: string;
  call_id?: string;
  name?: string;
  message?: MessageContent;
}

export interface ContentPart {
  type: 'reasoning_text' | 'output_text' | 'input_text' | 'commentary';
  text: string;
}

export interface MessageContent {
  id?: string;
  role: string;
  status?: string;
  content: ContentPart[];
}

export interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  output_tokens_details?: {
    reasoning_tokens: number;
  };
}

export interface RequiredAction {
  type: 'submit_tool_outputs';
  submit_tool_outputs: {
    tool_calls: ToolCall[];
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// SSE事件流统计
export interface SseEventStats {
  totalEvents: number;
  eventTypes: Record<SseEventType, number>;
  startTime: number;
  endTime?: number;
  duration?: number;
  outputItemsCount: number;
  contentPartsCount: number;
  deltaEventsCount: number;
}

// 事件验证规则
export interface EventValidationRule {
  type: SseEventType;
  requiredFields: string[];
  optionalFields: string[];
  dependencies: Array<{
    field: string;
    condition: (event: Record<string, unknown>) => boolean;
    requiredFields: string[];
  }>;
}

// 预定义的验证规则
export const SSE_EVENT_VALIDATION_RULES: Record<SseEventType, EventValidationRule> = {
  'response.created': {
    type: 'response.created',
    requiredFields: ['type', 'response'],
    optionalFields: ['timestamp', 'sequence_number'],
    dependencies: [
      {
        field: 'response',
        condition: (e) => !!e.response,
        requiredFields: ['id', 'object', 'created_at', 'status', 'model', 'output', 'previous_response_id']
      }
    ]
  },
  'response.in_progress': {
    type: 'response.in_progress',
    requiredFields: ['type', 'response'],
    optionalFields: ['timestamp', 'sequence_number'],
    dependencies: [
      {
        field: 'response',
        condition: (e) => !!e.response,
        requiredFields: ['id', 'object', 'created_at', 'status', 'model']
      }
    ]
  },
  'response.completed': {
    type: 'response.completed',
    requiredFields: ['type', 'response'],
    optionalFields: ['timestamp', 'sequence_number'],
    dependencies: [
      {
        field: 'response',
        condition: (e) => !!e.response,
        requiredFields: ['id', 'object', 'created_at', 'status', 'model', 'output', 'usage']
      }
    ]
  },
  'response.required_action': {
    type: 'response.required_action',
    requiredFields: ['type', 'response', 'required_action'],
    optionalFields: ['timestamp', 'sequence_number'],
    dependencies: [
      {
        field: 'response',
        condition: (e) => !!e.response,
        requiredFields: ['id', 'object', 'created_at', 'status', 'model']
      },
      {
        field: 'required_action',
        condition: (e) => !!e.required_action,
        requiredFields: ['type', 'submit_tool_outputs']
      }
    ]
  },
  'response.done': {
    type: 'response.done',
    requiredFields: ['type'],
    optionalFields: ['timestamp', 'sequence_number'],
    dependencies: []
  },
  'response.output_item.added': {
    type: 'response.output_item.added',
    requiredFields: ['type', 'output_index', 'item'],
    optionalFields: ['timestamp', 'sequence_number'],
    dependencies: [
      {
        field: 'item',
        condition: (e) => !!e.item,
        requiredFields: ['id', 'type']
      }
    ]
  },
  'response.output_item.done': {
    type: 'response.output_item.done',
    requiredFields: ['type', 'output_index', 'item'],
    optionalFields: ['timestamp', 'sequence_number'],
    dependencies: [
      {
        field: 'item',
        condition: (e) => !!e.item,
        requiredFields: ['id', 'type']
      }
    ]
  },
  'response.content_part.added': {
    type: 'response.content_part.added',
    requiredFields: ['type', 'item_id', 'output_index', 'content_index', 'part'],
    optionalFields: ['timestamp', 'sequence_number'],
    dependencies: [
      {
        field: 'part',
        condition: (e) => !!e.part,
        requiredFields: ['type', 'text']
      }
    ]
  },
  'response.content_part.done': {
    type: 'response.content_part.done',
    requiredFields: ['type', 'item_id', 'output_index', 'content_index', 'part'],
    optionalFields: ['timestamp', 'sequence_number'],
    dependencies: [
      {
        field: 'part',
        condition: (e) => !!e.part,
        requiredFields: ['type', 'text']
      }
    ]
  },
  'response.output_text.delta': {
    type: 'response.output_text.delta',
    requiredFields: ['type', 'item_id', 'output_index', 'content_index', 'delta'],
    optionalFields: ['timestamp', 'sequence_number', 'logprobs'],
    dependencies: []
  },
  'response.output_text.done': {
    type: 'response.output_text.done',
    requiredFields: ['type', 'item_id', 'output_index', 'content_index'],
    optionalFields: ['timestamp', 'sequence_number'],
    dependencies: []
  },
  'response.reasoning_text.delta': {
    type: 'response.reasoning_text.delta',
    requiredFields: ['type', 'item_id', 'output_index', 'content_index', 'delta'],
    optionalFields: ['timestamp', 'sequence_number'],
    dependencies: []
  },
  'response.reasoning_text.done': {
    type: 'response.reasoning_text.done',
    requiredFields: ['type', 'item_id', 'output_index', 'content_index', 'text'],
    optionalFields: ['timestamp', 'sequence_number'],
    dependencies: []
  },
  'response.function_call_arguments.delta': {
    type: 'response.function_call_arguments.delta',
    requiredFields: ['type', 'item_id', 'output_index', 'delta'],
    optionalFields: ['timestamp', 'sequence_number'],
    dependencies: []
  },
  'response.function_call_arguments.done': {
    type: 'response.function_call_arguments.done',
    requiredFields: ['type', 'item_id', 'output_index', 'arguments'],
    optionalFields: ['timestamp', 'sequence_number'],
    dependencies: []
  }
};
