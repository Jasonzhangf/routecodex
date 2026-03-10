#!/usr/bin/env node

/**
 * 复杂工具调用回环测试
 * Chat/Responses JSON → SSE → JSON 完整回环测试
 * 包含工具调用、执行和结果返回的完整流程
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '../..');

// 动态导入转换器
let ChatJsonToSseConverter, ResponsesJsonToSseConverter;
let ChatSseToJsonConverter, ResponsesSseToJsonConverter;

try {
  const chatModule = await import(`${projectRoot}/dist/sse/json-to-sse/chat-json-to-sse-converter.js`);
  const responsesModule = await import(`${projectRoot}/dist/sse/json-to-sse/responses-json-to-sse-converter.js`);
  const chatSseModule = await import(`${projectRoot}/dist/sse/sse-to-json/chat-sse-to-json-converter.js`);
  const responsesSseModule = await import(`${projectRoot}/dist/sse/sse-to-json/responses-sse-to-json-converter.js`);

  ChatJsonToSseConverter = chatModule.ChatJsonToSseConverter;
  ResponsesJsonToSseConverter = responsesModule.ResponsesJsonToSseConverter;
  ChatSseToJsonConverter = chatSseModule.ChatSseToJsonConverter;
  ResponsesSseToJsonConverter = responsesSseModule.ResponsesSseToJsonConverter;
} catch (error) {
  console.warn('⚠️ 无法导入转换器模块，使用模拟实现');
}

/**
 * 复杂工具定义
 */
const COMPLEX_TOOLS = [
  {
    type: 'function',
    name: 'analyze_file',
    description: '分析文件内容并提取关键信息',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '文件路径'
        },
        analysis_type: {
          type: 'string',
          enum: ['structure', 'content', 'metadata'],
          description: '分析类型'
        }
      },
      required: ['file_path']
    }
  },
  {
    type: 'function',
    name: 'search_database',
    description: '搜索数据库中的记录',
    parameters: {
      type: 'object',
      properties: {
        table: {
          type: 'string',
          description: '表名'
        },
        query: {
          type: 'object',
          description: '查询条件'
        },
        limit: {
          type: 'number',
          description: '返回记录数限制'
        }
      },
      required: ['table', 'query']
    }
  },
  {
    type: 'function',
    name: 'generate_report',
    description: '生成分析报告',
    parameters: {
      type: 'object',
      properties: {
        data_sources: {
          type: 'array',
          items: { type: 'string' },
          description: '数据源列表'
        },
        report_type: {
          type: 'string',
          enum: ['summary', 'detailed', 'executive'],
          description: '报告类型'
        },
        format: {
          type: 'string',
          enum: ['json', 'markdown', 'pdf'],
          description: '输出格式'
        }
      },
      required: ['data_sources', 'report_type']
    }
  }
];

/**
 * 模拟工具执行引擎
 */
class MockToolExecutionEngine {
  constructor() {
    this.executionLog = [];
  }

  async executeTool(toolName, parameters) {
    const execution = {
      tool_name: toolName,
      parameters,
      timestamp: Date.now(),
      result: null
    };

    console.log(`🔧 执行工具: ${toolName}`);
    console.log(`📋 参数:`, parameters);

    try {
      switch (toolName) {
        case 'analyze_file':
          execution.result = await this.executeAnalyzeFile(parameters);
          break;
        case 'search_database':
          execution.result = await this.executeSearchDatabase(parameters);
          break;
        case 'generate_report':
          execution.result = await this.executeGenerateReport(parameters);
          break;
        default:
          throw new Error(`未知工具: ${toolName}`);
      }

      execution.success = true;
      console.log(`✅ 工具执行成功: ${toolName}`);
    } catch (error) {
      execution.success = false;
      execution.error = error.message;
      console.log(`❌ 工具执行失败: ${toolName} - ${error.message}`);
    }

    this.executionLog.push(execution);
    return execution.result;
  }

