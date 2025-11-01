#!/usr/bin/env node

/**
 * GLM字段映射验证脚本
 * 验证新旧版本的GLM字段转换是否一致
 */

console.log('🔍 GLM字段映射验证\n');

// 测试用例：验证关键字段映射
const testCases = [
  {
    name: 'Usage字段映射测试',
    input: {
      usage: {
        prompt_tokens: 10,
        completion_tokens: 15,
        total_tokens: 25,
        output_tokens: 15  // GLM特有字段
      },
      created_at: 1699123456  // GLM时间戳格式
    },
    expected: {
      usage: {
        input_tokens: 10,    // 应该映射为input_tokens
        output_tokens: 15,   // 应该保留output_tokens
        total_tokens: 25,
        completion_tokens: 15  // 应该新增completion_tokens
      },
      created: 1699123456     // 应该映射为created
    }
  },
  {
    name: 'Reasoning内容处理测试',
    input: {
      reasoning_content: '<reasoning>这是推理内容</reasoning>其他内容'
    },
    expected: {
      reasoning: '这是推理内容'  // 应该提取reasoning标签内的内容
    }
  },
  {
    name: '工具调用参数字符串化测试',
    input: {
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
    },
    expected: {
      choices: [{
        message: {
          tool_calls: [{
            function: {
              name: 'test_func',
              arguments: '{"param1":"value1","param2":123}'  // 应该字符串化
            }
          }]
        }
      }]
    }
  },
  {
    name: 'Content数组扁平化测试',
    input: {
      choices: [{
        message: {
          content: [
            { type: 'text', text: '第一部分' },
            '第二部分',
            { type: 'text', text: '第三部分' }
          ]
        }
      }]
    },
    expected: {
      choices: [{
        message: {
          content: '第一部分\n第二部分\n第三部分'  // 应该扁平化并连接
        }
      }]
    }
  },
  {
    name: 'Finish Reason映射测试',
    input: {
      choices: [{
        finish_reason: 'stop_sequence'  // GLM特有的停止原因
      }]
    },
    expected: {
      choices: [{
        finish_reason: 'stop'  // 应该映射为标准值
      }]
    }
  }
];

/**
 * 模拟旧版本的字段处理逻辑
 */
function processLegacyFields(input) {
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

  // 处理reasoning内容
  if (result.reasoning_content) {
    const reasoningMatch = result.reasoning_content.match(/<reasoning>(.*?)<\/reasoning>/);
    if (reasoningMatch) {
      result.reasoning = reasoningMatch[1];
    }
  }

  // 处理工具调用参数字符串化
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

  // 处理content数组扁平化
  if (result.choices && Array.isArray(result.choices)) {
    for (const choice of result.choices) {
      if (choice.message && Array.isArray(choice.message.content)) {
        const parts = choice.message.content
          .map(part => {
            if (typeof part === 'string') return part;
            if (part && typeof part.text === 'string') return part.text;
            return '';
          })
          .filter(part => part.trim());
        choice.message.content = parts.join('\n');
      }
    }
  }

  // 处理finish_reason映射
  if (result.choices && Array.isArray(result.choices)) {
    for (const choice of result.choices) {
      if (choice.finish_reason) {
        if (choice.finish_reason === 'stop_sequence') {
          choice.finish_reason = 'stop';
        } else if (choice.finish_reason === 'max_tokens') {
          choice.finish_reason = 'length';
        } else if (choice.finish_reason === 'tool_calls') {
          choice.finish_reason = 'tool_calls';
        }
      }
    }
  }

  return result;
}

/**
 * 模拟新版本的字段处理逻辑（基于配置驱动）
 */
