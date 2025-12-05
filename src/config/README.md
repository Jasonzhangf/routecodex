# config/

RouteCodex 的配置源来自用户目录 `~/.routecodex/`。`src/config/` 只保留少量运行时必须的帮助函数：

| 文件 | 作用 |
| --- | --- |
| `auth-file-resolver.ts` | 解析 `authfile-*` 引用，读取并缓存密钥文件 |
| `config-paths.ts` + `unified-config-paths.ts` | 统一解析 `ROUTECODEX_CONFIG*` 环境变量、worktree 默认路径以及用户目录 |
| `routecodex-config-loader.ts` | 加载 `~/.routecodex/config.json`，补全 legacy 结构，并生成 provider profiles |
| `system-prompts/` | CLI/system prompt 覆盖内容；仅被 `system-prompt-loader.ts` 使用 |

其余配置（provider 模板、tool mappings、默认 JSON 等）已经全部迁移到用户目录，不会再从 repo 读取。

> **提示**：需要更新配置时，修改 `~/.routecodex/config.json` 并在 CLI 中重新启动即可；不要在 `src/config/` 下新增静态模板。***
