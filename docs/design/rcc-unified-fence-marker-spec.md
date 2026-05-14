# RCC 统一 Fence Marker 语法规范

## 索引概要
- L1-L7 `purpose`：为什么要废弃分散 inline marker，改成单一 fence。
- L9-L18 `design-principles`：单一语法、单一解析器、多行优先、fail-fast。
- L20-L45 `grammar`：正式语法与块结构。
- L47-L76 `parse-rules`：解析、校验、strip、错误处理规则。
- L78-L111 `ast`：统一解析产物 AST。
- L113-L170 `domain-semantics`：各 domain/action 的语义约束。
- L172-L223 `examples`：stopless / clock / stop_message / route / precommand 示例。
- L225-L246 `deprecation`：旧 marker 的废弃与删除原则。
- L248-L257 `uniqueness`：为什么这是唯一正确方向。

## 目标

当前 RouteCodex 的控制指令分散在多套 inline marker 中：`stopless`、`sm`、`clock`、`precommand`、route 指令各自维护自己的语法和 regex，已经不适合以下需求：

1. **复杂多行输入**：用户要直接人工输入目标、说明、证据、暂停原因。
2. **统一解析入口**：不能继续每个功能各搞一套 marker parser。
3. **单一真源**：所有 control marker 必须共享一套 grammar、一套 AST、一套错误语义。

因此，后续 RouteCodex 的私有控制指令统一改为**一个 fence + 一个 parser**。

## 设计原则

1. **只有一个 fence**：`<**rcc**> ... </rcc**>`。
2. **只有一个解析入口**：所有 marker 都先进入同一个 RCC fence parser，再分发到 domain resolver。
3. **多行优先**：正文不再塞进一行 marker；需要长文本时一律放 body。
4. **命令行尽量简单**：第一行只保留 `domain action [arg...]`。
5. **fail-fast**：语法错误、未知 domain/action、缺少必填 body 时直接报显式错误，不静默忽略。
6. **解析与语义分层**：parser 只产出 AST，不在 parser 层偷做 stopless/clock/route 的业务判断。
7. **禁止双真源兼容常驻**：旧 inline marker 只允许短期迁移，不允许长期并存。

## 正式语法

统一块语法：

```text
<**rcc**>
<domain> <action> [arg...]
<body...>
</rcc**>
```

### 词法约束

- 起始 fence 必须是精确字面量：`<**rcc**>`
- 结束 fence 必须是精确字面量：`</rcc**>`
- fence **不允许嵌套**
- 第一条**非空行**必须是 command line
- command line 之后的全部内容都归入 body
- `domain`、`action`、`arg` 以 ASCII 空白分隔
- command line **不支持引号语法**；需要多词文本时必须放进 body

### 标准块结构

```text
<**rcc**>
stopless start
把 provider 配置改成 per-port 独立
每个端口独立 mode
provider 模式支持 auto 选择 relay/direct
</rcc**>
```

其中：

- `domain = stopless`
- `action = start`
- `args = []`
- `body = "把 provider 配置改成 per-port 独立\n每个端口独立 mode\nprovider 模式支持 auto 选择 relay/direct"`

## 解析规则

### 1. 作用范围

- 只解析**最新一条 user 消息**中的 RCC fence。
- 同一条消息内允许出现多个 RCC fence，按**出现顺序**依次解析和应用。
- fence 外的普通文本仍然保留为用户可见内容；只有被命中的 fence block 才进入 RCC 私有控制通道。

### 2. block 识别

- 只有完整成对的 `<**rcc**> ... </rcc**>` 才是合法 block。
- 发现起始 fence 但缺少结束 fence：直接抛 `RCC_FENCE_UNCLOSED`，请求失败，不发上游。
- 发现嵌套 fence：直接抛 `RCC_FENCE_NESTED_UNSUPPORTED`，请求失败，不发上游。

### 3. command line 校验

- command line 至少包含两个 token：`domain action`
- token 不足时抛 `RCC_FENCE_INVALID_COMMAND_LINE`
- `domain` 未注册时抛 `RCC_FENCE_UNKNOWN_DOMAIN`
- `action` 不属于该 domain 时抛 `RCC_FENCE_UNKNOWN_ACTION`

### 4. body 校验

- body 是否必填、是否允许为空、是否允许透传给上游，由 domain resolver 决定。
- 若某 domain/action 要求 body 非空，但实际为空，抛 `RCC_FENCE_BODY_REQUIRED`。

### 5. strip / 透传规则

parser 只负责识别 block，不负责决定 body 去向。真正的 strip 语义由 domain resolver 决定：

- **private-only**：整个 block 都不透传上游，仅写本地状态或执行本地 side effect。
- **body-forward**：command line 只作为本地控制，body 变成当前轮真实用户输入继续透传。
- **state-only**：block 只改变 sticky/runtime state，不生成本轮上游文本。

### 6. 错误处理

- 所有已识别的 RCC fence 一旦非法，必须**显式报错**，禁止“忽略并继续”。
- 错误时不得写入部分状态。
- 错误时不得偷偷把原始 block 当普通文本透传给上游模型。

## 统一 AST

解析器输出统一 AST；业务层只消费 AST，不再自己扫 regex。

```ts
export type RccFenceBlock = {
  raw: string;
  startOffset: number;
  endOffset: number;
  commandLine: string;
  domain: string;
  action: string;
  args: string[];
  body: string;
};
```