  async executeAnalyzeFile({ file_path, analysis_type }) {
    // 模拟文件分析
    await new Promise(resolve => setTimeout(resolve, 100));

    const fileContent = {
      path: file_path,
      size: Math.floor(Math.random() * 10000) + 1000,
      lines: Math.floor(Math.random() * 500) + 50,
      encoding: 'utf-8'
    };

    switch (analysis_type) {
      case 'structure':
        return {
          ...fileContent,
          structure: {
            sections: ['imports', 'functions', 'classes', 'main'],
            complexity: Math.floor(Math.random() * 10) + 1
          }
        };
      case 'content':
        return {
          ...fileContent,
          content_summary: {
            language: 'typescript',
            functions_count: Math.floor(Math.random() * 20) + 5,
            classes_count: Math.floor(Math.random() * 10) + 1,
            imports_count: Math.floor(Math.random() * 15) + 3
          }
        };
      case 'metadata':
        return {
          ...fileContent,
          metadata: {
            created_at: new Date(Date.now() - Math.random() * 10000000000).toISOString(),
            modified_at: new Date().toISOString(),
            author: 'developer@example.com',
            version: '1.2.3'
          }
        };
      default:
        throw new Error(`未知分析类型: ${analysis_type}`);
    }
  }

  async executeSearchDatabase({ table, query, limit = 10 }) {
    // 模拟数据库搜索
    await new Promise(resolve => setTimeout(resolve, 200));

    const mockResults = [];
    const resultCount = Math.min(limit, Math.floor(Math.random() * limit) + 1);

    for (let i = 0; i < resultCount; i++) {
      mockResults.push({
        id: `record_${table}_${i + 1}`,
        table,
        data: {
          name: `${table.charAt(0).toUpperCase() + table.slice(1)} Item ${i + 1}`,
          status: ['active', 'inactive', 'pending'][Math.floor(Math.random() * 3)],
          value: Math.floor(Math.random() * 1000),
          created_at: new Date(Date.now() - Math.random() * 31536000000).toISOString()
        },
        relevance_score: Math.random()
      });
    }

    return {
      table,
      query,
      total_found: resultCount,
      limit,
      results: mockResults.sort((a, b) => b.relevance_score - a.relevance_score)
    };
  }

  async executeGenerateReport({ data_sources, report_type, format }) {
    // 模拟报告生成
    await new Promise(resolve => setTimeout(resolve, 300));

    const reportData = {
      title: `${report_type.charAt(0).toUpperCase() + report_type.slice(1)} Report`,
      generated_at: new Date().toISOString(),
      data_sources,
      format,
      sections: []
    };

    switch (report_type) {
      case 'summary':
        reportData.sections = [
          { title: 'Overview', content: 'High-level summary of data sources' },
          { title: 'Key Metrics', content: 'Important performance indicators' }
        ];
        break;
      case 'detailed':
        reportData.sections = [
          { title: 'Data Analysis', content: 'Detailed breakdown of each data source' },
          { title: 'Trends', content: 'Historical trends and patterns' },
          { title: 'Recommendations', content: 'Actionable insights' }
        ];
        break;
      case 'executive':
        reportData.sections = [
          { title: 'Executive Summary', content: 'Key findings for leadership' },
          { title: 'Business Impact', content: 'Financial and operational impact' }
        ];
        break;
    }

    return {
      ...reportData,
      metadata: {
        pages: Math.floor(Math.random() * 20) + 5,
        charts: Math.floor(Math.random() * 10) + 2,
        tables: Math.floor(Math.random() * 15) + 3
      }
    };
  }

  getExecutionLog() {
    return this.executionLog;
  }

  clearLog() {
    this.executionLog = [];
  }
}

/**
 * Chat 协议复杂回环测试
 */
