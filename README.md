# RouteCodex V3

RouteCodex V3 是当前唯一主力实现。生产 CLI、配置、运行时、协议投影和生命周期均由 `v3/` Rust workspace 负责；旧 V2 authoring、WebUI、mock provider、samples 和 `rcc init/config` 已退休，不属于构建或运行入口。

## 主入口

- Rust workspace: `v3/Cargo.toml`
- CLI: `v3/crates/routecodex-v3-cli`
- Installed command: `rccv3`
- Default config: `~/.rcc/config.v3.toml`
- Architecture maps: `docs/architecture/v3-*.yml`
- Mainline review: `docs/architecture/wiki/v3-mainline-caller-flow.md`

## 构建与验证

```bash
npm run verify:v3-architecture-ci
npm run test:v3-workspace
npm run install:v3
rccv3 config check -c ~/.rcc/config.v3.toml
rccv3 restart -c ~/.rcc/config.v3.toml
curl http://127.0.0.1:5555/health
```

V3 的完整边界和验证要求见 [`v3/README.md`](v3/README.md)。`routecodex` / `rcc` 仅保留必要的历史兼容壳，不再提供新的 runtime 或配置能力。

## API 示例

```bash
curl http://127.0.0.1:5555/health

curl http://127.0.0.1:5555/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"provider.model","messages":[{"role":"user","content":"hi"}],"stream":false}'

curl http://127.0.0.1:5555/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"provider.model","input":[{"role":"user","content":"hi"}],"stream":false}'

curl http://127.0.0.1:5555/v1/messages \
  -H 'Content-Type: application/json' \
  -d '{"model":"provider.model","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

## 配置与认证

V3 的唯一 authoring 文件是 `~/.rcc/config.v3.toml`。Provider、模型、路由池、监听器和认证句柄必须在该配置及其声明的 V3 provider 文件中定义，并由 `rccv3 config check` 编译为 manifest。

API key 通过 V3 配置引用的认证句柄或环境变量提供，例如：

```bash
export OPENAI_API_KEY="your_openai_key"
export ANTHROPIC_API_KEY="your_anthropic_key"
```

不要创建或恢复 `config.json`、`configsamples/`、`webui/`、仓库 `samples/` 或 `rcc init` 生成的 V2 provider 文件。

## 文档

- [V3 workspace 与边界](v3/README.md)
- [V3 系统定义](docs/design/v3-system-definition.md)
- [V3 入出站设计](docs/V3_INBOUND_OUTBOUND_DESIGN.md)
- [V3 Hub relay 固定流水线](docs/design/v3-hub-relay-fixed-pipeline-contract.md)
- [架构总览](docs/ARCHITECTURE.md)
- [错误处理](docs/error-handling-v2.md)
- [路由指令](docs/routing-instructions.md)
- [AGENTS.md](AGENTS.md)

V2 历史资料仅存放在 [`deprecated/v2/`](deprecated/v2/README.md)，不得被 package、build、CI 或默认测试重新接线。