建议再配一层语义解析产物：

```ts
export type RccDirective =
  | { type: 'stopless.start'; body: string }
  | { type: 'stopless.pause'; reason: string }
  | { type: 'stopless.resume'; note: string }
  | { type: 'stopless.stop'; reason: string }
  | { type: 'stopless.done'; evidence: string }
  | { type: 'clock.at'; at: string; message: string }
  | { type: 'clock.clear' }
  | { type: 'stop_message.set'; text: string }
  | { type: 'stop_message.clear' }
  | { type: 'route.use'; target: string }
  | { type: 'route.allow'; targets: string[] }
  | { type: 'route.disable'; targets: string[] }
  | { type: 'route.clear' }
  | { type: 'precommand.set'; target: string }
  | { type: 'precommand.clear' };
```

注意：**AST 是 parser 真源；Directive 是 domain resolver 真源。** 两者职责不能混。

## Domain 语义约束

### 1. stopless

目标：把 legacy `on/off/endless` 改造成类似 Codex `/goal` 的生命周期控制。

支持动作：

- `stopless start`
- `stopless pause`
- `stopless resume`
- `stopless stop`
- `stopless done`

语义要求：

| 命令 | body | 透传策略 | 说明 |
|---|---|---|---|
| `stopless start` | 必填 | `body-forward` | body 既写入 stopless goal state，也作为本轮真实用户目标发上游 |
| `stopless pause` | 可选 | `private-only` | body 作为暂停原因或等待说明 |
| `stopless resume` | 可选 | `private-only` | body 作为恢复说明 |
| `stopless stop` | 可选 | `private-only` | body 作为人工终止原因 |
| `stopless done` | 建议必填 | `private-only` | body 作为完成证据摘要 |

### 2. clock

支持动作：

- `clock at <RFC3339-or-local-time>`
- `clock clear`

语义要求：

| 命令 | args | body | 透传策略 |
|---|---|---|---|
| `clock at ...` | 必填 time | 可选 message | `private-only` |
| `clock clear` | 无 | 必须为空 | `state-only` |

### 3. stop_message

支持动作：

- `stop_message set`
- `stop_message clear`

语义要求：

| 命令 | body | 透传策略 |
|---|---|---|
| `stop_message set` | 必填 | `private-only` |
| `stop_message clear` | 必须为空 | `state-only` |

### 4. route

支持动作：

- `route use <target>`
- `route allow <target...>`
- `route disable <target...>`
- `route clear`

语义要求：

- route 类命令默认不需要 body。
- 目标选择、allowlist、disablelist 都只吃 args，不再混用多种 `<**...**>` 内联写法。

### 5. precommand

支持动作：

- `precommand set <file://... | default>`
- `precommand clear`

语义要求：

- `set` 必须带单个 target arg
- body 默认为空
- 仍沿用现有 `~/.rcc/precommand` 路径约束

## 标准示例

### stopless start

```text
<**rcc**>
stopless start
把 provider 配置改成 per-port 独立
每个端口独立 mode
provider 模式支持 auto 选择 relay/direct
</rcc**>
```

### stopless pause

```text
<**rcc**>
stopless pause
等待 Jason 确认 provider 路由策略
</rcc**>
```

### stopless resume

```text
<**rcc**>
stopless resume
</rcc**>
```

### stopless stop

```text
<**rcc**>
stopless stop
不再继续这个目标
</rcc**>
```

### stopless done

```text
<**rcc**>
stopless done
定向测试通过
build 通过
live 样本验证通过
</rcc**>
```

### clock at

```text
<**rcc**>
clock at 2026-05-15T10:30:00+08:00
检查 5520 端口 stopless live 回放结果
</rcc**>
```

### clock clear

```text
<**rcc**>
clock clear
</rcc**>
```

### stop_message set

```text
<**rcc**>
stop_message set
继续推进，直到拿到真实验证证据再停止。
</rcc**>
```

### route use

```text
<**rcc**>
route use openai.gpt-4.1
</rcc**>
```

### route allow

```text
<**rcc**>
route allow openai anthropic
</rcc**>
```

### precommand set

```text
<**rcc**>
precommand set <file://precommand/default.sh>
</rcc**>
```

## 旧语法废弃与删除原则

以下旧语法不再作为长期真源：

- `<**stopless:on**>`
- `<**stopless:off**>`
- `<**stopless:endless**>`
- `<**sm:...**>`
- `<**clock:{...}**>`
- `<**precommand:...**>`
- 各类 feature-specific `<**...**>` inline 私有扩展

迁移原则：

1. **统一先落到 RCC fence parser**。
2. **旧 parser 与新 parser 不长期并存**。
3. 一旦新语义切换完成，旧 regex/parser/文档/测试必须物理删除。
4. 不允许把 `stopless start` 再映射回 `stopless:on` 作为兼容常驻层；那会保留旧合同，等于没完成统一。

## 为什么这是唯一正确方向

1. **用户输入复杂多行文本**时，inline marker 天然不适配；fence 是唯一简单且稳的人工输入形式。
2. **统一一个 parser** 才能消除 stopless/sm/clock/precommand 各自 regex 漂移的问题。
3. **command line + body** 二段式结构，既保持手写简单，又能覆盖路由、状态切换、长文本目标、完成证据。
4. 如果继续保留多套 marker，只会把“语法问题”复制到每个 feature；这不是兼容，而是继续制造双真源。