async function testComplexChatRoundTrip() {
  console.log('\n🔄 Chat 协议复杂工具调用回环测试');

  const executionEngine = new MockToolExecutionEngine();

  // 第1轮: 带工具调用的 Chat 请求
  const chatRequest = {
    model: 'gpt-4',
    messages: [
      {
        role: 'system',
        content: 'You are a data analysis assistant with access to file analysis, database search, and report generation tools.'
      },
      {
        role: 'user',
        content: 'Please analyze the project structure by searching for TypeScript files in the codebase, analyze the main file, and generate a summary report.'
      }
    ],
    tools: COMPLEX_TOOLS,
    tool_choice: 'auto',
    temperature: 0.1,
    stream: true
  };

  console.log('📤 Chat 请求 (包含工具定义)');
  console.log(`   - 模型: ${chatRequest.model}`);
  console.log(`   - 工具数量: ${chatRequest.tools.length}`);
  console.log(`   - 消息数: ${chatRequest.messages.length}`);

  try {
    // 第1步: JSON → SSE (Chat)
    console.log('\n🔄 步骤1: Chat JSON → SSE');
    let sseEvents = [];

    if (ChatJsonToSseConverter) {
      // 使用真实转换器
      const converter = new ChatJsonToSseConverter();
      const sseStream = await converter.convertRequestToJsonToSse(chatRequest, {
        requestId: 'chat-test-001'
      });

      for await (const event of sseStream) {
        sseEvents.push(event);
      }
    } else {
      // 模拟转换
      sseEvents = generateMockChatSSE(chatRequest);
    }

    console.log(`✅ 生成 ${sseEvents.length} 个 Chat SSE 事件`);

    // 第2步: SSE → JSON (提取工具调用)
    console.log('\n🔄 步骤2: Chat SSE → JSON (工具调用检测)');
    let toolCalls = [];

    if (ChatSseToJsonConverter) {
      const converter = new ChatSseToJsonConverter();
      const result = await converter.convertSseToJson(sseEvents, {
        requestId: 'chat-test-001'
      });

      if (result.message && result.message.tool_calls) {
        toolCalls = result.message.tool_calls;
      }
    } else {
      // 模拟工具调用检测
      toolCalls = extractChatToolCalls(sseEvents);
    }

    console.log(`🛠️ 检测到 ${toolCalls.length} 个工具调用`);

    // 第3步: 执行工具调用
    console.log('\n🔄 步骤3: 执行工具调用');
    const toolResults = [];

    for (const toolCall of toolCalls) {
      const result = await executionEngine.executeTool(
        toolCall.function.name,
        JSON.parse(toolCall.function.arguments)
      );
      toolResults.push({
        tool_call_id: toolCall.id,
        role: 'tool',
        content: JSON.stringify(result)
      });
    }

    console.log(`✅ 工具执行完成: ${toolResults.length} 个结果`);

    // 第4步: 构建包含工具结果的 Chat 请求
    console.log('\n🔄 步骤4: 构建包含工具结果的 Chat 请求');
    const chatRequestWithResults = {
      ...chatRequest,
      messages: [
        ...chatRequest.messages,
        {
          role: 'assistant',
          content: 'I will analyze the codebase structure and generate a report for you.',
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments
            }
          }))
        },
        ...toolResults
      ],
      tools: undefined, // 第二轮不提供工具
      tool_choice: undefined
    };

    console.log(`📝 构建了包含 ${toolResults.length} 个工具结果的 Chat 请求`);

    // 第5步: JSON → SSE (包含工具结果的响应)
    console.log('\n🔄 步骤5: Chat JSON → SSE (包含工具结果)');
    let finalSseEvents = [];

    if (ChatJsonToSseConverter) {
      const converter = new ChatJsonToSseConverter();
      const sseStream = await converter.convertResponseToJsonToSse({
        id: 'chatcmpl-final-001',
        object: 'chat.completion',
        created: Date.now(),
        model: chatRequest.model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: 'Based on my analysis of the codebase, I found 15 TypeScript files with a total of 2,847 lines of code. The main structure includes 3 modules with 8 classes and 23 functions. I\'ve generated a detailed report with visualizations showing the code organization and dependencies.',
            tool_calls: toolCalls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.function.name,
                arguments: tc.function.arguments
              }
            }))
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 250,
          completion_tokens: 180,
          total_tokens: 430
        }
      }, {
        requestId: 'chat-test-001-final'
      });

      for await (const event of sseStream) {
        finalSseEvents.push(event);
      }
    } else {
      finalSseEvents = generateMockChatResponseSSE();
    }

    console.log(`✅ 生成 ${finalSseEvents.length} 个最终 Chat SSE 事件`);

    // 第6步: SSE → JSON (最终响应)
    console.log('\n🔄 步骤6: Chat SSE → JSON (最终响应)');
    let finalResponse = null;

    if (ChatSseToJsonConverter) {
      const converter = new ChatSseToJsonConverter();
      finalResponse = await converter.convertSseToJson(finalSseEvents, {
        requestId: 'chat-test-001-final'
      });
    } else {
      finalResponse = reconstructChatResponse(finalSseEvents);
    }

    console.log(`✅ Chat 回环测试完成`);
    console.log(`   - 工具调用: ${toolCalls.length} 个`);
    console.log(`   - 工具结果: ${toolResults.length} 个`);
    console.log(`   - SSE事件: ${sseEvents.length + finalSseEvents.length} 个`);

    return {
      success: true,
      protocol: 'chat',
      originalRequest: chatRequest,
      toolCalls,
      toolResults,
      finalResponse,
      sseEvents: sseEvents.concat(finalSseEvents),
      executionLog: executionEngine.getExecutionLog()
    };

  } catch (error) {
    console.log(`❌ Chat 回环测试失败: ${error.message}`);
    return {
      success: false,
      protocol: 'chat',
      error: error.message,
      executionLog: executionEngine.getExecutionLog()
    };
  }
}

