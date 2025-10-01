# RouteCodex Direct API Key Configuration Migration Guide

## 📋 Overview

This guide explains how to migrate from environment variable-based API key configurations to direct API key configurations in RouteCodex. This migration improves security, maintainability, and debugging capabilities.

## 🚨 Why Migrate?

### Current Environment Variable Approach (Deprecated)
```json
{
  "virtualrouter": {
    "providers": {
      "glm-provider": {
        "apiKey": "${GLM_API_KEY}",
        "type": "glm"
      }
    }
  }
}
```

**Issues with environment variables:**
- ❌ **Security**: Keys can be exposed in process dumps and environment listings
- ❌ **Debugging**: Hard to debug configuration issues without seeing actual values
- ❌ **Portability**: Configuration depends on external environment setup
- ❌ **Validation**: Cannot validate key formats at configuration time
- ❌ **Documentation**: Configuration files don't show actual key requirements

### New Direct API Key Approach (Recommended)
```json
{
  "virtualrouter": {
    "providers": {
      "glm-provider": {
        "apiKey": "sk-6484fedc2cc9429e892dde8abf4c0bb8.es5PmJPf8XPvttZB",
        "type": "glm"
      }
    }
  }
}
```

**Benefits of direct API keys:**
- ✅ **Security**: Keys are stored directly in configuration files with proper access controls
- ✅ **Validation**: Immediate validation of key formats and patterns
- ✅ **Debugging**: Clear visibility into actual configuration values
- ✅ **Portability**: Self-contained configuration files
- ✅ **Documentation**: Clear requirements and examples in configuration files

## 🛠️ Migration Process

### Step 1: Validate Current Configuration

Use the `DirectApiKeyConfig` utility to analyze your current configuration:

```javascript
import { DirectApiKeyConfig } from '@routecodex/config-compat';

// Analyze your current configuration
const validation = DirectApiKeyConfig.validateConfig(yourConfig);

console.log('Configuration Analysis:');
console.log(`- Direct API Keys: ${validation.apiKeys.direct}`);
console.log(`- Environment Variables: ${validation.apiKeys.envVars}`);
console.log(`- Invalid Keys: ${validation.apiKeys.invalid}`);
console.log(`- Overall Valid: ${validation.isValid}`);

if (validation.warnings.length > 0) {
  console.log('Warnings:');
  validation.warnings.forEach(warning => console.log(`  - ${warning}`));
}
```

### Step 2: Perform Migration

Use the automated migration utility to convert environment variables to direct API keys:

```javascript
import { DirectApiKeyConfig } from '@routecodex/config-compat';

// Set up environment variables for migration
process.env.GLM_API_KEY = 'your-actual-glm-api-key';
process.env.OPENAI_API_KEY = 'your-actual-openai-api-key';

// Perform migration
const result = await DirectApiKeyConfig.migrateConfigFile({
  sourcePath: './config/old-config.json',
  targetPath: './config/new-config.json',
  backup: true,  // Creates backup automatically
  validateKeys: true
});

if (result.success) {
  console.log('✅ Migration successful!');
  console.log(`Backup created: ${result.backupPath}`);
  console.log(`Environment variables replaced: ${result.changes.envVarsReplaced}`);
} else {
  console.log('❌ Migration failed:');
  result.warnings.forEach(warning => console.log(`  - ${warning}`));
}
```

### Step 3: Verify Migration Results

```javascript
// Load and validate the migrated configuration
const fs = require('fs');
const migratedConfig = JSON.parse(fs.readFileSync('./config/new-config.json', 'utf8'));
const migratedValidation = DirectApiKeyConfig.validateConfig(migratedConfig);

console.log('Post-migration validation:');
console.log(`- Direct API Keys: ${migratedValidation.apiKeys.direct}`);
console.log(`- Environment Variables: ${migratedValidation.apiKeys.envVars}`);
console.log(`- Valid Configuration: ${migratedValidation.isValid}`);
```

## 📋 Detailed Migration Examples

### Example 1: Single Provider Migration

