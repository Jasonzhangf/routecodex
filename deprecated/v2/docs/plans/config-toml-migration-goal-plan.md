# RouteCodex 配置迁移详细计划：JSON -> TOML

> 2026-07-07 status: this plan is historical for the removed JSON/TOML shadow phase. Do not recreate `src/config/config-semantic-compare.ts`; it was deleted as dead code after JSON/v1/shadow support removal.

## 目标

把 RouteCodex 的**人工维护配置真源**从 JSON 渐进式迁移到 TOML，并建立**全局唯一**的配置路径解析、配置 codec、语义加载链。

迁移策略不是一步替换，而是：

1. 先新增 TOML 平行实现（shadow path）
2. 用同一份语义测试验证 JSON / TOML 等价
3. 等 TOML shadow 通过后，再把主链默认真源切到 TOML
4. 最后移除 JSON 主链真源

最终目标：

- 主用户配置默认真源：`~/.rcc/config.toml`
- Provider 配置默认真源：`~/.rcc/provider/<providerId>/config.v2.toml`
- 所有人工维护配置读/写都必须通过统一入口
- TOML 文件必须带 feature 注释，且后续写回不能洗掉注释

---

## 一、当前审计结论

### 1. 当前并非“全局唯一配置读取”

当前只有“局部主入口”，不是全局唯一：

- 主 runtime 用户配置主入口：
  - `src/config/routecodex-config-loader.ts`
- provider v2 配置主入口：
  - `src/config/provider-v2-loader.ts`
- 统一路径解析意图：
  - `src/config/config-paths.ts`
  - `src/config/unified-config-paths.ts`

但大量调用点仍然直接：

- `readFileSync/readFile`
- `JSON.parse`
- `JSON.stringify`
- 手写 `config.json` / `config.v2.json`

典型散点：

- `src/cli/commands/start.ts`
- `src/cli/commands/stop.ts`
- `src/cli/commands/restart.ts`
- `src/cli/commands/config.ts`
- `src/cli/commands/init.ts`
- `src/cli/commands/launcher/utils.ts`
- `src/index.ts`
- `src/server/runtime/http-server/daemon-admin/*.ts`
- `src/commands/provider-update.ts`
- `src/commands/provider-update-maintenance.ts`

### 2. 当前默认路径仍然强绑定 JSON

- `src/config/user-data-paths.ts`
  - `resolveRccConfigFile()` 直接返回 `config.json`
- `src/config/unified-config-paths.ts`
  - preference / fallback 仍优先 JSON
- 多个 CLI/help/scripts 文案仍写死 `~/.rcc/config.json`

### 3. 当前最大风险不是“解析 TOML”，而是“写回后丢注释”

目前大量更新逻辑采用：

```text
parse -> object -> stringify -> overwrite
```

如果直接照搬到 TOML，会出现：

- 注释丢失
- 顺序漂移
- 人工排版丢失
- CLI/admin 改一次配置后，注释模板全部报废

所以迁移成功的关键不是 TOML.parse，而是：

> 必须建立 comment-preserving TOML writer / updater。

---

## 二、迁移范围

### In Scope：人工维护配置真源

1. 主用户配置
   - `~/.rcc/config.json` -> `~/.rcc/config.toml`
2. Provider 配置
   - `~/.rcc/provider/*/config.v2.json` -> `config.v2.toml`
3. 默认模板 / sample / init 产物 / CLI 输出示例 / docs / scripts 中涉及人工维护配置的部分

### Out of Scope：机器态文件

以下不迁移到 TOML：

- token files
- auth state
- pid / lock / guardian state
- history / quota snapshots
- replay / debug snapshots
- error samples / codex samples
- traffic governor state

原因：这些不是“带注释的人类编辑配置真源”。

---

## 三、唯一正确的改造切点

不能直接把 `config.json` 改成 `config.toml` 并立刻切主链。

唯一正确的切点是：

> 先建立 TOML 平行实现与统一真源，再通过 shadow 测试证明语义等价，最后切换默认主链。

迁移期允许存在 **短期平行实现**，但它的角色仅限于：

- shadow load
- semantic compare
- migration verification
- comment-preserving write verification

它不是长期 fallback，不允许无限期 JSON/TOML 双真源并存。