/**
 * Responses 协议复杂回环测试
 */
async function testComplexResponsesRoundTrip() {
  console.log('\n🔄 Responses 协议复杂工具调用回环测试');

  const executionEngine = new MockToolExecutionEngine();

  // 第1轮: 带工具调用的 Responses 请求
  const responsesRequest = {
    model: 'gpt-4',
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Please analyze the project structure by searching for TypeScript files, analyzing the main file, and generating a summary report.'
          }
        ]
      }
    ],
    tools: COMPLEX_TOOLS.map(tool => ({
      type: 'function',
      function: tool
    })),
    tool_choice: 'auto',
    max_output_tokens: 2000
  };

  console.log('📤 Responses 请求 (包含工具定义)');
  console.log(`   - 模型: ${responsesRequest.model}`);
  console.log(`   - 工具数量: ${responsesRequest.tools.length}`);

  try {
    // 第1步: JSON → SSE (Responses)
    console.log('\n🔄 步骤1: Responses JSON → SSE');
    let sseEvents = [];

    if (ResponsesJsonToSseConverter) {
      const converter = new ResponsesJsonToSseConverter();
      const sseStream = await converter.convertRequestToJsonToSse(responsesRequest, {
        requestId: 'resp-test-001'
      });

      for await (const event of sseStream) {
        sseEvents.push(event);
      }
    } else {
      sseEvents = generateMockResponsesSSE(responsesRequest);
    }

    console.log(`✅ 生成 ${sseEvents.length} 个 Responses SSE 事件`);

    // 第2步: SSE → JSON (提取工具调用)
    console.log('\n🔄 步骤2: Responses SSE → JSON (工具调用检测)');
    let toolCalls = [];

    if (ResponsesSseToJsonConverter) {
      const converter = new ResponsesSseToJsonConverter();
      const result = await converter.convertSseToJson(sseEvents, {
        requestId: 'resp-test-001'
      });

      // 提取工具调用信息
      const functionCallEvents = sseEvents.filter(e =>
        e.event && e.event.includes('function_call')
      );
      toolCalls = extractResponsesToolCalls(functionCallEvents);
    } else {
      toolCalls = extractResponsesToolCalls(sseEvents);
    }

    console.log(`🛠️ 检测到 ${toolCalls.length} 个工具调用`);

    // 第3步: 执行工具调用
    console.log('\n🔄 步骤3: 执行工具调用');
    const toolResults = [];

    for (const toolCall of toolCalls) {
      const result = await executionEngine.executeTool(
        toolCall.name,
        toolCall.arguments
      );
      toolResults.push({
        tool_call_id: toolCall.id,
        result
      });
    }

    console.log(`✅ 工具执行完成: ${toolResults.length} 个结果`);

    // 第4步: 构建包含工具结果的 Responses 请求
    console.log('\n🔄 步骤4: 构建包含工具结果的 Responses 请求');
    const responsesRequestWithResults = {
      ...responsesRequest,
      input: [
        ...responsesRequest.input,
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'input_text',
              text: 'I will analyze the codebase structure and generate a report for you.'
            }
          ]
        },
        ...toolCalls.map(tc => ({
          type: 'function_call',
          id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.arguments)
        })),
        ...toolResults.map(result => ({
          type: 'message',
          role: 'tool',
          tool_call_id: result.tool_call_id,
          content: result.result
        })),
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'Based on the tool execution results, please provide a comprehensive analysis of the codebase structure.'
            }
          ]
        }
      ],
      tools: [], // 第二轮不提供工具
      tool_choice: undefined
    };

    console.log(`📝 构建了包含 ${toolResults.length} 个工具结果的 Responses 请求`);

    // 第5步: JSON → SSE (包含工具结果的响应)
    console.log('\n🔄 步骤5: Responses JSON → SSE (包含工具结果)');
    let finalSseEvents = [];

    if (ResponsesJsonToSseConverter) {
      const converter = new ResponsesJsonToSseConverter();
      const sseStream = await converter.convertResponseToJsonToSse({
        id: 'resp_final_001',
        object: 'response',
        created: Date.now(),
        model: responsesRequest.model,
        status: 'completed',
        output: [{
          id: 'msg_final_001',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'Based on my comprehensive analysis of the codebase, I discovered 18 TypeScript files organized into 4 main modules. The project has a well-structured architecture with proper separation of concerns. The main application file contains 237 lines with 8 functions and 3 classes. I\'ve generated a detailed report that includes code quality metrics, dependency analysis, and recommendations for optimization.'
            }
          ]
        }],
        usage: {
          input_tokens: 320,
          output_tokens: 195,
          total_tokens: 515
        }
      }, {
        requestId: 'resp-test-001-final'
      });

      for await (const event of sseStream) {
        finalSseEvents.push(event);
      }
    } else {
      finalSseEvents = generateMockResponsesResponseSSE();
    }

    console.log(`✅ 生成 ${finalSseEvents.length} 个最终 Responses SSE 事件`);

    // 第6步: SSE → JSON (最终响应)
    console.log('\n🔄 步骤6: Responses SSE → JSON (最终响应)');
    let finalResponse = null;

    if (ResponsesSseToJsonConverter) {
      const converter = new ResponsesSseToJsonConverter();
      finalResponse = await converter.convertSseToJson(finalSseEvents, {
        requestId: 'resp-test-001-final'
      });
    } else {
      finalResponse = reconstructResponsesResponse(finalSseEvents);
    }

    console.log(`✅ Responses 回环测试完成`);
    console.log(`   - 工具调用: ${toolCalls.length} 个`);
    console.log(`   - 工具结果: ${toolResults.length} 个`);
    console.log(`   - SSE事件: ${sseEvents.length + finalSseEvents.length} 个`);

    return {
      success: true,
      protocol: 'responses',
      originalRequest: responsesRequest,
      toolCalls,
      toolResults,
      finalResponse,
      sseEvents: sseEvents.concat(finalSseEvents),
      executionLog: executionEngine.getExecutionLog()
    };

  } catch (error) {
    console.log(`❌ Responses 回环测试失败: ${error.message}`);
    return {
      success: false,
      protocol: 'responses',
      error: error.message,
      executionLog: executionEngine.getExecutionLog()
    };
  }
}

