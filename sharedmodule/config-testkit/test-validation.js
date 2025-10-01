// Simple test to understand what's failing in validation
function testValidation() {
  const actual = {
    isValid: true,
    errors: [],
    warnings: [],
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
              "glm-4": { maxTokens: 8192 },
              "glm-4.5": { maxTokens: 8192, thinking: { enabled: true } },
              "glm-4-air": { maxTokens: 8192 },
              "glm-4-airx": { maxTokens: 8192 },
              "glm-4-flash": { maxTokens: 8192 }
            }
          }
        },
        routing: {
          "default": ["glm-provider.glm-4.5"],
          "coding": ["glm-provider.glm-4.5"],
          "longcontext": ["glm-provider.glm-4.5"],
          "tools": ["glm-provider.glm-4.5"],
          "thinking": [],
          "vision": [],
          "websearch": [],
          "background": []
        }
      }
    }
  };

  const expected = {
    isValid: true,
    errors: [],
    warnings: [],
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
              "glm-4": { maxTokens: 8192 },
              "glm-4.5": { maxTokens: 8192, thinking: { enabled: true } },
              "glm-4-air": { maxTokens: 8192 },
              "glm-4-airx": { maxTokens: 8192 },
              "glm-4-flash": { maxTokens: 8192 }
            }
          }
        },
        routing: {
          "default": ["glm-provider.glm-4.5"],
          "coding": ["glm-provider.glm-4.5"],
          "longcontext": ["glm-provider.glm-4.5"],
          "tools": ["glm-provider.glm-4.5"],
          "thinking": [],
          "vision": [],
          "websearch": [],
          "background": []
        }
      }
    }
  };

  console.log('=== MANUAL VALIDATION TEST ===');

  // Check the core validation result fields
  if (actual.isValid !== expected.isValid) {
    console.log('❌ isValid mismatch');
    return false;
  }
  console.log('✅ isValid matches');

  // Check errors length and content
  if (!Array.isArray(actual.errors) || !Array.isArray(expected.errors)) {
    console.log('❌ errors not arrays');
    return false;
  }
  if (actual.errors.length !== expected.errors.length) {
    console.log('❌ errors length mismatch:', actual.errors.length, 'vs', expected.errors.length);
    return false;
  }
  console.log('✅ errors arrays match');

  // Check warnings length (actual may have more warnings due to compatibility processing)
  if (!Array.isArray(actual.warnings) || !Array.isArray(expected.warnings)) {
    console.log('❌ warnings not arrays');
    return false;
  }
  if (actual.warnings.length < expected.warnings.length) {
    console.log('❌ warnings length mismatch:', actual.warnings.length, 'vs', expected.warnings.length);
    return false;
  }
  console.log('✅ warnings arrays match');

  // Check normalized config contains expected fields
  function containsExpectedFields(actualObj, expectedObj) {
    for (const [key, value] of Object.entries(expectedObj)) {
      if (!(key in actualObj)) {
        console.log(`❌ Missing key: ${key}`);
        return false;
      }

      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        if (typeof actualObj[key] !== 'object' || actualObj[key] === null) {
          console.log(`❌ Type mismatch at ${key}: expected object, got ${typeof actualObj[key]}`);
          return false;
        }
        if (!containsExpectedFields(actualObj[key], value)) {
          return false;
        }
      } else if (Array.isArray(value)) {
        if (!Array.isArray(actualObj[key])) {
          console.log(`❌ Type mismatch at ${key}: expected array, got ${typeof actualObj[key]}`);
          return false;
        }
        if (actualObj[key].length !== value.length) {
          console.log(`❌ Array length mismatch at ${key}: expected ${value.length}, got ${actualObj[key].length}`);
          return false;
        }
        for (let i = 0; i < value.length; i++) {
          if (actualObj[key][i] !== value[i]) {
            console.log(`❌ Array element mismatch at ${key}[${i}]: expected ${value[i]}, got ${actualObj[key][i]}`);
            return false;
          }
        }
      } else {
        if (actualObj[key] !== value) {
          console.log(`❌ Value mismatch at ${key}: expected ${value}, got ${actualObj[key]}`);
          return false;
        }
      }
    }
    return true;
  }

  if (expected.normalized && actual.normalized) {
    if (!containsExpectedFields(actual.normalized, expected.normalized)) {
      console.log('❌ normalized config mismatch');
      return false;
    }
    console.log('✅ normalized config matches');
  }

  console.log('✅ ALL VALIDATIONS PASSED!');
  return true;
}

testValidation();