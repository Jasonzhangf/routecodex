# rccx wasm 接入说明（Host 视角）

## 三条 CLI 路线的角色划分

- `routecodex`（dev CLI）
  - 面向本地开发与调试，始终使用仓库下的 `sharedmodule/llmswitch-core` 源码。
  - 通过 `npm run llmswitch:link` / `npm run config:use-local` 把本地 llmswitch-core 链接到 `node_modules/@jsonstudio/llms`。
- `rcc`（release CLI）
  - 发布到 npm 的正式包：`@jsonstudio/rcc`。
  - 由 `npm run publish:rcc` 生成 tarball 并 `npm publish`，构建时依赖 npm 上的 `@jsonstudio/llms`（TS 实现）。
- `rccx`（wasm CLI，实验/内部使用）
  - 使用 `@jsonstudio/llms-wasm`（wasm 引擎）作为 llms 核心实现。
  - 通过 npm alias 保持 Host import 形状不变：源码仍然 `import ... from '@jsonstudio/llms'`，但在 rccx 包内该依赖会被重写为 `@jsonstudio/llms-wasm`。

> 约束：按照 `AGENTS.md`，正式发布渠道仍然只使用 `@jsonstudio/rcc`；`routecodex` 和 `rccx` 保持在本地/内部使用范围内。

## 依赖与打包策略

- 根 `package.json` 继续声明：
  - `@jsonstudio/llms`: `^0.6.x`（供 routecodex / rcc 构建使用）。
- `scripts/pack-mode.mjs` 在打包 rccx 时（`--name @jsonstudio/rccx --bin rccx`）会：
  - 将 `package.json.name` 设置为 `@jsonstudio/rccx`，`bin` 设置为 `{ "rccx": "dist/cli.js" }`。
  - 清空 `bundledDependencies` / `bundleDependencies`，改为普通 `dependencies`。
  - 在 `dependencies` 中应用 alias：
    - 移除原有的 `@jsonstudio/llms` 直连依赖；
    - 增加：
      - `"@jsonstudio/llms": "npm:@jsonstudio/llms-wasm@^0.1.0"`
      - `"@jsonstudio/llms-wasm": "^0.1.0"`
  - 这样，安装 `@jsonstudio/rccx` 时，`require('@jsonstudio/llms')` 实际会加载 wasm 版本实现。

> 注意：`pack-mode.mjs` 只在打包阶段临时修改 `package.json`，打包完成后会恢复原始文件。

## 构建 rccx（本地）

1. 确保本机已经有可用的 `@jsonstudio/llms-wasm`：
   - 要么从 `sharedmodule/llms-wasm` 构建并发布到私有 npm；
   - 要么通过本地 tarball 安装到全局/工程级 npm registry（版本号需满足 `^0.1.0`）。
2. 在 routecodex 仓库根目录执行：
   ```bash
   npm run build:rccx
   ```
   - 这会先执行 `npm run build:min`（使用当前 BUILD_MODE 构建 dist）；
   - 然后调用：
     ```bash
     node scripts/pack-mode.mjs --name @jsonstudio/rccx --bin rccx
     ```
   - 完成后仓库根目录会出现一个 `jsonstudio-rccx-<version>.tgz`。
3. 在目标环境中安装 rccx：
   ```bash
   npm install -g ./jsonstudio-rccx-<version>.tgz
   ```

## 运行与行为确认

- `rccx` CLI 行为与 `routecodex` / `rcc` 相同：
  - `rccx start` 启动同一套 HTTP server，端口仍由 RouteCodex 配置决定（默认 5555）。
  - `rccx code` / `rccx config` 等子命令全部复用现有 CLI 逻辑。
- 不同点只在于 llms 实现：
  - `rcc` 使用 npm 上的 `@jsonstudio/llms`（TS 实现）；
  - `rccx` 使用 npm 上的 `@jsonstudio/llms-wasm`（wasm 引擎，通过 alias 暴露为 `@jsonstudio/llms`）。

## 黑盒对比建议（可选）

为确保 wasm 版本行为与 TS 版本一致，建议在同一份 RouteCodex 配置下做一轮回放对比：

- 启动两个实例：
  - `routecodex`（或 `rcc`）使用 TS 版 llms；
  - `rccx` 使用 wasm 版 llms。
- 对同一组请求（尤其是 sticky / health / 429 / series cooldown / Gemini compat 等场景）：
  - 比较日志中的 `virtual-router-hit` / `providerKey` / sticky 选择与健康状态；
  - 确认两侧路由决策与工具调用行为一致。

后续每次升级 `@jsonstudio/llms` / `@jsonstudio/llms-wasm` 时，可以复用这一套回放作为回归校验。