因此第一步仍然是建立三层单一真源：

### 1. Path Resolver 真源

统一负责：

- 默认配置路径
- 显式 `--config`
- 环境变量覆盖
- provider 配置路径约定
- config 目录扫描

### 2. Codec 真源

统一负责：

- parse TOML
- validate shape
- serialize TOML
- comment-preserving update
- JSON -> TOML migration

### 3. Semantic Loader 真源

统一负责：

- materialize active policy group
- build virtual router input
- build provider profiles
- project env-derived runtime options

只有这样，才能避免：

- 第二真源
- CLI/admin 各自实现一份 TOML parse
- 注释在某些路径保留、某些路径丢失

---

## 四、目标架构

```text
user/provider config path request
        |
        v
  [Path Resolver SSOT]
        |
        v
 [TOML Codec + AST Update SSOT]
        |
        +--> parse raw TOML
        +--> schema validate
        +--> comment-preserving patch/write
        +--> explicit JSON->TOML migration
        |
        v
 [Semantic Loader SSOT]
        |
        +--> materialize active routing group
        +--> build VR input
        +--> load provider configs
        +--> build provider profiles
        |
        v
runtime / CLI / admin / maintenance / init
```

迁移期还需要一条 shadow 对照链：

```text
JSON config truth ----\
                       > semantic compare / round-trip compare / regression
TOML config shadow ---/
```

切换条件：

- TOML shadow 在主配置与 provider 配置上都通过语义对齐测试
- comment-preserving 写回测试通过
- 所有关键 CLI/admin/provider-update 路径都能走 TOML

---

## 五、建议模块拆分

文件名可微调，但职责必须单一。

### A. 主用户配置

- `src/config/user-config-path-resolver.ts`
  - 用户配置路径解析唯一真源
- `src/config/user-config-codec.ts`
  - 主用户配置 TOML parse / validate / write / patch
- `src/config/user-config-loader.ts`
  - 主用户配置语义加载

### B. Provider 配置

- `src/config/provider-config-path-resolver.ts`
  - provider `config.v2.toml` 路径真源
- `src/config/provider-config-codec.ts`
  - provider TOML parse / validate / write / patch
- `src/config/provider-config-loader.ts`
  - provider 语义加载

### C. 共用基础

- 默认 TOML 模板文件已在 config Rust 收口中删除；不要复活 `src/config/toml-commented-template.ts`。
- `src/config/toml-ast-update.ts`
  - comment-preserving update 核心逻辑
- `src/config/config-migration-json-to-toml.ts`
  - 显式迁移命令底层实现

### D. 兼容壳层 / shadow 期桥接

旧文件可以保留薄壳，但不能保留旧语义：

- `src/config/routecodex-config-loader.ts`
  - 最终应成为 `user-config-loader` 的薄壳
- `src/config/provider-v2-loader.ts`
  - 最终应成为 `provider-config-loader` 的薄壳，或被新 loader 取代

### E. shadow 对照模块（已废弃）

- `src/config/config-semantic-compare.ts`
  - JSON/TOML 加载结果语义对比
- `src/config/config-shadow-load-report.ts`
  - shadow 验证输出 / diff / evidence

---

## 六、TOML 结构设计要求

### 1. 主用户配置 `config.toml`

必须覆盖现有 V2 语义：

- `version`
- `virtualrouterMode`
- `[httpserver]`
- `[virtualrouter]`
- `[virtualrouter.routingPolicyGroups.<group>]`
- `routing`
- `loadBalancing`
- `classifier`
- `health`
- `contextRouting`
- `webSearch`
- `execCommandGuard`
- `session`

### 2. Provider 配置 `config.v2.toml`

必须覆盖：

- `version`
- `providerId`
- provider 元信息
- defaults
- models
- capabilities
- auth / token / cookie / browser / endpoint 相关字段
- provider-native feature 配置（如 web search binding、multimodal、thinking 等）

---

## 七、注释设计要求

TOML 中必须为每个重要功能块写注释，不允许只给 sample 写、不进实际默认配置。

至少包含：

### 主用户配置注释

