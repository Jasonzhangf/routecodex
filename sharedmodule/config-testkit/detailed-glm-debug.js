import { BlackBoxTester, SAMPLE_CONFIGS, BLACKBOX_TEST_CASES } from './dist/index.js';

async function detailedGLMDebug() {
  console.log('=== Detailed GLM Debug Analysis ===');

  const blackboxTester = new BlackBoxTester();

  // 测试GLM配置
  const testCase = {
    id: 'glm-normalization-test',
    name: 'GLM Provider Type Normalization',
    description: 'Test GLM provider type normalization',
    inputConfig: SAMPLE_CONFIGS.glmConfig,
    expectedOutput: {
      isValid: true,
      normalized: {
        version: "1.0.0",
        port: 5507,
        virtualrouter: {
          inputProtocol: "openai",
          outputProtocol: "openai",
          providers: {
            "glm-provider": {
              id: "glm-provider",
              type: "openai-provider",
              enabled: true,
              apiKey: "6484fedc2cc9429e892dde8abf4c0bb8.es5PmJPf8XPvttZB",
              baseURL: "https://open.bigmodel.cn/api/paas/v4",
              compatibility: {
                type: "glm-compatibility",
                config: {
                  thinking: {
                    enabled: true,
                    payload: {
                      type: "enabled"
                    }
                  }
                }
              },
              models: {
                "glm-4": {
                  maxTokens: 8192
                },
                "glm-4.5": {
                  maxTokens: 8192,
                  thinking: {
                    enabled: true
                  }
                },
                "glm-4-air": {
                  maxTokens: 8192
                },
                "glm-4-airx": {
                  maxTokens: 8192
                },
                "glm-4-flash": {
                  maxTokens: 8192
                }
              }
            }
          },
          routing: {
            "default": [
              "glm-provider.glm-4.5"
            ],
            "coding": [
              "glm-provider.glm-4.5"
            ],
            "longcontext": [
              "glm-provider.glm-4.5"
            ],
            "tools": [
              "glm-provider.glm-4.5"
            ],
            "thinking": [],
            "vision": [],
            "websearch": [],
            "background": []
          }
        }
      }
    }
  };

  try {
    const result = await blackboxTester.runTest(testCase);

    console.log('\n=== BASIC INFO ===');
    console.log('Status:', result.status);
    console.log('isValid:', result.output?.isValid);
    console.log('Has normalized:', !!result.output?.normalized);

    if (result.output?.normalized) {
      console.log('\n=== ACTUAL OUTPUT STRUCTURE ===');
      console.log('Keys:', Object.keys(result.output.normalized));
      console.log('Has virtualrouter:', !!result.output.normalized.virtualrouter);

      if (result.output.normalized.virtualrouter) {
        console.log('VirtualRouter keys:', Object.keys(result.output.normalized.virtualrouter));
        console.log('Has providers:', !!result.output.normalized.virtualrouter.providers);

        if (result.output.normalized.virtualrouter.providers) {
          console.log('Provider IDs:', Object.keys(result.output.normalized.virtualrouter.providers));

          const glmProvider = result.output.normalized.virtualrouter.providers['glm-provider'];
          if (glmProvider) {
            console.log('\n=== GLM PROVIDER DETAILS ===');
            console.log('Provider keys:', Object.keys(glmProvider));
            console.log('Type:', glmProvider.type);
            console.log('Has models:', !!glmProvider.models);

            if (glmProvider.models) {
              console.log('Model IDs:', Object.keys(glmProvider.models));
            }
          }
        }
      }
    }

    console.log('\n=== COMPARISON ANALYSIS ===');
    const actual = result.output?.normalized || {};
    const expected = testCase.expectedOutput.normalized;

    console.log('Expected keys:', Object.keys(expected));
    console.log('Actual keys:', Object.keys(actual));

    // Deep comparison
    function deepCompare(actualObj, expectedObj, path = '') {
      const issues = [];

      for (const [key, expectedValue] of Object.entries(expectedObj)) {
        const currentPath = path ? `${path}.${key}` : key;

        if (!(key in actualObj)) {
          issues.push(`Missing key: ${currentPath}`);
          continue;
        }

        const actualValue = actualObj[key];

        if (typeof expectedValue === 'object' && expectedValue !== null && !Array.isArray(expectedValue)) {
          if (typeof actualValue !== 'object' || actualValue === null) {
            issues.push(`Type mismatch at ${currentPath}: expected object, got ${typeof actualValue}`);
          } else {
            const nestedIssues = deepCompare(actualValue, expectedValue, currentPath);
            issues.push(...nestedIssues);
          }
        } else if (Array.isArray(expectedValue)) {
          if (!Array.isArray(actualValue)) {
            issues.push(`Type mismatch at ${currentPath}: expected array, got ${typeof actualValue}`);
          } else if (actualValue.length !== expectedValue.length) {
            issues.push(`Length mismatch at ${currentPath}: expected ${expectedValue.length}, got ${actualValue.length}`);
          } else {
            for (let i = 0; i < expectedValue.length; i++) {
              if (actualValue[i] !== expectedValue[i]) {
                issues.push(`Array element mismatch at ${currentPath}[${i}]: expected ${expectedValue[i]}, got ${actualValue[i]}`);
              }
            }
          }
        } else {
          if (actualValue !== expectedValue) {
            issues.push(`Value mismatch at ${currentPath}: expected ${expectedValue}, got ${actualValue}`);
          }
        }
      }

      // Check for extra keys
      for (const key of Object.keys(actualObj)) {
        if (!(key in expectedObj)) {
          const currentPath = path ? `${path}.${key}` : key;
          issues.push(`Extra key: ${currentPath} = ${JSON.stringify(actualObj[key])}`);
        }
      }

      return issues;
    }

    const comparisonIssues = deepCompare(actual, expected);

    if (comparisonIssues.length === 0) {
      console.log('✅ No structural differences found!');
    } else {
      console.log('❌ Found differences:');
      comparisonIssues.forEach(issue => console.log(`  - ${issue}`));
    }

    console.log('\n=== RAW OUTPUT FOR INSPECTION ===');
    console.log('Actual output JSON:');
    console.log(JSON.stringify(result.output?.normalized, null, 2));

  } catch (error) {
    console.error('Test failed with error:', error);
    console.error('Error stack:', error.stack);
  }
}

detailedGLMDebug().catch(console.error);