**Before (Environment Variables):**
```json
{
  "virtualrouter": {
    "providers": {
      "glm-provider": {
        "type": "glm",
        "enabled": true,
        "apiKey": "${GLM_API_KEY}",
        "models": {
          "glm-4": {
            "maxTokens": 8192,
            "temperature": 0.7
          }
        }
      }
    }
  }
}
```

**Migration Process:**
```bash
# Set environment variable
export GLM_API_KEY="sk-6484fedc2cc9429e892dde8abf4c0bb8.es5PmJPf8XPvttZB"

# Run migration
node -e "
const { DirectApiKeyConfig } = require('@routecodex/config-compat');
DirectApiKeyConfig.migrateConfigFile({
  sourcePath: './config.json',
  targetPath: './config-migrated.json',
  backup: true
});
"
```

**After (Direct API Keys):**
```json
{
  "virtualrouter": {
    "providers": {
      "glm-provider": {
        "type": "glm",
        "enabled": true,
        "apiKey": "sk-6484fedc2cc9429e892dde8abf4c0bb8.es5PmJPf8XPvttZB",
        "models": {
          "glm-4": {
            "maxTokens": 8192,
            "temperature": 0.7
          }
        }
      }
    }
  }
}
```

### Example 2: Multi-Provider Migration

**Before:**
```json
{
  "virtualrouter": {
    "providers": {
      "glm-provider": {
        "type": "glm",
        "apiKey": "${GLM_API_KEY}"
      },
      "openai-provider": {
        "type": "openai",
        "apiKey": "${OPENAI_API_KEY}"
      },
      "anthropic-provider": {
        "type": "anthropic",
        "apiKey": "${ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

**After:**
```json
{
  "virtualrouter": {
    "providers": {
      "glm-provider": {
        "type": "glm",
        "apiKey": "sk-6484fedc2cc9429e892dde8abf4c0bb8.es5PmJPf8XPvttZB"
      },
      "openai-provider": {
        "type": "openai",
        "apiKey": "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890"
      },
      "anthropic-provider": {
        "type": "anthropic",
        "apiKey": "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz"
      }
    }
  }
}
```

## 🔧 API Key Format Validation

The migration utility validates API key formats for common providers:

### OpenAI API Keys
- **Valid**: `sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890`
- **Pattern**: `^sk-proj-[A-Za-z0-9]{20,}$`

### GLM API Keys
- **Valid**: `sk-6484fedc2cc9429e892dde8abf4c0bb8.es5PmJPf8XPvttZB`
- **Pattern**: `^[A-Za-z0-9]{32,}$` (32+ alphanumeric characters)

### Anthropic API Keys
- **Valid**: `sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz`
- **Pattern**: `^sk-ant-[A-Za-z0-9-]{20,}$`

### Generic API Keys
- **Pattern**: `^[A-Za-z0-9_-]{20,}$` (20+ characters)

## 🛡️ Security Best Practices

### 1. File Permissions
```bash
# Set appropriate file permissions
chmod 600 ~/.routecodex/config/*.json
```

### 2. Environment Segregation
```json
{
  "virtualrouter": {
    "providers": {
      "development-glm": {
        "type": "glm",
        "apiKey": "sk-dev-key-for-development-only",
        "environment": "development"
      },
      "production-glm": {
        "type": "glm",
        "apiKey": "sk-prod-key-for-production-use",
        "environment": "production"
      }
    }
  }
}
```

### 3. Key Rotation Strategy
```javascript
// Example key rotation configuration
{
  "virtualrouter": {
    "providers": {
      "glm-provider": {
        "type": "glm",
        "apiKey": "sk-new-primary-key-here",
        "backupApiKey": "sk-old-secondary-key-here",
        "keyRotationDate": "2024-01-15T00:00:00Z"
      }
    }
  }
}
```

## 🚀 Common Migration Scenarios

### Scenario 1: Mixed Configuration
Some keys are direct, others use environment variables.

**Solution:** Use the migration utility to convert only the environment variable keys.

### Scenario 2: Missing Environment Variables
Environment variables referenced in configuration are not set.

**Solution:** The migration utility will preserve the `${VAR_NAME}` pattern and issue warnings.

### Scenario 3: Invalid Key Formats
Keys don't match expected patterns for their providers.

**Solution:** Migration utility will flag these as invalid while still completing the migration.

## 📊 Migration Validation Checklist

- [ ] **Pre-migration backup**: Ensure original configuration is backed up
- [ ] **Environment variable setup**: All referenced environment variables are set
- [ ] **Format validation**: All keys match expected patterns
- [ ] **Post-migration testing**: Verify system works with new configuration
- [ ] **Environment cleanup**: Remove environment variables after successful migration
- [ ] **Documentation update**: Update any documentation that references old configuration

## 🔍 Troubleshooting

### Common Issues

#### 1. Migration Fails Due to Missing Environment Variables
```bash
# Check which environment variables are needed
grep -r '\${' ~/.routecodex/config/

# Set missing variables
export MISSING_VAR="your-api-key-here"
```

#### 2. Invalid API Key Format Warnings
```javascript
// Validate individual keys
const validation = DirectApiKeyConfig.validateConfig(config);
console.log(validation.warnings);
```

#### 3. Configuration Doesn't Work After Migration
```javascript
// Test compatibility engine processing
import { CompatibilityEngine } from '@routecodex/config-compat';

const engine = new CompatibilityEngine();
const result = await engine.processCompatibility(JSON.stringify(config));
console.log(result.errors);
console.log(result.warnings);
```

### Getting Help

1. **Run validation**: Use `DirectApiKeyConfig.validateConfig()` to identify issues
2. **Check logs**: Review migration logs for detailed error information
3. **Test incrementally**: Test with one provider at a time
4. **Restore backup**: Use backup files if migration fails

## 📝 Advanced Migration Options

### Custom Environment Variable Mappings
```javascript
const result = await DirectApiKeyConfig.migrateConfigFile({
  sourcePath: './config.json',
  targetPath: './config-migrated.json',
  envMappings: {
    'CUSTOM_GLM_KEY': 'GLM_API_KEY',  // Map one env var to another
    'PROD_OPENAI_KEY': 'OPENAI_API_KEY'
  }
});
```

### Dry Run Mode
```javascript
// Test migration without making changes
const validation = DirectApiKeyConfig.validateConfig(config);
const migratedConfig = DirectApiKeyConfig.convertToDirectConfig(config);

console.log('Would migrate to:', JSON.stringify(migratedConfig, null, 2));
```

### Batch Migration
```javascript
// Migrate multiple configuration files
const configFiles = ['config1.json', 'config2.json', 'config3.json'];

for (const file of configFiles) {
  await DirectApiKeyConfig.migrateConfigFile({
    sourcePath: `./config/${file}`,
    targetPath: `./config/migrated-${file}`,
    backup: true
  });
}
```

## 🎯 Next Steps After Migration

### 1. Update Deployment Scripts
Remove environment variable setup from deployment scripts.

### 2. Update Documentation
Update all documentation to reference direct API key configuration.

### 3. Update CI/CD Pipelines
Remove environment variable management from CI/CD processes.

### 4. Security Audit
Review file permissions and access controls for configuration files.

### 5. Monitoring Setup
Set up monitoring for configuration file changes and access.

## 📚 Additional Resources

- **API Reference**: DirectApiKeyConfig class documentation
- **Configuration Guide**: RouteCodex configuration documentation
- **Security Guidelines**: RouteCodex security best practices
- **Troubleshooting**: Common issues and solutions

---

## 🔄 Summary

Migrating from environment variable-based API key configuration to direct API key configuration provides significant benefits in security, maintainability, and debugging capabilities. The automated migration utilities make this process straightforward and safe.

**Key Benefits:**
- Enhanced security through proper file-based key storage
- Immediate validation of key formats
- Improved debugging and troubleshooting
- Better configuration portability
- Clear documentation and examples

**Migration Steps:**
1. Analyze current configuration
2. Set up environment variables
3. Run automated migration
4. Validate results
5. Update processes and documentation

The migration utilities handle all the complexity while providing detailed feedback and safety measures through automatic backups.