- `httpserver.host`
- `httpserver.port`
- `httpserver.apikey`
- `virtualrouter.activeRoutingPolicyGroup`
- `routingPolicyGroups`
- `routing.default`
- `routing.multimodal`
- `routing.web_search`
- `loadBalancing`
- `classifier`
- `health`
- `contextRouting`
- `webSearch.engines`
- `execCommandGuard`
- `session.reasoningStopMode`

### Provider 配置注释

- provider 基本用途
- `defaultModel`
- `models.<id>`
- `capabilities`
- `supportsMultimodal` / `supportsVision`
- `webSearch` binding
- 鉴权字段说明
- 风险字段说明（cookie/token/browser）

---

## 八、写回策略（最关键）

### 必须满足

1. CLI/admin 修改一个字段时：
   - 不得整文件重排为无注释数据
2. 未修改区域：
   - 注释必须保留
3. 插入新字段时：
   - 需要插入到合理 section
   - 必要时带对应注释

### 推荐实现方式

优先级如下：

1. **AST / CST 级更新**
   - 最佳方案
   - 可保留 comments / order / formatting
2. **模板锚点 patch**
   - 若 TOML 生态库不满足，可通过 section-aware patch 实现
3. **纯 stringify 覆盖**
   - 禁止作为最终方案

### 成功标准

必须有测试证明：

- 原配置含注释
- 通过 CLI/admin 更新字段
- 更新后原注释仍在

---

## 九、实施顺序

### Phase 1：收口路径解析（先不切默认格式）

目标：

- 把主用户配置与 provider 配置的路径解析统一到唯一 resolver
- 先支持显式 TOML shadow 路径，但暂不立即切默认主路径

动作：

1. 新建 path resolver 真源
2. 替换 `resolveRccConfigFile()` / config path scan / admin path lookup 中的硬编码
3. 更新帮助文案与默认路径说明

验收：

- path resolver 已能统一解析 JSON/TOML 候选
- 所有 callsite 改为依赖 resolver，而不是手写文件名

### Phase 2：建立 TOML codec（平行实现）

目标：

- parse / validate / write / patch 统一收口
- TOML 作为 shadow codec 落地，不立即替换 JSON 主链

动作：

1. 选择 TOML 解析方案
2. 实现主配置 codec
3. 实现 provider 配置 codec
4. 实现 JSON -> TOML migration converter

验收：

- TOML round-trip 稳定
- shape 不漂移
- JSON/TOML 可进入 semantic compare

### Phase 3：注释保留写回

目标：

- 建立 comment-preserving writer

动作：

1. 设计 section-aware update API
2. 接入 CLI / admin / config maintenance
3. 为 sample / init 模板生成注释版 TOML

验收：

- 修改字段后注释仍在

### Phase 4：接入语义加载链（shadow load）

目标：

- 在不破坏 JSON 主链的前提下，让 TOML loader 能完整跑通同一套语义加载链

动作：

1. 主用户配置 loader 支持 JSON / TOML 共享 semantic loader
2. provider loader 支持 JSON / TOML 共享 semantic loader
3. 保持 JSON 当前主链不动，新增 TOML shadow load 与 compare

验收：

- VR / provider profile / runtime 语义在 JSON/TOML 两侧一致
- semantic compare 可给出稳定证据

### Phase 5：替换散点调用到统一 resolver + codec

目标：

- 消灭人工维护配置散点 JSON parse/write

动作：

1. 替换 start / stop / restart / launcher
2. 替换 config/init/provider-update/admin
3. 替换 docs / sample / scripts

验收：

- 主配置 / provider 配置的读写全部走统一 codec

### Phase 6：显式迁移命令 + shadow 验证

目标：

- 提供一次性 JSON -> TOML 迁移命令
- 用迁移产物参与 shadow 验证

动作：

1. 迁移主配置
2. 迁移 provider configs
3. 输出迁移报告与 diff

约束：

- 仅作为显式迁移入口
- 不是运行时长期双格式 fallback
- shadow 期允许平行存在，但必须有退出条件

### Phase 7：切换默认主链到 TOML

前置条件（必须全部满足）：

1. 主用户配置 shadow load 通过
2. provider TOML shadow load 通过
3. JSON/TOML semantic compare 回归通过
4. CLI/admin/provider-update 写回 TOML 不丢注释
5. grep 门禁证明新的配置读写已收口

动作：

