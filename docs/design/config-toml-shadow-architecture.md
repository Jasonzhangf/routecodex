# RouteCodex 配置 TOML Shadow 架构设计

## 目标

在不立刻切换 JSON 主链的前提下，建立一套可验证、可渐进替换的 TOML 平行实现：

- path resolver SSOT
- codec SSOT
- semantic loader SSOT
- JSON/TOML semantic compare
- comment-preserving TOML write path

该设计的用途是：

1. 让 TOML 能独立完成读取/解析/写回
2. 让 JSON / TOML 能用同一套语义 loader 做对齐
3. 让切主链前有可靠的 shadow 验证证据

---

## 一、设计原则

### 1. JSON 主链暂不立即删除

在 shadow 阶段：

- JSON 仍是当前运行主链
- TOML 是平行验证链
- 任何 TOML 结果都必须与 JSON 语义对齐

### 2. 不做长期双真源

shadow 的角色仅限于：

- parse / load 验证
- migration 验证
- comment-preserving write 验证
- 切换前回归验证

一旦 TOML 主链切换完成：

- JSON 主链真源必须删除
- 不能长期保留双格式运行入口

### 3. 统一语义、分离 codec

必须做到：

- JSON codec 与 TOML codec 分离
- semantic loader 共用
- path resolver 共用

不能做到：

- JSON 一套 materialize 逻辑
- TOML 再复制一套 materialize 逻辑

否则会形成第二语义面。

---

## 二、目标分层

```text
                  [ config path request ]
                           |
                           v
                 [ Path Resolver SSOT ]
                           |
             +-------------+-------------+
             |                           |
             v                           v
      [ JSON Codec ]               [ TOML Codec ]
             |                           |
             +-------------+-------------+
                           |
                           v
                [ Semantic Loader SSOT ]
                           |
         +-----------------+-----------------+
         |                 |                 |
         v                 v                 v
   runtime load      CLI/admin load    semantic compare
```

---

## 三、建议模块划分

## A. Path Resolver

### 1. 用户配置路径

建议新建：

- `src/config/user-config-path-resolver.ts`

职责：

- 解析显式 `--config`
- 解析 env 配置路径
- 解析默认主路径
- 在 shadow 阶段支持：
  - `config.json`
  - `config.toml`
- 输出：
  - path
  - format
  - source

### 2. Provider 配置路径

建议新建：

- `src/config/provider-config-path-resolver.ts`

职责：

- 给定 provider root / providerId
- 解析：
  - `config.v2.json`
  - `config.v2.toml`
- 在 shadow 阶段允许两者共存，但必须明确优先级与 compare 行为

---

## B. Codec SSOT

### 1. 用户配置 codec

建议新建：

- `src/config/user-config-codec.ts`

职责：

- parse JSON user config
- parse TOML user config
- 将原始文本转换为统一 `UnknownRecord`
- write JSON（仅迁移过渡/旧链）
- write TOML（comment-preserving）
- format detect

### 2. Provider 配置 codec

建议新建：

- `src/config/provider-config-codec.ts`

职责：

- parse provider JSON
- parse provider TOML
- 统一返回 `ProviderConfigV2` 语义结构
- comment-preserving TOML write

### 3. Comment-preserving update

建议新建：

- `src/config/toml-ast-update.ts`

职责：

- 保留 comment / section order / formatting
- 对指定 key-path 做 patch/update
- 支持插入缺失 section

约束：

- 不允许最终退化成“重新 stringify 整个 TOML”

---

## C. Semantic Loader SSOT

### 1. 用户配置语义加载

建议新建：

- `src/config/user-config-loader.ts`

职责：

- 消费 codec 输出的统一对象
- 校验 V2 source
- materialize active routing group
- project reasoningStopMode
- build VR input
- build provider profiles

说明：

当前 `src/config/routecodex-config-loader.ts` 最终应退化为壳层，内部委托给这里。

### 2. Provider 配置语义加载

建议新建：

- `src/config/provider-config-loader.ts`

职责：

- 扫描 provider 目录
- 解析 provider JSON/TOML
- 输出统一 provider config map

说明：

当前 `src/config/provider-v2-loader.ts` 最终应退化为壳层或被替代。

---

## D. Shadow Compare

建议新建：

- `src/config/config-semantic-compare.ts`

职责：

- 加载同一份配置的 JSON 真源
- 迁移/读取 TOML shadow
- 比较：
  - active routing group
  - routing policy payload
  - provider maps
  - virtual router input
  - provider profiles
  - capability metadata

输出：

- equal / diff
- diff 明细

---

## 四、Shadow 阶段的文件优先级

### 1. 用户配置

在 shadow 阶段建议行为：

- 默认 runtime 仍读当前 JSON 主链
- 若显式指定 TOML shadow 路径，则运行 TOML load
- compare 工具对同一配置做双边加载

因此 resolver 需要支持：

1. explicit path
2. JSON canonical
3. TOML shadow

### 2. Provider 配置

shadow 阶段建议：

- provider root 下允许同时存在：
  - `config.v2.json`
  - `config.v2.toml`
- compare 工具应优先成对比较同 provider 的两种格式

---

## 五、写回策略

## 1. JSON 写回

仅用于：

- 旧主链仍在时的历史兼容
- migration 前基线对照

不是最终形态。

## 2. TOML 写回

必须成为：

- CLI config 命令
- init / maintenance
- admin handlers
- provider-update

的统一目标 writer。

## 3. 为什么必须先做 writer 再切主链

如果 TOML 只能读不能保注释写：

- 用户第一次用 CLI/admin 改配置
- 注释就被洗掉
- TOML 作为“可维护配置真源”的目标立即失败

因此写回链不是附属功能，而是切主链前置条件。

---

## 六、测试骨架要求

## 1. 单元测试

- user JSON codec
- user TOML codec
- provider JSON codec
- provider TOML codec
- path resolver
- semantic loader
- shadow compare
- TOML comment-preserving update

## 2. 集成测试

- `loadRouteCodexConfig` 走 JSON
- `loadRouteCodexConfig` 走 TOML shadow
- `loadProviderConfigsV2` 走 JSON
- `loadProviderConfigsV2` 走 TOML shadow

## 3. CLI/admin 回归

- start / stop / restart / config / init
- provider-update / maintenance
- admin routing/provider/settings handlers

## 4. 注释保持测试

必须验证：

1. 初始 TOML 含注释
2. 更新后注释仍在
3. 未修改 section 未被整体清洗

---

## 七、切主链条件

只有以下全部满足时，才能把默认配置文件从 JSON 切到 TOML：

1. JSON/TOML semantic compare 全绿
2. CLI/admin/provider-update 的 TOML 路径全绿
3. comment-preserving write 全绿
4. grep 门禁证明主配置 / provider 配置散点读取已收口
5. docs / samples / init 默认模板 已切 TOML

---

## 八、为什么这是唯一正确设计

### 不是“每个 callsite 自己加 TOML.parse”

因为这样会复制 codec 语义，直接制造第二实现面。

### 不是“先把默认路径改成 TOML 再补其余”

因为当前读/写散点太多，先切默认路径只会制造半迁移状态。

### 不是“只做读，不做注释写回”

因为这会导致 TOML 配置一旦被 CLI/admin 更新就丢失人工注释，目标直接失败。

因此唯一正确路线是：

> 先建立 resolver/codec/loader 真源与 TOML shadow compare，再切主链。