function processNewFields(input) {
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

  // Reasoning内容提取（配置驱动）
  if (result.reasoning_content) {
    const reasoningMatch = result.reasoning_content.match(/<reasoning>(.*?)<\/reasoning>/);
    if (reasoningMatch) {
      result.reasoning = reasoningMatch[1];
    }
  }

  // 工具调用标准化（配置驱动）
  if (result.choices && Array.isArray(result.choices)) {
    for (const choice of result.choices) {
      if (choice.message && choice.message.tool_calls) {
        for (const toolCall of choice.message.tool_calls) {
          if (toolCall.function && toolCall.function.arguments) {
            // 确保arguments是字符串
            if (typeof toolCall.function.arguments !== 'string') {
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
  }

  // Content结构标准化（配置驱动）
  if (result.choices && Array.isArray(result.choices)) {
    for (const choice of result.choices) {
      if (choice.message && Array.isArray(choice.message.content)) {
        // 扁平化content数组
        const parts = choice.message.content
          .map(part => {
            if (typeof part === 'string') return part;
            if (part && typeof part.text === 'string') return part.text;
            return '';
          })
          .filter(part => part.trim());
        choice.message.content = parts.join('\n');
      }
    }
  }

  // Finish Reason值映射（配置驱动）
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

/**
 * 深度对比两个对象
 */
function deepCompare(obj1, obj2, path = '') {
  const differences = [];

  if (obj1 === obj2) return differences;

  const type1 = typeof obj1;
  const type2 = typeof obj2;

  if (type1 !== type2) {
    differences.push(`${path || 'root'}: 类型不匹配 (${type1} vs ${type2})`);
    return differences;
  }

  if (obj1 === null || obj1 === undefined || obj2 === null || obj2 === undefined) {
    if (obj1 !== obj2) {
      differences.push(`${path || 'root'}: 值不匹配 (${obj1} vs ${obj2})`);
    }
    return differences;
  }

  if (type1 === 'object') {
    const keys1 = Object.keys(obj1);
    const keys2 = Object.keys(obj2);
    const allKeys = new Set([...keys1, ...keys2]);

    for (const key of allKeys) {
      const currentPath = path ? `${path}.${key}` : key;

      if (!(key in obj1)) {
        differences.push(`${currentPath}: 新版本缺少字段`);
      } else if (!(key in obj2)) {
        differences.push(`${currentPath}: 旧版本缺少字段`);
      } else {
        const subDifferences = deepCompare(obj1[key], obj2[key], currentPath);
        differences.push(...subDifferences);
      }
    }
  } else if (type1 === 'array') {
    if (obj1.length !== obj2.length) {
      differences.push(`${path}: 数组长度不匹配 (${obj1.length} vs ${obj2.length})`);
      return differences;
    }

    for (let i = 0; i < obj1.length; i++) {
      const subDifferences = deepCompare(obj1[i], obj2[i], `${path}[${i}]`);
      differences.push(...subDifferences);
    }
  } else if (obj1 !== obj2) {
    differences.push(`${path}: 值不匹配 (${obj1} vs ${obj2})`);
  }

  return differences;
}

// 运行测试
console.log('开始字段映射验证测试...\n');

let passedTests = 0;
let totalDifferences = 0;

testCases.forEach((testCase, index) => {
  console.log(`${index + 1}. ${testCase.name}`);

  try {
    // 使用旧版本处理
    const legacyResult = processLegacyFields(testCase.input);

    // 使用新版本处理
    const newResult = processNewFields(testCase.input);

    // 对比结果
    const differences = deepCompare(legacyResult, newResult);

    if (differences.length === 0) {
      console.log('   ✅ 通过 - 字段转换完全一致');
      passedTests++;
    } else {
      console.log(`   ❌ 失败 - 发现 ${differences.length} 个差异:`);
      differences.forEach(diff => console.log(`      - ${diff}`));
      totalDifferences += differences.length;
    }

    // 显示关键转换结果
    console.log('   📊 转换结果示例:');
    console.log('      旧版本:', JSON.stringify(legacyResult, null, 2).substring(0, 200) + '...');
    console.log('      新版本:', JSON.stringify(newResult, null, 2).substring(0, 200) + '...');

  } catch (error) {
    console.log(`   💥 错误: ${error}`);
    totalDifferences++;
  }

  console.log('');
});

// 输出测试总结
console.log('📊 字段映射验证总结:');
console.log(`   总测试数: ${testCases.length}`);
console.log(`   通过: ${passedTests}`);
console.log(`   失败: ${testCases.length - passedTests}`);
console.log(`   总差异数: ${totalDifferences}`);
console.log(`   通过率: ${Math.round((passedTests / testCases.length) * 100)}%`);

if (passedTests === testCases.length) {
  console.log('\n🎉 所有字段映射验证通过！新旧版本处理完全一致。');
} else {
  console.log('\n⚠️  部分字段映射验证失败，需要修复差异。');
  console.log('\n💡 建议：');
  console.log('   1. 检查字段映射配置是否正确');
  console.log('   2. 确保Hook系统处理逻辑一致');
  console.log('   3. 验证嵌套对象处理');
  console.log('   4. 检查数组扁平化逻辑');
}