1. 默认主用户配置路径切到 `config.toml`
2. 默认 provider 配置路径切到 `config.v2.toml`
3. CLI/help/docs/sample 默认文案切到 TOML
4. 运行完整回归

### Phase 8：清理旧真源

目标：

- 删除旧 JSON 长期运行真源

动作：

1. 删除旧模板与旧主链引用
2. 保留迁移命令需要的最小旧格式读取能力
3. 清理死代码

---

## 十、测试计划

### 1. 单元测试

必须新增：

- user config TOML parse
- provider TOML parse
- path resolver
- active routing policy materialization
- provider loader
- JSON -> TOML migration
- comment-preserving update

### 2. 回归测试

必须覆盖：

- `rcc start`
- `rcc stop`
- `rcc restart`
- `rcc config ...`
- `rcc init`
- admin handlers
- provider update / maintenance
- runtime config load

### 2.5 Shadow 语义对齐测试（新增）

必须新增：

1. 同一份 JSON 配置迁移成 TOML
2. 分别走 JSON loader / TOML loader
3. 比较输出语义：
   - active routing group
   - virtual router input
   - provider profiles
   - provider capability metadata
4. 若不等价，禁止切主链

### 3. 注释保留测试

关键强制项：

1. 准备带注释 TOML
2. 通过 CLI/admin 修改某字段
3. 断言：
   - 目标字段变化正确
   - 无关注释仍存在
   - 未修改 section 未被整体清洗

### 4. 样例测试

- annotated 主配置 sample
- annotated provider sample
- sample 能直接启动/校验

### 5. 静态门禁

必须增加 grep/测试门禁，阻止未来回退到散点 JSON 配置读取：

- 主用户配置相关 callsite 不得直接 `JSON.parse(readFile(config...))`
- provider 配置相关 callsite 不得直接 `JSON.parse(readFile(config.v2...))`

### 6. 迁移测试

- old JSON -> TOML 成功
- semantic round-trip 等价
- migration 后启动正常

### 7. 切换门禁测试

在切默认主链前，必须证明：

- TOML-only 路径下 start/stop/restart/config/init 全通过
- provider-update / maintenance 对 `config.v2.toml` 全通过
- 注释保留回归通过
- grep 门禁无新的散点读取

---

## 十一、提交前验收清单

只有全部满足才允许宣称完成：

1. TOML shadow load 与 semantic compare 已通过
2. 默认主配置真源已切为 `config.toml`
3. 默认 provider 真源已切为 `config.v2.toml`
4. 所有人工维护配置读/写走统一 resolver + codec + loader
5. 不再存在运行主链散点 JSON 配置读取/写回
6. 注释在实际写回后保留
7. CLI/admin/provider-update/sample/docs 已迁移
8. 迁移命令存在且可验证
9. 测试、回归、grep 门禁全部通过

---

## 十二、为什么这是唯一正确方案

### 不是“只改扩展名”
因为路径解析、parse、write、help、scripts、admin、provider-update 都分散；只改扩展名会留下第二真源。

### 不是“先双格式长期共存”
因为这会形成长期 fallback / 双真源，违背项目硬护栏。

### 但必须允许短期 shadow 平行实现
因为主配置链和 provider 配置链散点很多，且存在注释保留风险；不经过 shadow compare 就直接切 TOML 主链，无法证明语义等价，也无法证明不会破坏 CLI/admin 写回链。

因此：

- **短期平行实现** 是验证手段
- **长期双真源共存** 是禁止的

### 不是“只把 sample 改成带注释 TOML”
因为 CLI/admin 一次写回就会把注释洗掉，属于伪完成。

### 不是“每个 callsite 自己加 TOML.parse”
因为这会复制 codec 语义，制造第三层重复实现面。

因此唯一正确方案只能是：

> 统一 path resolver -> 建立 TOML shadow codec -> 建立 comment-preserving writer -> 接入统一 semantic loader -> 做 JSON/TOML semantic compare -> 替换所有 callsite -> 切 TOML 主链 -> 删除旧 JSON 主链真源。

---

## 十三、建议的执行提示

执行时必须遵循闭环：

1. 分析
2. 设计
3. 修改
4. 测试
5. review
6. 提交

每轮结束必须输出：

- 当前进展
- 证据
- 风险
- 下一步