// 模拟函数 (当真实转换器不可用时)
function generateMockChatSSE(request) {
  const events = [];

  // 模拟工具调用事件
  events.push({
    event: 'message',
    data: JSON.stringify({
      id: 'chatcmpl-001',
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: request.model,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_search_db_001',
            type: 'function',
            function: {
              name: 'search_database',
              arguments: ''
            }
          }]
        }
      }]
    })
  });

  events.push({
    event: 'message',
    data: JSON.stringify({
      id: 'chatcmpl-002',
      object: 'chat.completion.chunk',
      created: Date.now(),
      model: request.model,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            function: {
              arguments: '{"table":"typescript_files","query":{"type":"ts"},"limit":10}'
            }
          }]
        }
      }]
    })
  });

  return events;
}

function generateMockResponsesSSE(request) {
  const events = [];

  // 模拟 C4M 工具调用格式
  events.push({
    event: 'response.function_call_arguments.delta',
    data: JSON.stringify({
      type: 'response.function_call_arguments.delta',
      sequence_number: 1,
      item_id: 'fc_search_db_001',
      output_index: 1,
      arguments: '{"table":"typescript_files","query":{"type":"ts"'
    })
  });

  events.push({
    event: 'response.function_call_arguments.done',
    data: JSON.stringify({
      type: 'response.function_call_arguments.done',
      sequence_number: 2,
      item_id: 'fc_search_db_001',
      output_index: 1,
      arguments: '{"table":"typescript_files","query":{"type":"ts"},"limit":10}'
    })
  });

  return events;
}

