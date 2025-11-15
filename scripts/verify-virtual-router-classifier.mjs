#!/usr/bin/env node
/**
 * Virtual Router Classifier Verification
 *
 * 1) 验证协议检测是否符合 config/modules.json 中的配置
 * 2) 验证按协议的工具检测结果是否符合预期分类
 * 3) 验证按协议的 Token 估算结果与 ProtocolTokenCalculator 一致
 *
 * 仅依赖：
 * - dist/modules/virtual-router/classifiers/*.js
 * - config/modules.json 中的 virtualrouter.config.classificationConfig
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = process.cwd();

async function loadClassificationConfig() {
  const modulesPath = path.join(ROOT, 'config', 'modules.json');
  const raw = await fs.readFile(modulesPath, 'utf-8');
  const json = JSON.parse(raw);
  const cfg =
    json?.virtualrouter?.config?.classificationConfig ||
    json?.modules?.virtualrouter?.config?.classificationConfig;
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('virtualrouter.config.classificationConfig 未在 config/modules.json 中找到');
  }
  return cfg;
}

async function loadClassifierAndTokenCalc() {
  const classifierPath = path.join(
    ROOT,
    'dist',
    'modules',
    'virtual-router',
    'classifiers',
    'config-request-classifier.js'
  );
  const tokenCalcPath = path.join(
    ROOT,
    'dist',
    'modules',
    'virtual-router',
    'classifiers',
    'protocol-token-calculator.js'
  );

  const classifierMod = await import('file://' + classifierPath);
  const tokenCalcMod = await import('file://' + tokenCalcPath);

  if (!classifierMod.ConfigRequestClassifier) {
    throw new Error('ConfigRequestClassifier 未在 dist 中导出');
  }
  if (!tokenCalcMod.ProtocolTokenCalculator) {
    throw new Error('ProtocolTokenCalculator 未在 dist 中导出');
  }

  return {
    ConfigRequestClassifier: classifierMod.ConfigRequestClassifier,
    ProtocolTokenCalculator: tokenCalcMod.ProtocolTokenCalculator,
  };
}

function recordError(errors, label, message, extra) {
  const err = { label, message, ...(extra ? { extra } : {}) };
  errors.push(err);
  console.error(`❌ [${label}] ${message}`, extra ? `\n   ↳ ${JSON.stringify(extra)}` : '');
}

async function testProtocolDetection(classifier, errors) {
  console.log('=== [1] 协议检测验证 ===');

  const cases = [
    {
      label: 'openai_chat',
      endpoint: '/v1/chat/completions',
      expectedProtocol: 'openai',
    },
    {
      label: 'openai_responses',
      endpoint: '/v1/responses',
      expectedProtocol: 'openai',
    },
    {
      label: 'anthropic_messages',
      endpoint: '/v1/messages',
      expectedProtocol: 'anthropic',
    },
  ];

  for (const c of cases) {
    const res = await classifier.classify({
      request: {},
      endpoint: c.endpoint,
    });

    const protocol = res?.analysis?.protocol || 'unknown';
    if (!res.success) {
      recordError(errors, c.label, 'classification 未成功', { endpoint: c.endpoint, protocol });
      continue;
    }

    if (protocol !== c.expectedProtocol) {
      recordError(errors, c.label, 'protocol 检测结果不符合预期', {
        endpoint: c.endpoint,
        expected: c.expectedProtocol,
        actual: protocol,
      });
    } else {
      console.log(`✅ [${c.label}] endpoint=${c.endpoint} → protocol=${protocol}`);
    }
  }
}

async function testToolDetection(classifier, errors) {
  console.log('\n=== [2] 工具检测验证 ===');

  // OpenAI: webSearch 工具
  {
    const label = 'openai_websearch_tools';
    const request = {
      model: 'gpt-4',
      messages: [
        { role: 'user', content: '请在互联网上搜索今天的新闻。' },
        { role: 'assistant', content: '我将使用网络搜索工具。' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'web_search_baidu',
            description: 'web_search on the internet',
            parameters: {
              type: 'object',
              properties: { query: { type: 'string' } },
            },
          },
        },
      ],
    };

    const res = await classifier.classify({
      request,
      endpoint: '/v1/chat/completions',
    });

    if (!res.success) {
      recordError(errors, label, 'classification 未成功', { analysis: res.analysis });
    } else {
      const t = res.analysis?.toolAnalysis;
      if (!t) {
        recordError(errors, label, 'toolAnalysis 缺失');
      } else {
        const hasTools = t.hasTools === true;
        const webSearch = t.toolCategories?.webSearch === true;
        if (!hasTools || !webSearch) {
          recordError(errors, label, '未正确识别 webSearch 工具', {
            hasTools,
            categories: t.toolCategories,
            toolTypes: t.toolTypes,
          });
        } else {
          console.log(
            `✅ [${label}] hasTools=${hasTools}, webSearch=${webSearch}, toolTypes=${t.toolTypes.join(
              ','
            )}`
          );
        }
      }
    }
  }

  // OpenAI: codeExecution 工具
  {
    const label = 'openai_code_tools';
    const request = {
      model: 'gpt-4-code',
      messages: [
        { role: 'user', content: '请执行一段 bash 脚本。' },
        {
          role: 'assistant',
          content: '我将使用代码执行工具运行脚本。',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'bash_execute',
            description: 'code execution / bash script runner',
            parameters: { type: 'object', properties: { script: { type: 'string' } } },
          },
        },
      ],
    };

    const res = await classifier.classify({
      request,
      endpoint: '/v1/chat/completions',
    });

    if (!res.success) {
      recordError(errors, label, 'classification 未成功', { analysis: res.analysis });
    } else {
      const t = res.analysis?.toolAnalysis;
      if (!t) {
        recordError(errors, label, 'toolAnalysis 缺失');
      } else {
        const hasTools = t.hasTools === true;
        const codeExecution = t.toolCategories?.codeExecution === true;
        if (!hasTools || !codeExecution) {
          recordError(errors, label, '未正确识别 codeExecution 工具', {
            hasTools,
            categories: t.toolCategories,
            toolTypes: t.toolTypes,
          });
        } else {
          console.log(
            `✅ [${label}] hasTools=${hasTools}, codeExecution=${codeExecution}, toolTypes=${t.toolTypes.join(
              ','
            )}`
          );
        }
      }
    }
  }

  // Anthropic: dataAnalysis 工具
  {
    const label = 'anthropic_data_tools';
    const request = {
      model: 'claude-3-haiku',
      messages: [
        { role: 'user', content: '请根据数据生成统计图表并分析趋势。' },
        {
          role: 'assistant',
          content: '我将使用数据分析工具处理这些数据。',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'data_analysis_tool',
            description: 'data analysis and chart generation',
            parameters: { type: 'object', properties: { data: { type: 'string' } } },
          },
        },
      ],
    };

    const res = await classifier.classify({
      request,
      endpoint: '/v1/messages',
    });

    if (!res.success) {
      recordError(errors, label, 'classification 未成功', { analysis: res.analysis });
    } else {
      const t = res.analysis?.toolAnalysis;
      if (!t) {
        recordError(errors, label, 'toolAnalysis 缺失');
      } else {
        const hasTools = t.hasTools === true;
        const dataAnalysis = t.toolCategories?.dataAnalysis === true;
        if (!hasTools || !dataAnalysis) {
          recordError(errors, label, '未正确识别 dataAnalysis 工具', {
            hasTools,
            categories: t.toolCategories,
            toolTypes: t.toolTypes,
          });
        } else {
          console.log(
            `✅ [${label}] hasTools=${hasTools}, dataAnalysis=${dataAnalysis}, toolTypes=${t.toolTypes.join(
              ','
            )}`
          );
        }
      }
    }
  }
}

async function testTokenDetection(classifier, ProtocolTokenCalculator, errors) {
  console.log('\n=== [3] Token 检测验证 ===');

  // OpenAI: 简单文本
  {
    const label = 'openai_tokens_simple';
    const request = {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hello world' }],
      tools: [],
    };
    const endpoint = '/v1/chat/completions';

    const openaiCalc = ProtocolTokenCalculator.createOpenAICalculator();
    const expected = openaiCalc.calculate(request, endpoint);

    const res = await classifier.classify({ request, endpoint });
    if (!res.success) {
      recordError(errors, label, 'classification 未成功', { analysis: res.analysis });
    } else {
      const t = res.analysis?.tokenAnalysis;
      if (!t) {
        recordError(errors, label, 'tokenAnalysis 缺失');
      } else if (t.totalTokens !== expected.totalTokens) {
        recordError(errors, label, 'totalTokens 与 ProtocolTokenCalculator 不一致', {
          expected: expected.totalTokens,
          actual: t.totalTokens,
        });
      } else {
        console.log(
          `✅ [${label}] totalTokens=${t.totalTokens}, messages=${t.messageTokens}, tools=${t.toolTokens}`
        );
      }
    }
  }

  // Anthropic: 简单文本
  {
    const label = 'anthropic_tokens_simple';
    const request = {
      model: 'claude-3-haiku',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    };
    const endpoint = '/v1/messages';

    const anthropicCalc = ProtocolTokenCalculator.createAnthropicCalculator();
    const expected = anthropicCalc.calculate(request, endpoint);

    const res = await classifier.classify({ request, endpoint });
    if (!res.success) {
      recordError(errors, label, 'classification 未成功', { analysis: res.analysis });
    } else {
      const t = res.analysis?.tokenAnalysis;
      if (!t) {
        recordError(errors, label, 'tokenAnalysis 缺失');
      } else if (t.totalTokens !== expected.totalTokens) {
        recordError(errors, label, 'totalTokens 与 ProtocolTokenCalculator 不一致', {
          expected: expected.totalTokens,
          actual: t.totalTokens,
        });
      } else {
        console.log(
          `✅ [${label}] totalTokens=${t.totalTokens}, messages=${t.messageTokens}, tools=${t.toolTokens}`
        );
      }
    }
  }
}

async function main() {
  try {
    const classificationConfig = await loadClassificationConfig();
    const { ConfigRequestClassifier, ProtocolTokenCalculator } =
      await loadClassifierAndTokenCalc();

    const classifier = ConfigRequestClassifier.fromModuleConfig(classificationConfig);
    const errors = [];

    await testProtocolDetection(classifier, errors);
    await testToolDetection(classifier, errors);
    await testTokenDetection(classifier, ProtocolTokenCalculator, errors);

    console.log('\n=== 验证结果 ===');
    if (errors.length > 0) {
      console.error(`❌ Virtual Router classifier 验证失败，共 ${errors.length} 项异常`);
      process.exitCode = 1;
    } else {
      console.log('✅ Virtual Router classifier 所有测试通过');
    }
  } catch (err) {
    console.error('Fatal error during virtual-router classifier verification:', err);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${__filename}`) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main();
}

