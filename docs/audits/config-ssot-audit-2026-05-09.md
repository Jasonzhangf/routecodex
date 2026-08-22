# RouteCodex 配置 SSOT 审计（2026-05-09）

## 目标

为 `config.json -> config.toml` 渐进式迁移提供当前基线证据，明确：

1. 现在哪些地方是配置主入口
2. 哪些地方在绕过主入口做散点读取/写回
3. 默认路径和文件名哪里被硬编码
4. 为什么当前还不是“全局唯一配置读取/写回”

---

## 结论

当前**不是**“全局唯一配置读取/写回”。

最准确的状态是：

- 有**局部主入口**
  - 主用户配置：`src/config/routecodex-config-loader.ts`
  - provider 配置：`src/config/provider-v2-loader.ts`
  - 路径统一化意图：`src/config/config-paths.ts` + `src/config/unified-config-paths.ts`
- 但运行链、CLI、admin、maintenance 仍有大量：
  - `JSON.parse(readFile(...))`
  - `JSON.stringify(...)`
  - `config.json`
  - `config.v2.json`
  的散点读写与路径硬编码

因此：

> 这次迁移不能直接改扩展名，必须先收口为 path resolver SSOT + codec SSOT + semantic loader SSOT，再做 TOML shadow。

---

## 一、主用户配置当前主入口

### 1. Runtime 主加载入口

文件：

- `src/config/routecodex-config-loader.ts`

关键证据：

- `35-39`：读取主配置文件并直接 `JSON.parse`
- `41-44`：执行 V2 source 校验 / active group materialize / reasoningStopMode 投影
- `46-53`：调用 `buildVirtualRouterInputV2()` 并构建 provider profiles

说明：

- 这是**当前 runtime 语义主入口**
- 但它内部仍然直接绑定 JSON parse，因此未来要改成 shared codec，而不是继续在这里直接 `JSON.parse`

### 2. 当前配置路径解析

文件：

- `src/config/config-paths.ts`
- `src/config/unified-config-paths.ts`
- `src/config/user-data-paths.ts`

关键证据：

- `src/config/config-paths.ts:12-20`
  - `resolveRouteCodexConfigPath()` 已尝试统一路径解析
- `src/config/unified-config-paths.ts:60-68`
  - config preference 仍是 JSON 文件列表：
    - `config.v2.json`
    - `routecodex.json`
    - `config.json`
- `src/config/unified-config-paths.ts:194-196`
  - fallback 默认仍是 `config.json`
- `src/config/user-data-paths.ts:229-234`
  - `resolveRccConfigFile()` 直接返回 `~/.rcc/config.json`

结论：

- 路径层已经有统一化意图
- 但默认文件名真源仍是 JSON，尚未为 TOML shadow 做好 SSOT

---

## 二、provider 配置当前主入口

文件：

- `src/config/provider-v2-loader.ts`

关键证据：

- `66-68`：读取 provider 配置后直接 `JSON.parse`
- `190+`：`loadProviderConfigsV2()` 是 provider `config.v2.json` 主读取器
- `85-102`：文件名匹配只识别 `config.v2.json` 与其 JSON 变体

结论：

- provider 配置有局部主 loader
- 但同样是 JSON codec 内嵌，不是格式无关的 shared loader

---

## 三、散点读取：主配置没有全局唯一入口

以下文件都在直接读取主配置，而不是统一经过 shared codec。

### 1. CLI 运行控制

- `src/cli/commands/start.ts:190-199`
  - 直接 `readFileSync + JSON.parse`
- `src/cli/commands/stop.ts:89-97`
  - 直接 `readFileSync + JSON.parse`
- `src/cli/commands/restart.ts:158-169`
  - 直接 `readFileSync + JSON.parse`
- `src/cli/commands/restart.ts:205-218`
  - 再次直接读取 API key
- `src/cli/commands/launcher/utils.ts:155-177`
  - 直接读配置文件提取 apiKey
- `src/cli/commands/launcher/utils.ts:226-233`
  - 直接读配置文件提取 host/port

### 2. CLI 配置管理

- `src/cli/commands/config.ts:447-545`
  - `show / groups / current-group / validate-group / switch-group`
  - 大量直接 `JSON.parse(fs.readFileSync(configPath, 'utf8'))`

### 3. 主进程入口

- `src/index.ts:1159-1219`
  - 多处直接 `fs.readFile + JSON.parse`

### 4. HTTP admin / daemon admin

- `src/server/runtime/http-server/daemon-admin/routing-policy.ts:84-85`
  - 直接读取 JSON
- `src/server/runtime/http-server/daemon-admin/routing-policy.ts:131-139`
  - 直接读后再 `JSON.stringify` 原子写回
- `src/server/runtime/http-server/daemon-admin/providers-handler.ts:408-414`
- `src/server/runtime/http-server/daemon-admin/providers-handler.ts:450-456`
- `src/server/runtime/http-server/daemon-admin/providers-handler.ts:523-540`
- `src/server/runtime/http-server/daemon-admin/providers-handler.ts:593-598`
  - 都在直接 parse / write 主配置
- `src/server/runtime/http-server/daemon-admin/credentials-handler.ts:241-244`
  - 也直接读取 `config.json`

结论：

