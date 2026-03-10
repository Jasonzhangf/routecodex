#!/usr/bin/env node

/**
 * C4M工具调用测试脚本
 * 测试工具执行和二轮对话的完整流程
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

// 读取C4M配置和样本
const C4M_CONFIG = JSON.parse(readFileSync('/Users/fanzhang/.routecodex/provider/c4m/config.v1.json', 'utf8'));
const CODEX_SAMPLE = JSON.parse(readFileSync('/Users/fanzhang/.routecodex/codex-samples/openai-responses/req_1763733582430_c30ihldix_provider-request.json', 'utf8')).body;

// 提取配置信息
const C4M_SETTINGS = {
  baseURL: C4M_CONFIG.virtualrouter.providers.c4m.baseURL,
  apiKey: C4M_CONFIG.virtualrouter.providers.c4m.auth.apiKey,
  model: 'gpt-5.1'
};

console.log('🔧 C4M配置信息:');
console.log(`   - 基础URL: ${C4M_SETTINGS.baseURL}`);
console.log(`   - 模型: ${C4M_SETTINGS.model}`);

// HTTP请求工具
async function c4mRequest(url, body) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000); // 60秒超时

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'responses-2024-12-17',
        'Authorization': `Bearer ${C4M_SETTINGS.apiKey}`
      },
      body: JSON.stringify(body)
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorText}`);
    }

    return await response.text();
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('请求超时');
    }
    throw error;
  }
}

// 解析SSE事件流
function parseSSEEvents(sseData) {
  const lines = sseData.split('\n');
  const events = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('event:')) {
      const eventType = line.substring(6).trim();
      let data = '';
      i++; // 移动到data行

      // 查找data行
      while (i < lines.length && lines[i].startsWith('data:')) {
        data += lines[i].substring(5).trim();
        i++;
      }
      i--; // 回退一行，因为for循环会再++

      if (data === '[DONE]') {
        events.push({ event: eventType, data: '[DONE]', parsed: null });
      } else {
        try {
          events.push({ event: eventType, data, parsed: data ? JSON.parse(data) : null });
        } catch (error) {
          console.warn(`解析SSE事件失败: ${error.message}`);
          events.push({ event: eventType, data, parsed: null, error: error.message });
        }
      }
    }
  }

  return events;
}

// 从SSE事件重建响应对象
function reconstructResponseFromEvents(events) {
  if (events.length === 0) return null;

  // 查找response.created事件
  const createdEvent = events.find(e => e.parsed && e.parsed.id && e.event === 'response.created');
  if (!createdEvent) return null;

  const response = { ...createdEvent.parsed };

  // 查找response.completed事件
  const completedEvent = events.find(e => e.parsed && e.parsed.id === response.id && e.event === 'response.completed');
  if (completedEvent) {
    response.status = completedEvent.parsed.status;
    response.output = completedEvent.parsed.output;
    response.usage = completedEvent.parsed.usage;
  }

  // 查找response.done事件
  const doneEvent = events.find(e => e.parsed && e.parsed.id === response.id && e.event === 'response.done');
  if (doneEvent) {
    response.status = doneEvent.parsed.status;
    response.output = doneEvent.parsed.output;
    response.usage = doneEvent.parsed.usage;
  }

  return response;
}

// 分析工具调用
function analyzeToolCalls(events) {
  const toolCalls = events.filter(e =>
    e.event && e.event.includes('function_call')
  );

  const analysis = {
    toolCallCount: toolCalls.length,
    toolNames: [],
    functionCallEvents: [],
    functionCallDeltas: [],
    functionCallDoneEvents: []
  };

  for (const event of toolCalls) {
    analysis.functionCallEvents.push(event);

    if (event.event === 'response.function_call_arguments.delta') {
      analysis.functionCallDeltas.push(event);
    } else if (event.event === 'response.function_call_arguments.done') {
      analysis.functionCallDoneEvents.push(event);

      // 提取工具名称
      if (event.parsed && event.parsed.name) {
        analysis.toolNames.push(event.parsed.name);
      }
    }
  }

  return analysis;
}

// 定义模拟工具
const MOCK_TOOLS = [
  {
    type: 'function',
    name: 'get_current_time',
    description: '获取当前时间',
    parameters: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          description: '时间格式，如 iso, readable, timestamp',
          enum: ['iso', 'readable', 'timestamp']
        }
      },
      required: []
    }
  },
  {
    type: 'function',
    name: 'get_weather',
    description: '获取指定城市的天气信息',
    parameters: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: '城市名称'
        },
        unit: {
          type: 'string',
          description: '温度单位',
          enum: ['celsius', 'fahrenheit']
        }
      },
      required: ['city']
    }
  },
  {
    type: 'function',
    name: 'shell',
    description: '使用TOON: put arguments into arguments.toon as multi-line key: value (e.g., command / workdir).',
    parameters: {
      type: 'object',
      properties: {
        toon: {
          type: 'string',
          description: 'TOON-encoded arguments (multi-line key: value). Example: command: bash -lc "echo ok"\\nworkdir: .'
        }
      },
      required: ['toon'],
      additionalProperties: false
    }
  }
];

// 测试用例定义
const TOOL_TEST_CASES = [
  {
    name: 'C4M简单工具调用 - 获取当前时间',
    type: 'simple-tool',
    input: [
      { role: 'user', content: '请使用get_current_time工具获取当前时间，使用iso格式' }
    ],
    expectedToolCalls: 1,
    description: '测试单个工具调用的完整流程'
  },
  {
    name: 'C4M多工具调用 - 获取时间和天气',
    type: 'multi-tool',
    input: [
      { role: 'user', content: '请先使用get_current_time工具获取当前时间，然后使用get_weather工具获取北京的天气信息' }
    ],
    expectedToolCalls: 2,
    description: '测试多个工具调用的协调流程'
  },
  {
    name: 'C4M二轮对话 - 工具结果分析',
    type: 'two-round',
    input: [
      { role: 'user', content: '请使用get_weather工具获取上海的天气信息' }
    ],
    expectedToolCalls: 1,
    description: '测试工具调用后的二轮对话'
  }
];

// 执行工具调用测试
async function executeToolTest(testCase) {
  console.log(`\n🎯 开始测试: ${testCase.name}`);
  console.log(`📋 类型: ${testCase.type}`);
  console.log(`💬 输入消息: ${testCase.input.length}条`);
  console.log(`🛠️ 预期工具调用: ${testCase.expectedToolCalls}个`);

  const startTime = Date.now();
  let sseData = '';
  let responseError = null;
  let responseData = null;

  try {
    // 构建请求体，使用codex样本的完整结构
    const { max_tokens, temperature, ...filteredSample } = CODEX_SAMPLE;

    const requestBody = {
      ...filteredSample,
      model: C4M_SETTINGS.model,
      input: testCase.input.map(msg => ({
        type: 'message',
        role: msg.role,
        content: [
          {
            type: 'input_text',
            text: msg.content
          }
        ]
      })),
      stream: true,
      // 使用我们的模拟工具定义
      tools: MOCK_TOOLS,
      tool_choice: 'auto'
    };

    console.log(`🌐 请求URL: ${C4M_SETTINGS.baseURL}/responses`);
    console.log(`📝 请求模型: ${requestBody.model}`);

    // 发送请求并捕获SSE流
    const response = await fetch(`${C4M_SETTINGS.baseURL}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'responses-2024-12-17',
        'Authorization': `Bearer ${C4M_SETTINGS.apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      throw new Error(`请求失败: ${response.status} ${response.statusText}`);
    }

    // 捕获SSE流
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // 按双换行分割事件
        while (buffer.includes('\n\n')) {
          const eventEnd = buffer.indexOf('\n\n');
          const eventData = buffer.substring(0, eventEnd);
          buffer = buffer.substring(eventEnd + 2);

          if (eventData.trim()) {
            sseData += eventData + '\n\n';
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // 分析SSE事件
    const events = parseSSEEvents(sseData);
    responseData = reconstructResponseFromEvents(events);
    const toolAnalysis = analyzeToolCalls(events);

    const endTime = Date.now();
    const duration = endTime - startTime;

    console.log(`\n📊 测试结果:`);
    console.log(`⏱️ 总耗时: ${duration}ms`);
    console.log(`📡 捕获事件: ${events.length}`);
    console.log(`🛠️ 工具调用: ${toolAnalysis.toolCallCount}`);
    console.log(`📋 工具名称: ${toolAnalysis.toolNames.join(', ')}`);
    console.log(`✅ 响应状态: ${responseData?.status || '未知'}`);

    // 如果有工具调用，立即执行工具并返回结果给模型进行二轮对话
    if (toolAnalysis.toolCallCount > 0 && testCase.type !== 'two-round') {
      console.log(`\n🔧 检测到工具调用，执行工具并返回结果给模型...`);
      const toolResults = await executeToolCalls(toolAnalysis.functionCallDoneEvents);

      if (toolResults.length > 0) {
        console.log(`   📊 工具执行完成: ${toolResults.length} 个结果`);
        console.log(`   🔄 发送二轮对话给模型...`);

        // 构建包含工具结果的二轮对话请求
        const conversationHistory = [
          ...testCase.input,
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'input_text',
                text: '我将使用工具来帮您获取信息。'
              }
            ],
            // 添加工具调用信息
            ...(toolAnalysis.functionCallDoneEvents.map(event => ({
              type: 'function_call',
              id: event.parsed?.item_id || `call_${Date.now()}`,
              name: inferToolNameFromArgs(event.parsed?.arguments ? JSON.parse(event.parsed.arguments) : {}),
              arguments: event.parsed?.arguments || '{}'
            })))
          },
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
                text: '基于刚才的工具执行结果，请分析和解释得到的信息'
              }
            ]
          }
        ];

        // 发送二轮对话请求
        try {
          const { max_tokens, temperature, ...filteredSample } = CODEX_SAMPLE;
          const secondRoundRequest = {
            ...filteredSample,
            model: C4M_SETTINGS.model,
            input: conversationHistory,
            stream: true,
            tools: [], // 第二轮不提供工具
            tool_choice: 'auto'
          };

          console.log(`🌐 发送二轮对话请求`);
          const secondResponse = await fetch(`${C4M_SETTINGS.baseURL}/responses`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'OpenAI-Beta': 'responses-2024-12-17',
              'Authorization': `Bearer ${C4M_SETTINGS.apiKey}`
            },
            body: JSON.stringify(secondRoundRequest)
          });

          if (secondResponse.ok) {
            // 捕获二轮对话的SSE流
            const reader = secondResponse.body.getReader();
            const decoder = new TextDecoder();
            let secondSseData = '';
            let buffer = '';

            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });

                while (buffer.includes('\n\n')) {
                  const eventEnd = buffer.indexOf('\n\n');
                  const eventData = buffer.substring(0, eventEnd);
                  buffer = buffer.substring(eventEnd + 2);

                  if (eventData.trim()) {
                    secondSseData += eventData + '\n\n';
                  }
                }
              }
            } finally {
              reader.releaseLock();
            }

            const secondEvents = parseSSEEvents(secondSseData);
            const secondResponseData = reconstructResponseFromEvents(secondEvents);

            console.log(`✅ 二轮对话成功: ${secondEvents.length}个事件`);

            // 返回包含工具执行和二轮对话的完整结果
            return {
              success: true,
              testCase: testCase.name,
              type: testCase.type + '-complete',
              duration: Date.now() - startTime, // 包含二轮对话的总时长
              eventCount: events.length + secondEvents.length,
              sseData: sseData + '\n\n=== SECOND ROUND ===\n\n' + secondSseData,
              reconstructedResponse: secondResponseData,
              toolAnalysis,
              toolResults,
              request: requestBody,
              secondRoundRequest,
              error: responseError
            };
          } else {
            console.log(`❌ 二轮对话失败: ${secondResponse.status} ${secondResponse.statusText}`);
          }
        } catch (secondError) {
          console.log(`❌ 二轮对话异常: ${secondError.message}`);
        }
      }
    }

    return {
      success: true,
      testCase: testCase.name,
      type: testCase.type,
      duration,
      eventCount: events.length,
      sseData,
      reconstructedResponse: responseData,
      toolAnalysis,
      request: requestBody,
      error: responseError
    };

  } catch (error) {
    responseError = error.message;
    console.log(`❌ 测试失败: ${error.message}`);

    return {
      success: false,
      testCase: testCase.name,
      type: testCase.type,
      duration: Date.now() - startTime,
      eventCount: 0,
      sseData: sseData,
      reconstructedResponse: null,
      toolAnalysis: { toolCallCount: 0, toolNames: [], functionCallEvents: [], functionCallDeltas: [], functionCallDoneEvents: [] },
      request: null,
      error: responseError
    };
  }
}

// 执行工具调用并返回结果
async function executeToolCalls(toolCallEvents) {
  console.log(`\n🔧 执行工具调用，共 ${toolCallEvents.length} 个工具调用`);

  const toolResults = [];

  for (const toolCall of toolCallEvents) {
    if (toolCall.event === 'response.function_call_arguments.done' && toolCall.parsed) {
      // 解析工具调用信息 - C4M不直接提供工具名称，需要从参数推断
      const toolArgs = toolCall.parsed.arguments ? JSON.parse(toolCall.parsed.arguments) : {};
      const toolName = inferToolNameFromArgs(toolArgs);

      console.log(`   🛠️ 执行工具: ${toolName}`);
      console.log(`   📋 参数:`, toolArgs);

      let toolResult;
      try {
        // 执行模拟的工具调用
        toolResult = await executeMockTool(toolName, toolArgs);
        console.log(`   ✅ 工具执行成功: ${toolName}`);
      } catch (error) {
        toolResult = {
          success: false,
          error: error.message
        };
        console.log(`   ❌ 工具执行失败: ${toolName} - ${error.message}`);
      }

      toolResults.push({
        tool_call_id: toolCall.parsed.item_id || `call_${Date.now()}_${toolResults.length}`,
        tool_name: toolName,
        result: toolResult
      });
    }
  }

  return toolResults;
}

// 根据参数推断工具名称
function inferToolNameFromArgs(args) {
  if (args.format && !args.city && !args.toon) {
    // 只有format参数，且无city和toon，是时间工具
    return 'get_current_time';
  } else if (args.city) {
    // 有city参数，是天气工具
    return 'get_weather';
  } else if (args.toon) {
    // 有toon参数，是shell工具
    return 'shell';
  } else if (args.command && args.workdir) {
    // 有command和workdir参数，也是shell工具的另一种格式
    return 'shell';
  } else {
    return 'unknown';
  }
}

// 执行模拟工具调用
async function executeMockTool(toolName, args) {
  console.log(`   🎭 模拟执行工具: ${toolName}`);

  switch (toolName) {
    case 'get_current_time':
      const format = args.format || 'iso';
      let timeResult;

      switch (format) {
        case 'iso':
          timeResult = new Date().toISOString();
          break;
        case 'readable':
          timeResult = new Date().toLocaleString('zh-CN');
          break;
        case 'timestamp':
          timeResult = Date.now();
          break;
        default:
          timeResult = new Date().toISOString();
      }

      return {
        current_time: timeResult,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        format: format,
        executed_at: new Date().toISOString()
      };

    case 'get_weather':
      const city = args.city || '北京';
      const unit = args.unit || 'celsius';

      // 模拟天气数据
      const weatherData = {
        '北京': { temp: 15, weather: '晴', humidity: 45, wind: '北风3级' },
        '上海': { temp: 18, weather: '多云', humidity: 65, wind: '东风2级' },
        '广州': { temp: 25, weather: '小雨', humidity: 80, wind: '南风2级' },
        '深圳': { temp: 24, weather: '阴', humidity: 75, wind: '东南风2级' }
      };

      const cityWeather = weatherData[city] || { temp: 20, weather: '未知', humidity: 60, wind: '微风' };

      return {
        city: city,
        temperature: cityWeather.temp,
        unit: unit,
        weather: cityWeather.weather,
        humidity: cityWeather.humidity,
        wind: cityWeather.wind,
        update_time: new Date().toISOString(),
        source: '模拟天气服务'
      };

    case 'shell':
      // 解析TOON格式参数
      const toonStr = args.toon || '';
      console.log(`   🔍 解析TOON: ${toonStr}`);

      // 解析TOON格式: key1: value1\nkey2: value2
      const toonLines = toonStr.split('\n').filter(line => line.trim());
      const toonData = {};

      for (const line of toonLines) {
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
          const key = line.substring(0, colonIndex).trim();
          const value = line.substring(colonIndex + 1).trim();
          toonData[key] = value;
        }
      }

      console.log(`   📋 解析结果:`, toonData);

      // 提取命令和工作目录
      const command = toonData.command || 'echo "模拟命令执行"';
      const workdir = toonData.workdir || '.';

      // 模拟命令执行结果
      const mockOutputs = {
        'date': new Date().toString(),
        'date -Iseconds': new Date().toISOString(),
        'pwd': '/Users/fanzhang/Documents/github/sharedmodule',
        'ls': 'Documents\tDownloads\tMusic\nDocuments2\tProjects\tScripts',
        'whoami': 'fanzhang'
      };

      const output = mockOutputs[command] || `模拟执行命令: ${command}`;

      return {
        command,
        workdir,
        output: output,
        success: true,
        executed_at: new Date().toISOString(),
        simulated: true
      };

    default:
      throw new Error(`未知工具: ${toolName}`);
  }
}

// 执行二轮对话测试（基于工具调用结果）
async function executeSecondRoundConversation(firstRoundResult, testCase) {
  if (testCase.type !== 'two-round') return null;

  console.log(`\n🔄 开始二轮对话测试`);

  let sseData = '';

  try {
    // 执行工具调用并获取结果
    const toolCallEvents = firstRoundResult.toolAnalysis.functionCallDoneEvents;
    const toolResults = await executeToolCalls(toolCallEvents);

    console.log(`   📊 工具执行结果: ${toolResults.length} 个`);

    // 构建包含工具调用结果的对话历史 - 按照正确的Responses API格式
    const conversationHistory = [
      ...testCase.input,
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'input_text',
            text: '我将使用工具来帮您获取信息。'
          }
        ],
        // 添加工具调用信息
        ...(toolCallEvents.map(event => ({
          type: 'function_call',
          id: event.parsed?.item_id || `call_${Date.now()}`,
          name: inferToolNameFromArgs(event.parsed?.arguments ? JSON.parse(event.parsed.arguments) : {}),
          arguments: event.parsed?.arguments || '{}'
        })))
      },
      ...toolResults.map(result => ({
        type: 'message',
        role: 'tool',
        tool_call_id: result.tool_call_id,
        content: result.result // 直接使用工具执行结果，不JSON.stringify
      })),
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '基于刚才的工具执行结果，请分析和解释得到的信息'
          }
        ]
      }
    ];

    const { max_tokens, temperature, ...filteredSample } = CODEX_SAMPLE;

    const requestBody = {
      ...filteredSample,
      model: C4M_SETTINGS.model,
      input: conversationHistory,
      stream: true,
      tools: [], // 第二轮不提供工具
      tool_choice: 'auto'
    };

    const response = await fetch(`${C4M_SETTINGS.baseURL}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'responses-2024-12-17',
        'Authorization': `Bearer ${C4M_SETTINGS.apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      throw new Error(`二轮对话请求失败: ${response.status} ${response.statusText}`);
    }

    // 捕获二轮SSE流
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        while (buffer.includes('\n\n')) {
          const eventEnd = buffer.indexOf('\n\n');
          const eventData = buffer.substring(0, eventEnd);
          buffer = buffer.substring(eventEnd + 2);

          if (eventData.trim()) {
            sseData += eventData + '\n\n';
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const events = parseSSEEvents(sseData);
    const responseData = reconstructResponseFromEvents(events);

    console.log(`🔄 二轮对话完成，捕获 ${events.length} 个事件`);

    return {
      success: true,
      eventCount: events.length,
      sseData,
      reconstructedResponse: responseData
    };

  } catch (error) {
    console.log(`❌ 二轮对话失败: ${error.message}`);
    return null;
  }
}

// 保存测试结果
function saveTestResults(results, outputDir) {
  const timestamp = new Date().toISOString();
  const testResults = {
    timestamp,
    config: C4M_SETTINGS,
    testEnvironment: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch
    },
    summary: {
      total: results.length,
      success: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      successRate: ((results.filter(r => r.success).length / results.length) * 100).toFixed(1) + '%',
      avgDuration: Math.round(results.reduce((sum, r) => sum + r.duration, 0) / results.length),
      totalEvents: results.reduce((sum, r) => sum + r.eventCount, 0),
      totalToolCalls: results.reduce((sum, r) => sum + (r.toolAnalysis?.toolCallCount || 0), 0)
    },
    tests: results.map(result => ({
      name: result.testCase,
      type: result.type,
      success: result.success,
      duration: result.duration,
      eventCount: result.eventCount,
      toolCallCount: result.toolAnalysis?.toolCallCount || 0,
      toolNames: result.toolAnalysis?.toolNames || [],
      request: result.request,
      response: result.reconstructedResponse,
      events: parseSSEEvents(result.sseData),
      toolAnalysis: result.toolAnalysis,
      error: result.error
    }))
  };

  const resultsPath = join(outputDir, 'c4m-tools-test-results.json');
  writeFileSync(resultsPath, JSON.stringify(testResults, null, 2));

  // 保存每个测试的详细事件数据
  results.forEach((result, index) => {
    const eventsPath = join(outputDir, `test-${index + 1}-${result.testCase.replace(/\s+/g, '-')}-events.json`);
    writeFileSync(eventsPath, JSON.stringify({
      testName: result.testCase,
      testType: result.type,
      metadata: {
        timestamp: new Date().toISOString(),
        duration: result.duration,
        success: result.success,
        toolCallCount: result.toolCallCount || 0
      },
      request: result.request,
      response: result.reconstructedResponse,
      events: parseSSEEvents(result.sseData),
      toolAnalysis: result.toolAnalysis
    }, null, 2));
  });

  return resultsPath;
}

// 主测试函数
async function main() {
  console.log('🔧 C4M工具调用和二轮对话测试');
  console.log('='.repeat(60));

  console.log('\n🔧 配置信息:');
  console.log(`   - 模型: ${C4M_SETTINGS.model}`);
  console.log(`   - 服务地址: ${C4M_SETTINGS.baseURL}`);

  // 创建输出目录
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = join(process.env.HOME || process.env.USERPROFILE || '~', '.routecodex', 'golden_samples', 'c4m-tools', timestamp);
  mkdirSync(outputDir, { recursive: true });
  console.log(`📁 输出目录: ${outputDir}`);

  // 执行工具调用测试
  const results = [];

  for (const testCase of TOOL_TEST_CASES) {
    const result = await executeToolTest(testCase);
    results.push(result);

    // 如果是二轮对话测试，执行第二轮
    if (testCase.type === 'two-round' && result.success) {
      const secondRoundResult = await executeSecondRoundConversation(result, testCase);
      if (secondRoundResult) {
        result.secondRound = secondRoundResult;
      }
    }

    // 测试间隔
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

  // 生成测试报告
  console.log('\n📊 C4M工具调用测试报告');
  console.log('='.repeat(60));

  const successCount = results.filter(r => r.success).length;
  const totalCount = results.length;
  const totalToolCalls = results.reduce((sum, r) => sum + (r.toolAnalysis?.toolCallCount || 0), 0);

  console.log(`✅ 成功测试: ${successCount}/${totalCount}`);
  console.log(`❌ 失败测试: ${totalCount - successCount}/${totalCount}`);
  console.log(`🛠️ 工具调用总数: ${totalToolCalls}`);

  const avgDuration = results.reduce((sum, r) => sum + r.duration, 0) / totalCount;
  const totalEvents = results.reduce((sum, r) => sum + r.eventCount, 0);
  console.log(`⏱️ 平均耗时: ${Math.round(avgDuration)}ms`);
  console.log(`📡 总事件数: ${totalEvents}`);

  console.log('\n📋 详细结果:');
  for (const result of results) {
    const status = result.success ? '✅' : '❌';
    console.log(`${status} ${result.testCase}`);
    console.log(`    📊 事件: ${result.eventCount}, 耗时: ${result.duration}ms`);
    console.log(`    🛠️ 工具调用: ${result.toolAnalysis?.toolCallCount || 0}`);

    if (result.toolAnalysis?.toolNames?.length > 0) {
      console.log(`    🔧 工具: ${result.toolAnalysis.toolNames.join(', ')}`);
    }

    if (result.secondRound) {
      console.log(`    🔄 二轮对话: ${result.secondRound.success ? '✅' : '❌'} (${result.secondRound.eventCount}事件)`);
    }

    if (result.error) {
      console.log(`    🔴 错误: ${result.error}`);
    }
  }

  // 保存测试结果
  const resultsPath = saveTestResults(results, outputDir);
  console.log(`\n💾 测试结果已保存: ${resultsPath}`);

  console.log('\n🎉 C4M工具调用测试完成!');

  if (successCount === totalCount) {
    console.log('🏆 所有工具调用测试通过！');
    process.exit(0);
  } else {
    console.log('⚠️ 部分测试失败，请检查C4M工具配置');
    process.exit(1);
  }
}

// 运行测试
main().catch(error => {
  console.error('💥 C4M工具调用测试失败:', error);
  process.exit(1);
});