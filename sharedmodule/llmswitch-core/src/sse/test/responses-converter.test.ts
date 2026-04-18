/**
 * Responses协议转换器测试
 * 测试JSON↔SSE双向转换功能的正确性
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { PassThrough } from 'node:stream';
import { ResponsesJsonToSseConverter, defaultResponsesJsonToSseConverter } from '../json-to-sse/index.js';
import { ResponsesSseToJsonConverter, defaultResponsesSseToJsonConverter } from '../sse-to-json/index.js';
import type { ResponsesResponse, ResponsesRequest } from '../../types/index.js';
import type { ResponsesSseEvent, ResponsesSseEventStream, ResponsesJsonToSseOptions, SseToResponsesJsonOptions } from '../types/index.js';

describe('Responses协议转换器测试', () => {
  let jsonToSseConverter: ResponsesJsonToSseConverter;
  let sseToJsonConverter: ResponsesSseToJsonConverter;

  beforeEach(() => {
    jsonToSseConverter = new ResponsesJsonToSseConverter();
    sseToJsonConverter = new ResponsesSseToJsonConverter();
  });

  afterEach(() => {
    // 清理资源
  });

  describe('JSON → SSE 转换', () => {
    it('应该转换基本的文本响应', async () => {
      const response: ResponsesResponse = {
        id: 'resp_123',
        object: 'response',
        created: Date.now(),
        status: 'completed',
        model: 'gpt-4o-mini',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30
        },
        output: [{
          type: 'message',
          id: 'msg_123',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: 'Hello, world!'
          }]
        }]
      };

      const options: ResponsesJsonToSseOptions = {
        requestId: 'test-req-123',
        chunkSize: 5,
        enableHeartbeat: false
      };

      const sseStream = await jsonToSseConverter.convertResponseToJsonToSse(response, options);
      const events = await collectSseEvents(sseStream);

      const eventTypes = events.map(e => e.type);
      expect(eventTypes).toEqual(expect.arrayContaining([
        'response.created',
        'response.in_progress',
        'response.output_item.added',
        'response.content_part.added',
        'response.output_text.delta',
        'response.output_text.done',
        'response.content_part.done',
        'response.output_item.done',
        'response.completed',
        'response.done'
      ]));

      const createdEvent = events.find(e => e.type === 'response.created');
      expect(createdEvent).toBeDefined();
      expect(createdEvent!.data.response.id).toBe(response.id);

      const completedEvent = events.find(e => e.type === 'response.completed');
      expect(completedEvent).toBeDefined();
      expect(completedEvent!.data.response.id).toBe(response.id);
    });

    it('reasoning_text.delta 应该包含 content_index', async () => {
      const response: ResponsesResponse = {
        id: 'resp_reasoning_index',
        object: 'response',
        created: Date.now(),
        status: 'completed',
        model: 'gpt-4o-mini',
        usage: {
          prompt_tokens: 6,
          completion_tokens: 3,
          total_tokens: 9
        },
        output: [{
          type: 'reasoning',
          id: 'reasoning_idx_1',
          summary: [],
          content: [{
            type: 'reasoning_text',
            text: 'Step 1'
          }]
        }]
      };

      const options: ResponsesJsonToSseOptions = {
        requestId: 'test-req-reasoning-index',
        chunkSize: 4,
        enableHeartbeat: false,
        includeReasoning: true
      };

      const sseStream = await jsonToSseConverter.convertResponseToJsonToSse(response, options);
      const events = await collectSseEvents(sseStream);

      const reasoningEvent = events.find(e => e.type === 'response.reasoning_text.delta');
      expect(reasoningEvent).toBeDefined();
      expect(reasoningEvent!.data.content_index).toBe(0);
    });

    it('response.created/in_progress 不应携带完整 output（避免重复展示）', async () => {
      const response: ResponsesResponse = {
        id: 'resp_start_no_output',
        object: 'response',
        created: Date.now(),
        status: 'completed',
        model: 'gpt-4o-mini',
        usage: {
          prompt_tokens: 4,
          completion_tokens: 2,
          total_tokens: 6
        },
        output: [{
          type: 'reasoning',
          id: 'reasoning_start_1',
          summary: [],
          content: [{
            type: 'reasoning_text',
            text: 'Reasoning content'
          }]
        }, {
          type: 'message',
          id: 'msg_start_1',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: 'Answer'
          }]
        }]
      };

      const sseStream = await jsonToSseConverter.convertResponseToJsonToSse(response, {
        requestId: 'test-req-start-empty-output',
        chunkSize: 4,
        enableHeartbeat: false,
        includeReasoning: true
      });
      const events = await collectSseEvents(sseStream);

      const createdEvent = events.find(e => e.type === 'response.created');
      const inProgressEvent = events.find(e => e.type === 'response.in_progress');
      expect(createdEvent).toBeDefined();
      expect(inProgressEvent).toBeDefined();
      expect((createdEvent!.data.response.output || []).length).toBe(0);
      expect((inProgressEvent!.data.response.output || []).length).toBe(0);
    });

    it('显式 reasoning 输出存在时，不应再次从 message 内容提取重复 reasoning', async () => {
      const response: ResponsesResponse = {
        id: 'resp_reasoning_dedup',
        object: 'response',
        created: Date.now(),
        status: 'completed',
        model: 'gpt-4o-mini',
        usage: {
          prompt_tokens: 3,
          completion_tokens: 3,
          total_tokens: 6
        },
        output: [{
          type: 'reasoning',
          id: 'reasoning_dedup_1',
          summary: [],
          content: [{
            type: 'reasoning_text',
            text: 'Step A'
          }]
        }, {
          type: 'message',
          id: 'msg_dedup_1',
          role: 'assistant',
          content: [{
            type: 'reasoning_text',
            text: 'Step A'
          }, {
            type: 'output_text',
            text: 'Done'
          }]
        }]
      };

      const sseStream = await jsonToSseConverter.convertResponseToJsonToSse(response, {
        requestId: 'test-req-reasoning-dedup',
        chunkSize: 8,
        enableHeartbeat: false,
        includeReasoning: true
      });
      const events = await collectSseEvents(sseStream);

      const reasoningDeltas = events.filter(e => e.type === 'response.reasoning_text.delta');
      expect(reasoningDeltas.length).toBe(1);
      expect(reasoningDeltas[0].data.delta).toContain('Step A');
    });

    it('应该转换带有工具调用的响应', async () => {
      const response: ResponsesResponse = {
        id: 'resp_456',
        object: 'response',
        created: Date.now(),
        status: 'completed',
        model: 'gpt-4o-mini',
        usage: {
          prompt_tokens: 15,
          completion_tokens: 25,
          total_tokens: 40
        },
        output: [{
          type: 'message',
          id: 'msg_456',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: 'I will call a function.'
          }]
        }, {
          type: 'function_call',
          id: 'func_456',
          name: 'get_weather',
          arguments: '{"location": "北京", "unit": "celsius"}'
        }]
      };

      const options: ResponsesJsonToSseOptions = {
        requestId: 'test-req-456',
        chunkSize: 10,
        enableHeartbeat: false
      };

      const sseStream = await jsonToSseConverter.convertResponseToJsonToSse(response, options);
      const events = await collectSseEvents(sseStream);

      // 应该包含所有必要的事件类型
      const eventTypes = events.map(e => e.type);
      expect(eventTypes).toContain('response.created');
      expect(eventTypes).toContain('response.in_progress');
      expect(eventTypes).toContain('response.content_part.added');
      expect(eventTypes).toContain('response.function_call_arguments.delta');
      expect(eventTypes).toContain('response.function_call_arguments.done');
      expect(eventTypes).toContain('response.completed');

      // 检查工具调用相关事件
      const functionCallDeltaEvents = events.filter(e => e.type === 'response.function_call_arguments.delta');
      expect(functionCallDeltaEvents.length).toBeGreaterThan(0);
    });

    it('应该正确处理带reasoning的响应', async () => {
      const response: ResponsesResponse = {
        id: 'resp_789',
        object: 'response',
        created: Date.now(),
        status: 'completed',
        model: 'gpt-4o-mini',
        usage: {
          prompt_tokens: 20,
          completion_tokens: 30,
          total_tokens: 50
        },
        output: [{
          type: 'message',
          id: 'msg_789',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: 'Final answer.'
          }]
        }]
      };

      const options: ResponsesJsonToSseOptions = {
        requestId: 'test-req-789',
        chunkSize: 3,
        enableHeartbeat: false,
        includeReasoning: true
      };

      const sseStream = await jsonToSseConverter.convertResponseToJsonToSse(response, options);
      const events = await collectSseEvents(sseStream);

      const reasoningEvents = events.filter(e => e.type === 'response.reasoning_text.delta');
      if (reasoningEvents.length > 0) {
        expect(reasoningEvents[0].data.delta).toBe('Thinking about the problem...\n');
      }
    });

    it('应该正确处理required_action状态', async () => {
      const response: ResponsesResponse = {
        id: 'resp_required',
        object: 'response',
        created: Date.now(),
        status: 'requires_action',
        model: 'gpt-4o-mini',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 15,
          total_tokens: 25
        },
        output: [{
          type: 'function_call',
          id: 'func_required',
          name: 'get_user_data',
          arguments: '{"user_id": "123"}'
        }]
      };

      const options: ResponsesJsonToSseOptions = {
        requestId: 'test-req-required',
        chunkSize: 5,
        enableHeartbeat: false
      };

      const sseStream = await jsonToSseConverter.convertResponseToJsonToSse(response, options);
      const events = await collectSseEvents(sseStream);

      const requiredActionEvent = events.find(e => e.type === 'response.required_action');
      expect(requiredActionEvent).toBeDefined();
      expect(requiredActionEvent!.data.type).toBe('submit_tool_outputs');
      expect(requiredActionEvent!.data.submit_tool_outputs.tool_calls).toHaveLength(1);
    });

    it('应该容忍缺少 reasoning.content 的响应', async () => {
      const response = {
        id: 'resp_reasoning_only',
        object: 'response',
        created: Date.now(),
        status: 'requires_action',
        model: 'gpt-4o-mini',
        usage: {
          prompt_tokens: 5,
          completion_tokens: 7,
          total_tokens: 12
        },
        output: [{
          type: 'reasoning',
          id: 'reason_1',
          summary: [{
            type: 'summary_text',
            text: 'Reasoning summary only'
          }]
          // content is intentionally omitted
        }]
      } as unknown as ResponsesResponse;

      const options: ResponsesJsonToSseOptions = {
        requestId: 'test-req-reasoning-only',
        enableHeartbeat: false
      };

      const sseStream = await jsonToSseConverter.convertResponseToJsonToSse(response, options);
      const events = await collectSseEvents(sseStream);

      const eventTypes = events.map(e => e.type);
      expect(eventTypes).toEqual(expect.arrayContaining([
        'response.created',
        'response.in_progress',
        'response.output_item.added',
        'response.completed',
        'response.done'
      ]));
      expect(eventTypes).not.toContain('error');
    });
  });


  describe('SSE → JSON 转换', () => {
    it('应该聚合基本响应事件', async () => {
      const events: ResponsesSseEvent[] = [
        {
          type: 'response.created',
          timestamp: new Date().toISOString(),
          data: {
            response: {
              id: 'resp_agg_1',
              object: 'response',
              created: Date.now(),
              status: 'in_progress',
              model: 'gpt-4o-mini'
            }
          }
        },
        {
          type: 'response.output_item.added',
          timestamp: new Date().toISOString(),
          data: {
            item: {
              index: 0,
              type: 'message',
              id: 'msg_agg_1',
              role: 'assistant',
              content: []
            }
          }
        },
        {
          type: 'response.content_part.added',
          timestamp: new Date().toISOString(),
          data: {
            item_index: 0,
            part: {
              type: 'output_text',
              text: ''
            }
          }
        },
        {
          type: 'response.content_part.done',
          timestamp: new Date().toISOString(),
          data: {
            item_index: 0,
            part: {
              type: 'output_text',
              text: 'Hello, world!'
            }
          }
        },
        {
          type: 'response.completed',
          timestamp: new Date().toISOString(),
          data: {
            response: {
              id: 'resp_agg_1',
              status: 'completed',
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15
              }
            }
          }
        }
      ];

      const sseStream = createSseStream(events);
      const options: SseToResponsesJsonOptions = {
        enableValidation: true
      };

      const response = await sseToJsonConverter.convertSseToJson(sseStream, options);

      expect(response.id).toBe('resp_agg_1');
      expect(response.status).toBe('completed');
      expect(response.output).toHaveLength(1);
      expect(response.output[0].type).toBe('message');
      expect(response.output[0].content).toHaveLength(1);
      expect(response.output[0].content[0].text).toBe('Hello, world!');
    });

    it('应该聚合工具调用事件', async () => {
      const events: ResponsesSseEvent[] = [
        {
          type: 'response.created',
          timestamp: new Date().toISOString(),
          data: {
            response: {
              id: 'resp_tool_1',
              object: 'response',
              created: Date.now(),
              status: 'in_progress',
              model: 'gpt-4o-mini'
            }
          }
        },
        {
          type: 'response.output_item.added',
          timestamp: new Date().toISOString(),
          data: {
            item: {
              index: 1,
              type: 'function_call',
              id: 'func_tool_1',
              name: 'get_weather',
              arguments: ''
            }
          }
        },
        {
          type: 'response.function_call_arguments.delta',
          timestamp: new Date().toISOString(),
          data: {
            item_index: 1,
            delta: '{"location":'
          }
        },
        {
          type: 'response.function_call_arguments.delta',
          timestamp: new Date().toISOString(),
          data: {
            item_index: 1,
            delta: '"北京","unit":"celsius"}'
          }
        },
        {
          type: 'response.function_call_arguments.done',
          timestamp: new Date().toISOString(),
          data: {
            item_index: 1,
            arguments: '{"location":"北京","unit":"celsius"}'
          }
        },
        {
          type: 'response.completed',
          timestamp: new Date().toISOString(),
          data: {
            response: {
              id: 'resp_tool_1',
              status: 'completed',
              usage: {
                prompt_tokens: 15,
                completion_tokens: 20,
                total_tokens: 35
              }
            }
          }
        }
      ];

      const sseStream = createSseStream(events);
      const options: SseToResponsesJsonOptions = {
        enableValidation: true
      };

      const response = await sseToJsonConverter.convertSseToJson(sseStream, options);

      expect(response.id).toBe('resp_tool_1');
      expect(response.output).toHaveLength(1);
      expect(response.output[0].type).toBe('function_call');
      expect(response.output[0].name).toBe('get_weather');
      expect(response.output[0].arguments).toBe('{"location":"北京","unit":"celsius"}');
    });

    it('应该正确处理reasoning事件', async () => {
      const events: ResponsesSseEvent[] = [
        {
          type: 'response.created',
          timestamp: new Date().toISOString(),
          data: {
            response: {
              id: 'resp_reasoning_1',
              object: 'response',
              created: Date.now(),
              status: 'in_progress',
              model: 'gpt-4o-mini'
            }
          }
        },
        {
          type: 'response.reasoning_text.delta',
          timestamp: new Date().toISOString(),
          data: {
            delta: 'First, I need to analyze '
          }
        },
        {
          type: 'response.reasoning_text.delta',
          timestamp: new Date().toISOString(),
          data: {
            delta: 'the problem carefully.\n'
          }
        },
        {
          type: 'response.reasoning_text.done',
          timestamp: new Date().toISOString(),
          data: {
            reasoning: 'First, I need to analyze the problem carefully.\n'
          }
        },
        {
          type: 'response.completed',
          timestamp: new Date().toISOString(),
          data: {
            response: {
              id: 'resp_reasoning_1',
              status: 'completed',
              usage: {
                prompt_tokens: 20,
                completion_tokens: 10,
                total_tokens: 30
              }
            }
          }
        }
      ];

      const sseStream = createSseStream(events);
      const options: SseToResponsesJsonOptions = {
        enableValidation: true
      };

      const response = await sseToJsonConverter.convertSseToJson(sseStream, options);

      expect(response.id).toBe('resp_reasoning_1');
      expect(response.status).toBe('completed');
    });

    it('显式reasoning存在时不应从消息内容再拆分reasoning', async () => {
      const events: ResponsesSseEvent[] = [
        {
          type: 'response.created',
          timestamp: new Date().toISOString(),
          data: {
            response: {
              id: 'resp_reasoning_dup',
              object: 'response',
              created: Date.now(),
              status: 'in_progress',
              model: 'gpt-4o-mini'
            }
          }
        },
        {
          type: 'response.output_item.added',
          timestamp: new Date().toISOString(),
          data: {
            item: {
              index: 0,
              type: 'reasoning',
              id: 'reasoning_dup_1'
            }
          }
        },
        {
          type: 'response.reasoning_summary_text.delta',
          timestamp: new Date().toISOString(),
          data: {
            item_id: 'reasoning_dup_1',
            output_index: 0,
            summary_index: 0,
            delta: 'Summary '
          }
        },
        {
          type: 'response.reasoning_summary_text.done',
          timestamp: new Date().toISOString(),
          data: {
            item_id: 'reasoning_dup_1',
            output_index: 0,
            summary_index: 0,
            text: 'Summary text'
          }
        },
        {
          type: 'response.output_item.added',
          timestamp: new Date().toISOString(),
          data: {
            item: {
              index: 1,
              type: 'message',
              id: 'msg_dup_1',
              role: 'assistant'
            }
          }
        },
        {
          type: 'response.content_part.added',
          timestamp: new Date().toISOString(),
          data: {
            item_id: 'msg_dup_1',
            output_index: 1,
            content_index: 0,
            part: {
              type: 'output_text',
              text: '<think>secret</think>Visible'
            }
          }
        },
        {
          type: 'response.content_part.done',
          timestamp: new Date().toISOString(),
          data: {
            item_id: 'msg_dup_1',
            output_index: 1,
            content_index: 0,
            part: {
              type: 'output_text',
              text: '<think>secret</think>Visible'
            }
          }
        },
        {
          type: 'response.completed',
          timestamp: new Date().toISOString(),
          data: {
            response: {
              id: 'resp_reasoning_dup',
              status: 'completed',
              usage: {
                prompt_tokens: 4,
                completion_tokens: 2,
                total_tokens: 6
              }
            }
          }
        }
      ];

      const sseStream = createSseStream(events);
      const options: SseToResponsesJsonOptions = {
        enableValidation: true
      };

      const response = await sseToJsonConverter.convertSseToJson(sseStream, options);

      const reasoningItems = response.output.filter(item => item.type === 'reasoning');
      expect(reasoningItems).toHaveLength(1);

      const message = response.output.find(item => item.type === 'message') as any;
      expect(message).toBeDefined();
      expect(message.content?.[0]?.text).toBe('Visible');
    });

    it('reasoning_text.delta 重复 content_index 时应合并为单段文本', async () => {
      const events: ResponsesSseEvent[] = [
        {
          type: 'response.created',
          timestamp: new Date().toISOString(),
          data: {
            response: {
              id: 'resp_reasoning_merge',
              object: 'response',
              created: Date.now(),
              status: 'in_progress',
              model: 'gpt-4o-mini'
            }
          }
        },
        {
          type: 'response.output_item.added',
          timestamp: new Date().toISOString(),
          data: {
            item_id: 'reason_merge_1',
            item: {
              index: 0,
              type: 'reasoning',
              id: 'reason_merge_1',
              summary: []
            }
          }
        },
        {
          type: 'response.reasoning_text.delta',
          timestamp: new Date().toISOString(),
          data: {
            item_id: 'reason_merge_1',
            content_index: 0,
            delta: 'Planning to update '
          }
        },
        {
          type: 'response.reasoning_text.delta',
          timestamp: new Date().toISOString(),
          data: {
            item_id: 'reason_merge_1',
            content_index: 0,
            delta: 'Planning to update the command list.'
          }
        },
        {
          type: 'response.completed',
          timestamp: new Date().toISOString(),
          data: {
            response: {
              id: 'resp_reasoning_merge',
              status: 'completed',
              usage: {
                prompt_tokens: 6,
                completion_tokens: 3,
                total_tokens: 9
              }
            }
          }
        }
      ];

      const sseStream = createSseStream(events);
      const options: SseToResponsesJsonOptions = {
        enableValidation: true
      };

      const response = await sseToJsonConverter.convertSseToJson(sseStream, options);
      const reasoning = (response.output || []).find((item) => item.type === 'reasoning') as any;
      expect(reasoning).toBeDefined();
      expect(reasoning.content).toHaveLength(1);
      expect(reasoning.content[0].text).toBe('Planning to update the command list.');
    });

    it('应该保留reasoning的encrypted_content', async () => {
      const events: ResponsesSseEvent[] = [
        {
          type: 'response.created',
          timestamp: new Date().toISOString(),
          data: {
            response: {
              id: 'resp_reasoning_enc',
              object: 'response',
              created: Date.now(),
              status: 'in_progress',
              model: 'gpt-4o-mini'
            }
          }
        },
        {
          type: 'response.output_item.added',
          timestamp: new Date().toISOString(),
          data: {
            item: {
              index: 0,
              type: 'reasoning',
              id: 'reasoning_1',
              encrypted_content: 'enc_payload'
            }
          }
        },
        {
          type: 'response.reasoning_summary_text.delta',
          timestamp: new Date().toISOString(),
          data: {
            item_id: 'reasoning_1',
            output_index: 0,
            summary_index: 0,
            delta: 'Summary '
          }
        },
        {
          type: 'response.reasoning_summary_text.done',
          timestamp: new Date().toISOString(),
          data: {
            item_id: 'reasoning_1',
            output_index: 0,
            summary_index: 0,
            text: 'Summary text'
          }
        },
        {
          type: 'response.completed',
          timestamp: new Date().toISOString(),
          data: {
            response: {
              id: 'resp_reasoning_enc',
              status: 'completed',
              usage: {
                prompt_tokens: 3,
                completion_tokens: 2,
                total_tokens: 5
              }
            }
          }
        }
      ];

      const sseStream = createSseStream(events);
      const options: SseToResponsesJsonOptions = {
        enableValidation: true
      };

      const response = await sseToJsonConverter.convertSseToJson(sseStream, options);

      expect(response.id).toBe('resp_reasoning_enc');
      const reasoning = response.output.find(item => item.type === 'reasoning') as any;
      expect(reasoning).toBeDefined();
      expect(reasoning.encrypted_content).toBe('enc_payload');
      expect(reasoning.summary).toEqual(['Summary text']);
    });

    it('应该处理required_action状态', async () => {
      const events: ResponsesSseEvent[] = [
        {
          type: 'response.created',
          timestamp: new Date().toISOString(),
          data: {
            response: {
              id: 'resp_required_1',
              object: 'response',
              created: Date.now(),
              status: 'in_progress',
              model: 'gpt-4o-mini'
            }
          }
        },
        {
          type: 'response.required_action',
          timestamp: new Date().toISOString(),
          data: {
            type: 'submit_tool_outputs',
            submit_tool_outputs: {
              tool_calls: [{
                id: 'func_required_1',
                type: 'function',
                function: {
                  name: 'get_user_data',
                  arguments: '{"user_id": "123"}'
                }
              }]
            }
          }
        }
      ];

      const sseStream = createSseStream(events);
      const options: SseToResponsesJsonOptions = {
        enableValidation: true
      };

      const response = await sseToJsonConverter.convertSseToJson(sseStream, options);

      expect(response.id).toBe('resp_required_1');
      expect(response.status).toBe('requires_action');
    });
  });

  describe('回环测试', () => {
    it('应该通过回环测试保持数据完整性', async () => {
      const originalResponse: ResponsesResponse = {
        id: 'resp_roundtrip',
        object: 'response',
        created: Date.now(),
        status: 'completed',
        model: 'gpt-4o-mini',
        usage: {
          prompt_tokens: 25,
          completion_tokens: 35,
          total_tokens: 60
        },
        output: [{
          type: 'message',
          id: 'msg_roundtrip',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text: 'This is a comprehensive response that includes multiple types of content.'
          }]
        }, {
          type: 'function_call',
          id: 'func_roundtrip',
          name: 'calculate',
          arguments: '{"expression": "2+2"}'
        }]
      };

      // JSON → SSE
      const sseStream = await jsonToSseConverter.convertResponseToJsonToSse(originalResponse, {
        requestId: 'roundtrip-test',
        chunkSize: 3,
        enableHeartbeat: false
      });

      // SSE → JSON
      const reconstructedResponse = await sseToJsonConverter.convertSseToJson(sseStream, {
        enableValidation: true
      });

      // 验证关键字段保持不变
      expect(reconstructedResponse.id).toBe(originalResponse.id);
      expect(reconstructedResponse.object).toBe(originalResponse.object);
      expect(reconstructedResponse.status).toBe(originalResponse.status);
      expect(reconstructedResponse.model).toBe(originalResponse.model);
      expect(reconstructedResponse.output).toHaveLength(originalResponse.output.length);

      // 验证消息内容
      const messageOutput = reconstructedResponse.output.find(o => o.type === 'message');
      const originalMessage = originalResponse.output.find(o => o.type === 'message');
      expect(messageOutput?.content[0].text).toBe(originalMessage?.content[0].text);

      // 验证工具调用
      const funcOutput = reconstructedResponse.output.find(o => o.type === 'function_call');
      const originalFunc = originalResponse.output.find(o => o.type === 'function_call');
      expect(funcOutput?.name).toBe(originalFunc?.name);
      expect(funcOutput?.arguments).toBe(originalFunc?.arguments);
    });
  });

  describe('错误处理', () => {
    it('应该在缺少completed/done但有增量文本时返回incomplete', async () => {
      const now = Date.now();
      const sseFrames = [
        `event: response.created\ndata: ${JSON.stringify({
          response: {
            id: 'partial_1',
            object: 'response',
            created: now,
            status: 'in_progress',
            model: 'gpt-4o-mini'
          }
        })}\n\n`,
        `event: response.output_item.added\ndata: ${JSON.stringify({
          item_id: 'msg_partial_1',
          output_index: 0,
          item: {
            id: 'msg_partial_1',
            type: 'message',
            status: 'in_progress',
            role: 'assistant'
          }
        })}\n\n`,
        `event: response.content_part.added\ndata: ${JSON.stringify({
          item_id: 'msg_partial_1',
          output_index: 0,
          content_index: 0,
          part: {
            type: 'output_text',
            text: ''
          }
        })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({
          item_id: 'msg_partial_1',
          output_index: 0,
          content_index: 0,
          delta: 'partial response text'
        })}\n\n`
      ];

      const sseStream = createSseWireTextStream(sseFrames);
      const response = await sseToJsonConverter.convertSseToJson(sseStream, { enableValidation: true });

      expect(response.status).toBe('incomplete');
      const message = response.output.find(item => item.type === 'message');
      expect(message).toBeDefined();
      expect((message as any)?.content?.[0]?.text).toContain('partial response text');
    });

    it('应该在缺少completed/done但function_call参数已完整时返回incomplete', async () => {
      const now = Date.now();
      const sseFrames = [
        `event: response.created\ndata: ${JSON.stringify({
          response: {
            id: 'partial_fc_1',
            object: 'response',
            created: now,
            status: 'in_progress',
            model: 'gpt-4o-mini'
          }
        })}\n\n`,
        `event: response.output_item.added\ndata: ${JSON.stringify({
          item_id: 'fc_partial_1',
          output_index: 0,
          item: {
            id: 'fc_partial_1',
            type: 'function_call',
            status: 'in_progress',
            call_id: 'call_partial_1',
            name: 'echo'
          }
        })}\n\n`,
        `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({
          item_id: 'fc_partial_1',
          output_index: 0,
          delta: '{"message":"partial tool call"}'
        })}\n\n`
      ];

      const sseStream = createSseWireTextStream(sseFrames);
      const response = await sseToJsonConverter.convertSseToJson(sseStream, { enableValidation: true });

      expect(response.status).toBe('incomplete');
      const functionCall = response.output.find(item => item.type === 'function_call') as any;
      expect(functionCall).toBeDefined();
      expect(functionCall.name).toBe('echo');
      expect(functionCall.arguments).toBe('{"message":"partial tool call"}');
    });

    it('应该处理无效的事件序列', async () => {
      const invalidEvents: ResponsesSseEvent[] = [
        {
          type: 'response.created',
          timestamp: new Date().toISOString(),
          data: {
            response: {
              id: 'invalid_1',
              object: 'response',
              created: Date.now(),
              status: 'in_progress',
              model: 'gpt-4o-mini'
            }
          }
        },
        // 缺少必要的completed事件
      ];

      const sseStream = createSseStream(invalidEvents);

      await expect(
        sseToJsonConverter.convertSseToJson(sseStream, { enableValidation: true })
      ).rejects.toThrow();
    });

    it('应该处理无效的响应数据', async () => {
      const invalidResponse = {
        // 缺少必要的字段
        id: 'invalid_resp'
      } as any;

      await expect(
        jsonToSseConverter.convertResponseToJsonToSse(invalidResponse, { requestId: 'test' })
      ).rejects.toThrow();
    });
  });
});

/**
 * 辅助函数：收集SSE事件流
 */
async function collectSseEvents(stream: ResponsesSseEventStream): Promise<ResponsesSseEvent[]> {
  const events: ResponsesSseEvent[] = [];

  for await (const event of stream) {
    events.push(event);

    // 检查是否完成
    if (event.type === 'response.completed' || event.type === 'response.done') {
      break;
    }
  }

  return events;
}

/**
 * 辅助函数：创建SSE事件流
 */
function createSseStream(events: ResponsesSseEvent[]): ResponsesSseEventStream {
  const passThrough = new PassThrough({
    objectMode: true
  });

  // 模拟异步事件流
  setTimeout(() => {
    events.forEach((event, index) => {
      setTimeout(() => {
        passThrough.write(event);
        if (index === events.length - 1) {
          passThrough.end();
        }
      }, index * 10);
    });
  }, 10);

  return passThrough;
}

function createSseWireTextStream(frames: string[]): ResponsesSseEventStream {
  const passThrough = new PassThrough();

  setTimeout(() => {
    frames.forEach((frame, index) => {
      setTimeout(() => {
        passThrough.write(frame);
        if (index === frames.length - 1) {
          passThrough.end();
        }
      }, index * 10);
    });
  }, 10);

  return passThrough as unknown as ResponsesSseEventStream;
}