> `loadRouteCodexConfig()` 只是 runtime 主入口，不是全局唯一入口。

---

## 四、散点写回：主配置没有全局唯一 writer

### 1. CLI 写回

- `src/cli/commands/start.ts:224-227`
  - quota override 会生成临时 `config.json`
- `src/cli/commands/config.ts:544-545`
  - `switch-group` 直接 `JSON.stringify` 覆盖写回
- `src/cli/commands/init.ts` / `src/cli/commands/init/workflows.ts`
  - 初始化 / 迁移流程直接写 JSON 配置

### 2. HTTP admin 写回

- `src/server/runtime/http-server/daemon-admin/routing-policy.ts:138-140`
  - 原子写回仍是 JSON 序列化
- `src/server/runtime/http-server/daemon-admin/providers-handler.ts:414`
- `src/server/runtime/http-server/daemon-admin/providers-handler.ts:456`
- `src/server/runtime/http-server/daemon-admin/providers-handler.ts:540`
- `src/server/runtime/http-server/daemon-admin/providers-handler.ts:598`
  - 直接 `JSON.stringify(next, null, 2)`

结论：

- 当前主配置写回没有 comment-preserving writer
- 这也是为什么 TOML 迁移不能只做 parse，必须先做 codec + AST/patch writer

---

## 五、provider 配置也没有全局唯一读写入口

### 1. provider 配置读取散点

- `src/commands/provider-update.ts`
  - 直接读取 `config.v2.json`
- `src/commands/provider-update-maintenance.ts`
  - 多处直接读取 `config.v2.json`
- `src/cli/config/init-config.ts`
  - 初始化时直接写 `config.v2.json`
- `src/server/runtime/http-server/daemon-admin/providers-handler.ts`
  - provider admin 侧直接写 provider config 文件

### 2. provider 文件名真源仍绑死 JSON

关键证据：

- `src/config/provider-v2-loader.ts:85-102`
  - 只认 `config.v2.json`
- `src/cli/config/init-config.ts:179-185`
  - 初始化时直接输出 `config.v2.json`
- `src/commands/provider-update*.ts`
  - 直接构造 `config.v2.json` 路径

结论：

> provider 侧与主配置侧一样：有局部 loader，但没有全局唯一 codec / writer。

---

## 六、默认路径和文案硬编码位置

### 1. 默认主配置路径

- `src/config/user-data-paths.ts:229-234`
  - `resolveRccConfigFile() -> ~/.rcc/config.json`

### 2. 文案 / 帮助 / CLI 默认说明

- `src/cli/commands/init.ts:56`
  - 描述仍是 “Initialize ~/.rcc/config.json”
- `src/cli/commands/start.ts:181-186`
  - 错误提示仍指向 `~/.rcc/config.json`
- `src/cli/commands/port.ts:70`
  - 端口提示仍指向 `~/.rcc/config.json`
- `src/config/README.md:29`
  - validate 示例仍使用 `~/.rcc/config.json`

### 3. scripts / samples

仓内仍有大量脚本默认：

- `~/.rcc/config.json`
- `config.v2.json`

这些都必须在“切主链阶段”统一处理，不能遗漏。

---

## 七、为什么当前还不能直接切 TOML

原因不是“还没写 TOML parser”。

真正阻塞是三件事：

### 1. 读路径不统一

现在有：

- runtime loader
- CLI 直接读
- admin 直接读
- maintenance 直接读

如果现在直接切主链，会出现一部分路径读 TOML，一部分仍找 JSON。

### 2. 写回不是统一 writer

现在大量写回都是：

```text
parse -> object -> JSON.stringify -> overwrite
```

直接切 TOML 会导致：

- 注释全部丢失
- TOML 人工维护价值直接报废

### 3. provider 侧与主配置侧是两套散点链

不能只迁主配置，不迁 provider 配置；
否则会形成混合双真源。

---

## 八、迁移设计结论

基于这次审计，唯一正确的迁移顺序必须是：

1. 建立 path resolver SSOT
2. 建立 config codec SSOT
3. 建立 semantic loader SSOT
4. 建立 comment-preserving TOML writer
5. 先做 TOML shadow load
6. 做 JSON/TOML semantic compare
7. 让 CLI/admin/provider-update 写回也走 TOML shadow
8. shadow 全绿后，切换默认主链到 TOML
9. 清理旧 JSON 主链真源

---

## 九、与本次 `/goal` 的关系

这份审计文档对应 `/goal` 的第 1 条要求：

> 先审计当前配置读取/写回是否全局唯一，列出真正主入口、散点读取、散点写回、默认路径硬编码位置。

当前状态已经可以明确回答：

- **真正主入口**
  - `src/config/routecodex-config-loader.ts`
  - `src/config/provider-v2-loader.ts`
- **散点读取**
  - CLI / index / admin / maintenance 多处直接 `JSON.parse`
- **散点写回**
  - CLI / admin / init / provider-update 多处直接 `JSON.stringify`
- **默认路径硬编码**
  - `resolveRccConfigFile()` / `UnifiedConfigPathResolver` / CLI/help/scripts 大量写死 JSON

因此下一步的唯一正确动作不是立即改格式，而是：

> 按计划文件 `docs/plans/config-toml-migration-goal-plan.md` 进入 TOML shadow resolver/codec/loader 设计与实现。

