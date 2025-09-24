# RouteCodex 配置与启动指南

## 快速回答：如何配置和启动？

**RouteCodex 采用"配置优先"的启动方式：**

1. **首次启动会自动创建默认配置** - 无需手动配置即可运行
2. **支持多种配置方式** - 命令行参数、配置文件、环境变量
3. **配置文件位置** - `~/.routecodex/config.json`（主配置）和`~/.routecodex/logs/`（日志）

## 详细配置机制

### 1. 启动流程

```
routecodex start
├── 检查配置文件是否存在
├── 不存在则自动创建默认配置
├── 加载配置并启动服务器
└── 输出配置信息
```

### 2. 配置文件结构

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
  "routing": {
    "default": "lmstudio"
  },
  "compatibility": "passthrough"
}
```

### 3. 命令行配置

#### 基本启动选项
```bash
# 指定端口和主机
routecodex start --port 8080 --host 0.0.0.0

# 指定日志级别
routecodex start --log-level debug

# 指定配置文件路径
routecodex start --config ./my-config.json
```

#### 离线记录配置（新功能）
```bash
# 启用离线记录
routecodex offline-log enable --all-modules --pipeline --level detailed

# 配置特定模块
routecodex offline-log module --name processor --enable --performance

# 配置流水线记录
routecodex offline-log pipeline --enable --capture-requests --capture-responses
```

### 4. 配置管理命令

```bash
# 查看当前配置
routecodex config show

# 编辑配置
routecodex config edit

# 验证配置
routecodex config validate

# 初始化配置
routecodex config init

# 查看离线记录配置
routecodex offline-log config show
```

### 5. 环境变量配置

```bash
# API密钥
export LM_STUDIO_API_KEY="your-lmstudio-key"
export OPENAI_API_KEY="your-openai-key"
export QWEN_CLIENT_ID="your-qwen-client-id"

# 日志级别
export ROUTECODEX_LOG_LEVEL="debug"

# 配置文件路径
export ROUTECODEX_CONFIG_PATH="./custom-config.json"
```

### 6. 模块配置

#### 通过CLI配置模块
```bash
# 配置LLM Switch模块
routecodex config set pipeline.llmSwitch.type "openai-passthrough"

# 配置兼容性模块
routecodex config set pipeline.compatibility.type "lmstudio-compatibility"

# 配置提供商模块
routecodex config set pipeline.provider.type "lmstudio-http"
```

#### 配置文件示例
```json
{
  "pipeline": {
    "llmSwitch": {
      "type": "openai-passthrough",
      "config": {
        "protocol": "openai",
        "targetFormat": "lmstudio"
      }
    },
    "compatibility": {
      "type": "lmstudio-compatibility",
      "config": {
        "toolsEnabled": true
      }
    },
    "provider": {
      "type": "lmstudio-http",
      "config": {
        "baseUrl": "http://localhost:1234",
        "auth": {
          "type": "apikey",
          "apiKey": "your-api-key"
        }
      }
    }
  }
}
```

## 启动配置流程

### 步骤1：首次启动
```bash
# 直接启动，会自动创建配置
routecodex start

# 输出：
# ✅ Default configuration created: ~/.routecodex/config.json
# ✅ RouteCodex server started on localhost:5506
# ℹ Configuration loaded from: ~/.routecodex/config.json
```

### 步骤2：自定义配置
```bash
# 创建自定义配置
routecodex config init

# 编辑配置
routecodex config edit

# 验证配置
routecodex config validate

# 使用自定义配置启动
routecodex start --config ./my-config.json
```

### 步骤3：运行时配置
```bash
# 查看当前配置
routecodex config show

# 修改特定配置项
routecodex config set server.port 8080
routecodex config set providers.lmstudio.baseUrl "http://192.168.1.100:1234"
```

## 配置优先级

1. **命令行参数**（最高优先级）
2. **环境变量**
3. **配置文件**
4. **默认值**（最低优先级）

## 常见配置场景

### 场景1：本地开发
```bash
# 开发模式，详细日志
routecodex start --log-level debug --port 3000

# 启用离线记录用于调试
routecodex offline-log enable --level detailed --all-modules
```

### 场景2：生产环境
```bash
# 生产模式，性能优化
routecodex start --host 0.0.0.0 --port 80 --log-level warn

# 配置日志轮转和压缩
routecodex offline-log enable --max-size 100 --max-files 20 --compression
```

### 场景3：多提供商配置
```bash
# 配置多个提供商
routecodex config set providers.openai.type "openai"
routecodex config set providers.openai.apiKey "sk-..."
routecodex config set providers.qwen.type "qwen"
routecodex config set providers.qwen.clientId "your-client-id"

# 启动时选择提供商
routecodex start --provider openai
```

## 故障排除

### 配置问题
```bash
# 检查配置文件是否存在
ls -la ~/.routecodex/

# 验证配置格式
routecodex config validate

# 查看配置加载日志
routecodex start --log-level debug
```

### 启动问题
```bash
# 端口被占用
routecodex start --port 8080

# 权限问题
sudo routecodex start --port 80

# 配置错误
routecodex config reset  # 重置为默认配置
```

## 关键概念

1. **"配置优先"设计** - 启动前确保配置正确
2. **"零配置启动"** - 首次使用自动创建合理默认配置
3. **"渐进式配置"** - 从简单到复杂，逐步细化配置
4. **"模块化配置"** - 每个组件独立配置，灵活组合
5. **"离线记录"** - 无需运行Web服务即可捕获和分析日志

## 总结

RouteCodex的配置机制设计为"智能默认 + 灵活定制"：

- **新手友好**：直接`routecodex start`即可使用
- **灵活配置**：支持命令行、配置文件、环境变量
- **模块化**：每个组件可独立配置
- **可视化**：提供CLI工具管理配置
- **离线支持**：新增离线记录功能，无需Web界面

这种设计既保证了易用性，又提供了充分的灵活性，满足不同场景的需求。