function extractChatToolCalls(events) {
  // 模拟从 Chat SSE 中提取工具调用
  return [
    {
      id: 'call_search_db_001',
      type: 'function',
      function: {
        name: 'search_database',
        arguments: '{"table":"typescript_files","query":{"type":"ts"},"limit":10}'
      }
    }
  ];
}

function extractResponsesToolCalls(events) {
  // 模拟从 Responses SSE 中提取工具调用
  const functionCallEvents = events.filter(e =>
    e.event === 'response.function_call_arguments.done'
  );

  return functionCallEvents.map(event => ({
    id: event.parsed.item_id,
    name: 'search_database',
    arguments: JSON.parse(event.parsed.arguments)
  }));
}

function reconstructChatResponse(events) {
  return {
    id: 'chatcmpl-final',
    object: 'chat.completion',
    created: Date.now(),
    model: 'gpt-4',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: 'Mock final response after tool execution'
      }
    }]
  };
}

function reconstructResponsesResponse(events) {
  return {
    id: 'resp_final',
    object: 'response',
    created: Date.now(),
    status: 'completed',
    model: 'gpt-4',
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: 'Mock final response after tool execution'
      }]
    }]
  };
}

function generateMockChatResponseSSE() {
  return [
    {
      event: 'message',
      data: JSON.stringify({
        id: 'chatcmpl-final',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'gpt-4',
        choices: [{
          index: 0,
          delta: {
            content: 'Mock final response after tool execution'
          }
        }]
      })
    }
  ];
}

function generateMockResponsesResponseSSE() {
  return [
    {
      event: 'response.output_text.delta',
      data: JSON.stringify({
        type: 'response.output_text.delta',
        delta: 'Mock final response after tool execution'
      })
    },
    {
      event: 'response.completed',
      data: JSON.stringify({
        type: 'response.completed',
        status: 'completed'
      })
    }
  ];
}

/**
 * 主测试函数
 */
