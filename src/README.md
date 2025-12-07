# RouteCodex 源代码目录

## 概述
RouteCodex Host 是“多提供商 OpenAI 代理服务器”的 HTTP 层与配置层，所有 AI 协议转换与工具治理均由共享的 `llmswitch-core` Hub Pipeline 完成。

## 目录结构
```
src/
├── commands/          # CLI 命令（validate、provider-update）
├── config/            # 配置加载、路径解析、auth-file 解析
├── debug/             # 快照、干跑、回放等调试工具
├── modules/           # Hub Pipeline 桥接与配置辅助
├── providers/         # Provider V2（HTTP 通信 + 最小兼容层）
├── server/            # Express HTTP 服务器与路由
├── types/             # 共享类型与 DTO
└── utils/             # Host 工具（错误、负载、快照）
```

## 核心原则（Do / Don't）
**Do**
- 所有请求必须通过 `llmswitch-core` Hub Pipeline，Host 不维护旁路。
- 配置解析后立刻调用 `bootstrapVirtualRouterConfig` 并注入 Hub Pipeline。
- Provider 仅负责 HTTP 通信、认证、快照，不做工具语义修复。
- 兼容层只做最小字段修剪，所有治理归 Hub Pipeline。

**Don't**
- 不在 Host 内实现转换流水线或工具治理。
- 不绕过 Hub Pipeline 直接调用 Provider。
- 不手动合并 runtime 配置或 patch 路由决策。

## 快速开始
```bash
# 1. 先编译共享模块
npm --prefix sharedmodule/llmswitch-core run build

# 2. 编译主包
npm run build

# 3. 全局安装 dev 包
npm run install:global

# 4. 启动
routecodex start --config ~/.routecodex/config.json
```

## 调试
- CLI：`npm run snapshot:inspect -- --rid <RID>` 查看各阶段快照。
- 快照目录：`~/.routecodex/codex-samples/`。
- Provider Harness：`src/debug/harnesses/provider-harness.ts` 支持干跑。

## 文档
- 根目录 `AGENTS.md`：架构原则与职责边界。
- `sharedmodule/llmswitch-core/README.md`：Hub Pipeline 详细说明。
- 各子目录 `README.md`：模块使用与贡献指南。
