# RouteCodex 验证配置集合

本目录包含经过端到端测试验证的 RouteCodex 配置文件，按版本组织。

## 版本历史

### v0.45.0 (当前版本)
**验证日期**: 2025-10-13T01:56:00Z
**验证状态**: ✅ 通过 - LM Studio + Qwen Provider 集成验证成功

#### 配置文件
- `lmstudio-5521-gpt-oss-20b-mlx.json` - LM Studio 用户配置 (端口 5521)
- `merged-config.5521.json` - 系统合并后的完整配置
- `qwen-5522-qwen3-coder-plus.json` - Qwen 用户配置 (端口 5522)
- `merged-config.qwen-5522.json` - Qwen 系统合并配置
- `README.md` - 详细验证报告

#### 验证环境
- **分支**: feat/new-feature
- **模型**: gpt-oss-20b-mlx
- **LM Studio**: localhost:1234
- **协议支持**: OpenAI + Anthropic

#### 使用方法
```bash
# 启动 LM Studio 配置 (端口 5521)
npx ts-node src/cli.ts start --config ~/.routecodex/config/lmstudio-5521-gpt-oss-20b-mlx.json --port 5521

# 启动 Qwen Provider 配置 (端口 5522)
npx ts-node src/cli.ts start --config ~/.routecodex/config/qwen-5522-qwen3-coder-plus.json --port 5522
```

## 目录结构
```
docs/verified-configs/
├── README.md                 # 本文件
└── v0.45.0/                 # 版本化配置目录
    ├── lmstudio-5521-gpt-oss-20b-mlx.json
    ├── merged-config.5521.json
    └── README.md             # 详细验证报告
```

## 验证标准

每个版本的配置都必须通过以下验证：

1. **✅ 配置加载系统** - 用户配置正确加载
2. **✅ 4层管道架构** - LLM Switch, Compatibility, Provider, AI Service
3. **✅ 动态路由分类** - 9种路由类别配置正确
4. **✅ 服务集成** - 目标服务连接测试通过
5. **✅ 协议支持** - OpenAI 和 Anthropic 协议端点
6. **✅ 功能测试** - 基本请求/响应流程验证

## 版本管理策略

- **主版本** (Major): 重大架构变更，配置可能不兼容
- **次版本** (Minor): 新功能添加，保持向后兼容
- **修订版本** (Patch): Bug修复，配置格式不变

每个验证过的配置都绑定到特定的 RouteCodex 版本，确保兼容性。
