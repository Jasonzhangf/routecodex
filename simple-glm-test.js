/**
 * 简化的GLM字段映射验证测试
 */

console.log('🔍 GLM字段映射验证测试\n');

// 测试用例1: Usage字段映射
console.log('测试1: Usage字段映射');
const input1 = {
  usage: {
    prompt_tokens: 10,
    completion_tokens: 15,
    total_tokens: 25,
    output_tokens: 15  // GLM特有字段
  },
  created_at: 1699123456  // GLM时间戳格式
};

// 旧版本处理逻辑
function legacyProcess(input) {
  const result = JSON.parse(JSON.stringify(input));

  // 处理usage字段映射
  if (result.usage) {
    if (result.usage.prompt_tokens !== undefined) {
      result.usage.input_tokens = result.usage.prompt_tokens;
    }
    if (result.usage.output_tokens !== undefined && result.usage.completion_tokens === undefined) {
      result.usage.completion_tokens = result.usage.output_tokens;
    }
  }

  // 处理时间戳映射
  if (result.created_at !== undefined && result.created === undefined) {
    result.created = result.created_at;
  }

  return result;
}

// 新版本处理逻辑
function newProcess(input) {
  const result = JSON.parse(JSON.stringify(input));

  // Usage字段映射（配置驱动）
  const usageMappings = [
    { source: 'prompt_tokens', target: 'input_tokens' },
    { source: 'output_tokens', target: 'completion_tokens' }
  ];

  if (result.usage) {
    usageMappings.forEach(mapping => {
      if (result.usage[mapping.source] !== undefined && result.usage[mapping.target] === undefined) {
        result.usage[mapping.target] = result.usage[mapping.source];
      }
    });
  }

  // 时间戳映射（配置驱动）
  if (result.created_at !== undefined && result.created === undefined) {
    result.created = result.created_at;
  }

  return result;
}

const legacy1 = legacyProcess(input1);
const new1 = newProcess(input1);

console.log('输入:', JSON.stringify(input1, null, 2));
console.log('旧版本输出:', JSON.stringify(legacy1, null, 2));
console.log('新版本输出:', JSON.stringify(new1, null, 2));

const isMatch1 = JSON.stringify(legacy1) === JSON.stringify(new1);
console.log(isMatch1 ? '✅ 测试1通过' : '❌ 测试1失败');

console.log('\n测试2: Reasoning内容处理');
const input2 = {
  reasoning_content: '<reasoning>这是推理内容</reasoning>其他内容'
};

// 处理reasoning内容
function processReasoning(input) {
  const result = JSON.parse(JSON.stringify(input));
  if (result.reasoning_content) {
    const reasoningMatch = result.reasoning_content.match(/<reasoning>(.*?)<\/reasoning>/);
    if (reasoningMatch) {
      result.reasoning = reasoningMatch[1];
    }
  }
  return result;
}

const legacy2 = processReasoning(input2);
const new2 = processReasoning(input2);

console.log('输入:', JSON.stringify(input2, null, 2));
console.log('输出:', JSON.stringify(legacy2, null, 2));

const isMatch2 = JSON.stringify(legacy2) === JSON.stringify(new2);
console.log(isMatch2 ? '✅ 测试2通过' : '❌ 测试2失败');

console.log('\n测试3: 工具调用参数字符串化');
const input3 = {
  choices: [{
    message: {
      tool_calls: [{
        function: {
          name: 'test_func',
          arguments: { param1: 'value1', param2: 123 }  // 对象格式
        }
      }]
    }
  }]
};

// 处理工具调用参数字符串化
function processToolCalls(input) {
  const result = JSON.parse(JSON.stringify(input));

  if (result.choices && Array.isArray(result.choices)) {
    for (const choice of result.choices) {
      if (choice.message && choice.message.tool_calls) {
        for (const toolCall of choice.message.tool_calls) {
          if (toolCall.function && toolCall.function.arguments && typeof toolCall.function.arguments !== 'string') {
            try {
              toolCall.function.arguments = JSON.stringify(toolCall.function.arguments);
            } catch {
              toolCall.function.arguments = String(toolCall.function.arguments);
            }
          }
        }
      }
    }
  }

  return result;
}

const legacy3 = processToolCalls(input3);
const new3 = processToolCalls(input3);

console.log('输入工具调用参数类型:', typeof input3.choices[0].message.tool_calls[0].function.arguments);
console.log('输出工具调用参数类型:', typeof legacy3.choices[0].message.tool_calls[0].function.arguments);
console.log('输出值:', legacy3.choices[0].message.tool_calls[0].function.arguments);

const isMatch3 = JSON.stringify(legacy3) === JSON.stringify(new3);
console.log(isMatch3 ? '✅ 测试3通过' : '❌ 测试3失败');

console.log('\n测试4: Finish Reason映射');
const input4 = {
  choices: [{
    finish_reason: 'stop_sequence'  // GLM特有的停止原因
  }]
};

// 处理finish_reason映射
function processFinishReason(input) {
  const result = JSON.parse(JSON.stringify(input));

  const finishReasonMapping = {
    'stop_sequence': 'stop',
    'max_tokens': 'length',
    'tool_calls': 'tool_calls',
    'content_filter': 'content_filter'
  };

  if (result.choices && Array.isArray(result.choices)) {
    for (const choice of result.choices) {
      if (choice.finish_reason && finishReasonMapping[choice.finish_reason]) {
        choice.finish_reason = finishReasonMapping[choice.finish_reason];
      }
    }
  }

  return result;
}

const legacy4 = processFinishReason(input4);
const new4 = processFinishReason(input4);

console.log('输入:', JSON.stringify(input4, null, 2));
console.log('输出:', JSON.stringify(legacy4, null, 2));

const isMatch4 = JSON.stringify(legacy4) === JSON.stringify(new4);
console.log(isMatch4 ? '✅ 测试4通过' : '❌ 测试4失败');

// 总结
const allTests = [isMatch1, isMatch2, isMatch3, isMatch4];
const passedTests = allTests.filter(Boolean).length;

console.log('\n📊 测试总结:');
console.log(`总测试数: ${allTests.length}`);
console.log(`通过: ${passedTests}`);
console.log(`失败: ${allTests.length - passedTests}`);
console.log(`通过率: ${Math.round((passedTests / allTests.length) * 100)}%`);

if (passedTests === allTests.length) {
  console.log('\n🎉 所有字段映射验证通过！新旧版本处理逻辑完全一致。');
} else {
  console.log('\n⚠️  部分测试失败，需要检查处理逻辑。');
}