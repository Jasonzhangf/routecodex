# RouteCodex

多Provider OpenAI代理服务器

## 项目结构

```
routecodex/
├── src/
│   ├── index.ts                      # 启动入口
│   ├── server/                       # 服务器模块
│   │   ├── http-server.ts            # HTTP服务器
│   │   ├── openai-router.ts          # OpenAI路由
│   │   └── types.ts                  # 服务器类型定义
│   ├── core/                         # 核心模块
│   │   ├── config-manager.ts         # 配置管理器
│   │   ├── provider-manager.ts       # Provider管理器
│   │   ├── request-handler.ts        # 请求处理器
│   │   └── response-handler.ts       # 响应处理器
│   ├── providers/                    # Provider模块
│   │   ├── base-provider.ts          # Provider基类
│   │   ├── openai-provider.ts        # OpenAI兼容Provider
│   │   └── provider-factory.ts      # Provider工厂
│   ├── config/                       # 配置模块
│   │   ├── default-config.json       # 默认配置
│   │   ├── config-types.ts           # 配置类型
│   │   ├── config-loader.ts          # 配置加载器
│   │   └── config-validator.ts       # 配置验证器
│   ├── utils/                        # 工具模块
│   │   ├── logger.ts                 # 日志工具
│   │   ├── error-handler.ts          # 错误处理
│   │   ├── load-balancer.ts          # 负载均衡
│   │   └── failover.ts               # 故障转移
│   └── patches/                      # 补丁模块
│       ├── patch-manager.ts          # 补丁管理器
│       └── openai-patch.ts           # OpenAI补丁
├── config/
│   └── routecodex.json               # 用户配置文件
├── tests/                            # 测试文件
└── docs/                             # 文档
```

## 开发

```bash
npm install
npm run dev
```

## 构建

```bash
npm run build
npm start
```