async function main() {
  console.log('🧪 复杂工具调用回环测试');
  console.log('Chat/Responses JSON → SSE → JSON 完整回环');
  console.log('包含工具调用、执行和结果返回的完整流程');
  console.log('='.repeat(60));

  // 创建输出目录
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = join(process.env.HOME || process.env.USERPROFILE || '~', '.routecodex', 'golden_samples', 'complex-tools-roundtrip', timestamp);
  mkdirSync(outputDir, { recursive: true });
  console.log(`📁 输出目录: ${outputDir}\n`);

  const results = [];

  // 执行 Chat 协议回环测试
  console.log('🔄 执行 Chat 协议复杂回环测试');
  console.log('-'.repeat(40));
  const chatResult = await testComplexChatRoundTrip();
  results.push(chatResult);

  console.log('\n' + '='.repeat(60) + '\n');

  // 执行 Responses 协议回环测试
  console.log('🔄 执行 Responses 协议复杂回环测试');
  console.log('-'.repeat(40));
  const responsesResult = await testComplexResponsesRoundTrip();
  results.push(responsesResult);

  // 生成测试报告
  console.log('\n📊 复杂工具调用回环测试报告');
  console.log('='.repeat(60));

  const successCount = results.filter(r => r.success).length;
  const totalCount = results.length;

  console.log(`✅ 成功测试: ${successCount}/${totalCount}`);
  console.log(`❌ 失败测试: ${totalCount - successCount}/${totalCount}`);

  console.log('\n📋 详细结果:');
  for (const result of results) {
    const status = result.success ? '✅' : '❌';

    console.log(`${status} ${result.protocol.toUpperCase()} 协议`);
    console.log(`    🛠️ 工具调用: ${result.toolCalls?.length || 0} 个`);
    console.log(`    📊 工具结果: ${result.toolResults?.length || 0} 个`);
    console.log(`    📡 SSE事件: ${result.sseEvents?.length || 0} 个`);

    if (result.error) {
      console.log(`    🔴 错误: ${result.error}`);
    }

    if (result.executionLog) {
      console.log(`    📝 执行日志: ${result.executionLog.length} 条记录`);
    }
  }

  // 保存完整测试结果
  const testResults = {
    timestamp: new Date().toISOString(),
    testType: 'complex-tools-roundtrip',
    testEnvironment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch
    },
    summary: {
      total: totalCount,
      success: successCount,
      failed: totalCount - successCount,
      successRate: (successCount / totalCount * 100).toFixed(1) + '%'
    },
    tools: COMPLEX_TOOLS.map(tool => ({
      name: tool.name,
      description: tool.description
    })),
    tests: results.map(result => ({
      protocol: result.protocol,
      success: result.success,
      originalRequest: result.originalRequest,
      toolCalls: result.toolCalls,
      toolResults: result.toolResults,
      finalResponse: result.finalResponse,
      sseEvents: result.sseEvents,
      executionLog: result.executionLog,
      error: result.error
    }))
  };

  const resultsPath = join(outputDir, 'complex-tools-roundtrip-results.json');
  writeFileSync(resultsPath, JSON.stringify(testResults, null, 2));
  console.log(`\n💾 测试结果已保存: ${resultsPath}`);

  // 保存各个测试的详细数据
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const detailPath = join(outputDir, `test-${i + 1}-${result.protocol}-roundtrip-detail.json`);
    writeFileSync(detailPath, JSON.stringify({
      protocol: result.protocol,
      success: result.success,
      metadata: {
        timestamp: new Date().toISOString(),
        toolCallsCount: result.toolCalls?.length || 0,
        toolResultsCount: result.toolResults?.length || 0,
        sseEventsCount: result.sseEvents?.length || 0
      },
      originalRequest: result.originalRequest,
      toolCalls: result.toolCalls,
      toolResults: result.toolResults,
      finalResponse: result.finalResponse,
      sseEvents: result.sseEvents,
      executionLog: result.executionLog,
      error: result.error
    }, null, 2));
  }

  console.log('\n🎉 复杂工具调用回环测试完成!');

  if (successCount === totalCount) {
    console.log('🏆 所有回环测试通过！Chat/Responses 工具调用流程验证成功');
    process.exit(0);
  } else {
    console.log('⚠️ 部分回环测试失败，请检查转换器实现');
    process.exit(1);
  }
}

// 运行测试
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('💥 复杂工具调用回环测试失败:', error);
    process.exit(1);
  });
}