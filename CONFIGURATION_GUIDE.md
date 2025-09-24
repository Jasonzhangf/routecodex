# RouteCodex 配置指南

## 快速启动配置

### 基础启动
```bash
# 使用默认配置启动
routecodex start

# 指定端口和主机
routecodex start --port 8080 --host 0.0.0.0

# 指定配置文件
routecodex start --config ./my-config.json

# 设置日志级别
routecodex start --log-level debug
```

### 配置优先级
RouteCodex 的配置系统遵循以下优先级（从高到低）：

1. **命令行参数** - 最高优先级
2. **用户配置文件** - `~/.routecodex/config.json`
3. **默认配置模板** - 内置默认配置
4. **硬编码默认值** - 最低优先级

## 配置文件详解

### 基础配置结构
```json
{
  "server": {
    "port": 5506,
    "host": "localhost"
  },
  "logging": {
    "level": "info",
    "enableFile": true,
    "filePath": "~/.routecodex/logs/routecodex.log"
  },
  "providers": {
    "lmstudio": {
      "type": "lmstudio",
      "baseUrl": "http://localhost:1234",
      "apiKey": "your-api-key"
    }
  },
  "modules": {
    "llm-switch": {
      "type": "openai-passthrough",
      "config": {
        "protocol": "openai",
        "targetFormat": "lmstudio"
      }
    }
  }
}
```

## 配置方法

### 方法1：命令行配置
```bash
# 查看当前配置
routecodex config show

# 编辑配置文件
routecodex config edit

# 验证配置
routecodex config validate

# 初始化默认配置
routecodex config init
```

### 方法2：直接编辑配置文件
配置文件位于：`~/.routecodex/config.json`

### 方法3：环境变量
```bash
export ROUTECODEX_PORT=8080
export ROUTECODEX_HOST=0.0.0.0
export ROUTECODEX_LOG_LEVEL=debug
export LM_STUDIO_API_KEY=your-key
export OPENAI_API_KEY=your-key
```

## 不同场景的配置示例

### 场景1：本地LM Studio开发
```json
{
  "server": {
    "port": 5506,
    "host": "localhost"
  },
  "logging": {
    "level": "debug",
    "enableFile": true
  },
  "providers": {
    "lmstudio": {
      "type": "lmstudio",
      "baseUrl": "http://localhost:1234",
      "apiKey": "local-dev-key"
    }
  },
  "routing": {
    "default": "lmstudio"
  }
}
```

### 场景2：生产环境多提供商
```json
{
  "server": {
    "port": 8080,
    "host": "0.0.0.0"
  },
  "logging": {
    "level": "info",
    "enableFile": true,
    "filePath": "/var/log/routecodex/app.log"
  },
  "providers": {
    "openai": {
      "type": "openai",
      "apiKey": "${OPENAI_API_KEY}"
    },
    "qwen": {
      "type": "qwen",
      "baseUrl": "https://chat.qwen.ai",
      "oauth": {
        "clientId": "your-client-id",
        "tokenFile": "~/.routecodex/qwen-token.json"
      }
    }
  },
  "routing": {
    "default": "openai",
    "fallback": "qwen"
  }
}
```

### 场景3：带工具调用的完整配置
```json
{
  "server": {
    "port": 5506,
    "host": "localhost"
  },
  "logging": {
    "level": "debug",
    "enableFile": true
  },
  "providers": {
    "lmstudio": {
      "type": "lmstudio",
      "baseUrl": "http://localhost:1234",
      "apiKey": "your-key"
    }
  },
  "routing": {
    "default": "lmstudio"
  },
  "features": {
    "tools": {
      "enabled": true,
      "maxTools": 10
    },
    "streaming": {
      "enabled": true,
    }
  }
}
```

## 离线日志记录配置

### 启用离线记录
```bash
# 启用基本离线记录
routecodex offline-log enable --all-modules --pipeline

# 详细配置
routecodex offline-log enable \
  --level detailed \
  --directory ./logs \
  --max-size 100 \
  --max-files 20 \
  --compression
```

### 模块级配置
```bash
# 配置特定模块
routecodex offline-log module --name processor --enable --performance --stack-traces

# 配置多个模块
routecodex offline-log module --name llm-switch --enable --level detailed
routecodex offline-log module --name compatibility --enable --performance
routecodex offline-log module --name provider --enable --level verbose
```

### 流水线级配置
```bash
# 启用完整流水线记录
routecodex offline-log pipeline \
  --enable \
  --capture-requests \
  --capture-responses \
  --capture-errors \
  --capture-performance
```

## 配置验证和调试

### 验证配置
```bash
# 验证当前配置
routecodex config validate

# 检查特定配置文件
routecodex config validate --config ./test-config.json
```

### 调试信息
```bash
# 查看详细配置
routecodex config show

# 查看离线记录配置
routecodex offline-log list

# 以JSON格式输出配置
routecodex config show --json
```

## 环境特定配置

### 开发环境
```bash
# 开发环境配置
export NODE_ENV=development
routecodex start --log-level debug --port 3000

# 或者创建开发配置
routecodex config init --template development
```

### 生产环境
```bash
# 生产环境配置
export NODE_ENV=production
routecodex start --log-level info --port 8080 --host 0.0.0.0

# 或者创建生产配置
routecodex config init --template production
```

## 常见问题

### Q: 启动时提示配置文件不存在？
A: RouteCodex 会自动创建默认配置文件，位置在 `~/.routecodex/config.json`

### Q: 如何修改默认配置位置？
A: 使用 `--config` 参数指定配置文件路径：
```bash
routecodex start --config /path/to/your/config.json
```

### Q: 配置更改后需要重启吗？
A: 大多数配置更改需要重启，但某些运行时配置可以通过API动态更新

### Q: 如何查看所有可用的配置选项？
A: 查看配置文件模板或运行 `routecodex config show` 查看当前配置

### Q: 环境变量和配置文件哪个优先级高？
A: 命令行参数 > 环境变量 > 配置文件 > 默认值

## 高级配置

### 自定义模块配置
```json
{
  "modules": {
    "llm-switch": {
      "type": "openai-passthrough",
      "config": {
        "protocol": "openai",
        "targetFormat": "lmstudio",
        "routing": {
          "thinking": "longcontext",
          "vision": "vision"
        }
      }
    },
    "compatibility": {
      "type": "lmstudio-compatibility",
      "config": {
        "toolsEnabled": true,
        "customRules": [
          {
            "id": "tool-format",
            "transform": "mapping",
            "sourcePath": "tools",
            "targetPath": "tools"
          }
        ]
      }
    }
  }
}
```

### 性能调优配置
```json
{
  "performance": {
    "connectionPool": {
      "maxConnections": 100,
      "keepAlive": true,
      "timeout": 30000
    },
    "caching": {
      "enabled": true,
      "ttl": 300000,
      "maxSize": 1000
    },
    "rateLimiting": {
      "enabled": true,
      "requestsPerSecond": 10,
      "burstCapacity": 50
    }
  }
}
```

这个配置指南涵盖了RouteCodex的所有配置方式，从基础启动到高级自定义配置。