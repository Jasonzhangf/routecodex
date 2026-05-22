# Hashline Native Edit Semantic 设计（Rust-only 语义真源方案）

## 目标

本文定义 hashline edit 语义在 `router-hotpath-napi` 的 Rust-only 设计。

**2026-05-21 纠偏后的唯一主线：**

1. **客户端外部契约始终是 `apply_patch`**
2. **上游模型 authoring 主路径默认切到 hashline**
3. **Rust 在 ingress/egress 透明桥接：hashline ↔ canonical apply_patch**
4. **TS 只保留 transport / native 调用薄壳**

也就是说：

- client 请求进来时，看到的仍然是 `apply_patch` tool
- 发给上游模型时，不应把 canonical apply_patch grammar 当主 authoring 语义反复教模型
- 应改为：当 schema 明确声明 `filePath/file_path` 时，**上游 authoring 主路径是 hashline**，不要再把 `*** Begin Patch` 当这一路的主提示
- 上游回来的 hashline 结果，在 Rust 真源里转换成 canonical `*** Begin Patch ... *** End Patch`
- 返回给 client 的仍然是透明的 `apply_patch` canonical 语义

因此，hashline 不是“另一个工具”，也不是 fallback；它是 **apply_patch 的上游 authoring 协议**。

1. **hashline 解析真源统一到 Rust**
2. **锚点 hash 校验与 apply 语义统一到 Rust**
3. **输出统一标准化 changeset + apply_patch 文本契约**
4. **Hub inbound 归一化集成点只保留单一路径，不允许 TS 语义分叉**

目标不是“新增一个 parser 文件”，而是把 `< / + / - / =` 编辑语义完整收敛为单一原生子系统，并让 `apply_patch` 的上游 authoring/下游客户端契约都经由这个子系统透明桥接；TS 仅保留 transport shell。

## 背景与问题陈述

在当前 Hub inbound tool_call 归一化链路中，apply_patch 语义存在三个结构性风险：

1. **编辑语义分散**：解析、校验、apply、输出若分布在 TS/Rust 多处，会产生漂移。
2. **锚点校验不统一**：`-`/`=` 的语义依赖“目标行未漂移”这一事实，若无统一 hash 校验，会出现“改错行但不报错”。
3. **产物契约不稳定**：下游只应消费统一 `*** Begin Patch` 形状；若 emit 多实现并存，行为不可预期。

因此需要把 hashline native edit 建成一个完整 Rust pipeline，并在 inbound normalization 单点接入。

## 硬约束

1. **唯一入口链路不变**：
   `HTTP server -> llmswitch-core Hub Pipeline -> inbound tool_call normalization -> downstream`
2. **Rust-only 语义真源**：hashline parse/hash/apply/emit 不允许 TS duplicate 实现。
3. **Fail-fast + no fallback**：解析错误、锚点冲突、越界必须显式结构化错误。
4. **Phase 1 仅支持单文件 update-only**：超出范围（多文件/创建/删除）显式报错。
5. **变更最小化**：集成点只新增必要调用与契约映射，不扩散到不相关路径。
6. **禁止双 authoring 语义并存**：同一条上游请求里，不能同时让模型在 canonical apply_patch grammar 与 hashline grammar 之间自由选择。

## 设计目标与非目标

### 设计目标

1. 支持 `< / + / - / =` 四类 op 的严格解析。
2. 支持 `bigram table + xxHash32 mod 647` 行级锚点 hash，作为 `-`/`=` 真值校验。
3. 支持按行号 bucket + bottom-up apply，避免行偏移污染。
4. 产出统一 `HashlineChangeset`，并可稳定 emit 为 `*** Begin Patch` 格式。
5. 在 `hub_req_inbound_tool_call_normalization.rs` 单点集成，确保上游/下游契约稳定。
6. 在 request tool mode / request guidance 真源中，明确：
   - client-facing tool 仍叫 `apply_patch`
   - upstream authoring mode 在声明 `filePath/file_path` 时切到 `hashline`

### 非目标

1. Phase 1 不做多文件协调 apply。
2. Phase 1 不做 create/delete/rename 文件语义。
3. Phase 1 不做“模糊匹配补救”或任何 fallback。
4. 不在 TS 侧保留第二份 hashline apply 逻辑。

## 架构总览

### 总体分层

```text
inbound normalization orchestrator
  -> hashline_parser (operation parse)
  -> hashline_hash (anchor hash compute/verify)
  -> hashline_apply (validate + plan + apply)
  -> hashline_to_apply_patch (projection to patch text)
  -> normalized tool_call payload
```

### 数据流 ASCII 图

```text
client apply_patch tool
  |
  v
request mode resolver
  -> choose: schema | hashline
  -> if hashline: expose hashline authoring contract upstream
  |
  v
upstream model output
  |
  v
hub_req_inbound_tool_call_normalization.rs
  |
  | run_hashline_native_edit_json(...)
  v
+-------------------------+
| hashline_parser.rs      |
| parse < + - = + payload |
+-----------+-------------+
            |
            v
+-------------------------+
| hashline_hash.rs        |
| bigram + xxhash32 %647  |
+-----------+-------------+
            |
            v
+-------------------------+
| hashline_apply.rs       |
| anchor validate         |
| bucket-by-line          |
| bottom-up apply         |
| -> HashlineChangeset    |
+-----------+-------------+
            |
            v
+-------------------------------+
| hashline_to_apply_patch.rs    |
| emit *** Begin/End Patch text |
+-----------+-------------------+
            |
            v
normalized canonical apply_patch tool_call
            |
            v
Hub downstream pipeline
```

### Rust / TS 边界

#### Rust 必须负责

- 语法解析、锚点 hash、apply 计划、冲突语义、patch emit。
- 标准化错误分类与字段。
- NAPI 导出稳定契约。

#### TS 仅可保留

- native 调用壳与 JSON 编解码。
- 返回值桥接与日志投影。

> 禁止 TS 再实现一份 hashline parser/hash/apply 作为补偿路径。

## 模块设计

建议目录：
`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hashline/`

### 1) `hashline_types.rs`（数据结构）

职责：定义稳定 blocks，不承载流程。

核心结构：

- `OpKind`：`Context(<)` / `Insert(+)` / `Delete(-)` / `Replace(=)`
- `HashlineOp`
  - `op: OpKind`
  - `file_path: Option<String>`（Phase 1 可为空或单值）
  - `line_num: Option<u32>`（1-based 输入行号）
  - `payload: Vec<String>`
  - `anchor_bigram: Option<u32>`（仅 `-`/`=` 必填）
  - `src_line: u32`（源 patch 行号，错误定位用）
- `ApplyResult`
  - `file_path`
  - `op`
  - `line_idx`（0-based）
  - `old_hash/new_hash`
  - `lines`
- `HashlineChangeset`
  - `file_path`
  - `results: Vec<ApplyResult>`（按 apply 顺序稳定）
  - `has_conflict`
  - `conflicts: Vec<HashlineConflict>`
- `HashlineError`（详见错误分类）

设计规则：

1. type 只定义 shape，不做业务判断。
2. 错误字段必须可回放（包含 op index / src line / expected/computed）。
3. changeset 是下游唯一消费块，避免散点字段传递。

### 2) `hashline_hash.rs`（哈希计算）

职责：行级锚点 hash 的唯一实现。

算法：

1. 基于固定 `BIGRAM_TABLE[256]` 对字符窗口混合。
2. 经 `xxHash32` 风格 finalize。
3. 最终取模 `647`（prime）得到稳定小域 hash。

导出函数：

- `compute_line_hash(line: &str) -> u32`
- `verify_anchor(line: &str, expected: u32) -> bool`
- `compute_line_hashes(lines: &[String]) -> Vec<u32>`

约束：

- seed 与 table 必须固定，保证跨平台确定性。
- hash 语义变更必须视作 breaking（需版本门禁）。

### 3) `hashline_parser.rs`（解析 `< / + / - / =` + payload）

职责：把 patch 文本解析为 `Vec<HashlineOp>`。

规则：

1. `<`：上下文声明 op（不直接改内容）。
2. `-`：删除 op，必须包含 `line_num + anchor_bigram`。
3. `=`：替换 op，必须包含 `line_num + anchor_bigram + payload`。
4. `+`：插入 op，支持带行号或 append。
5. payload 归属采用“头 op + 连续正文”规则；到下一个 op 前都归当前 replace/insert。

导出：

- `parse_hashline_ops(patch_body: &str) -> Result<Vec<HashlineOp>, HashlineError>`

fail-fast：

- 非法前缀、缺 anchor、缺 payload、坏行号直接 `ParseError`。

### 4) `hashline_apply.rs`（anchor 校验 + bucket-by-line + bottom-up apply）

职责：执行编辑语义并返回标准 changeset。

流程：

1. **Anchor validation**
   - 对每个 `-`/`=`：取目标行，计算 hash，与 `anchor_bigram` 比较。
   - mismatch 立即记录冲突并返回结构化错误（或冲突 changeset，取决于 flag）。

2. **Bucket by line**
   - Phase 1：单文件 bucket。
   - 同行多操作冲突检测（例如同一行同时 delete+replace）。

3. **Bottom-up apply**
   - 按 `line_idx DESC` 执行，规避前序变更导致的偏移。

4. **Return standardized changeset**
   - 包含每步 old/new hash、影响行、冲突信息。

导出：

- `apply_hashline_ops(ops, file_path, file_content) -> Result<HashlineChangeset, HashlineError>`
- `materialize_changeset(changeset, file_content) -> Result<String, HashlineError>`（可选）

### 5) `hashline_to_apply_patch.rs`（emit apply_patch）

职责：把 `HashlineChangeset` 投影成标准 `*** Begin Patch` 文本。

输出契约：

```text
*** Begin Patch
*** Update File: <path>
@@ ... @@
-...
+...
*** End Patch
```

导出：

- `emit_apply_patch(changeset: &HashlineChangeset) -> String`

规则：

1. 保证 header/footer 恒定。
2. section 顺序稳定（按文件、按行）。
3. 不输出未执行或冲突未解决的 op。

### 6) 集成点：`hub_req_inbound_tool_call_normalization.rs`

集成目标：在 inbound tool_call 归一化中，对目标 apply_patch payload 调用 native hashline pipeline。

建议流程：

1. client-facing tools 中识别 `tool_name == "apply_patch"`。
2. request tool-mode resolver 判断：
   - 若 schema 未声明 `filePath/file_path` → mode=`schema`
   - 若 schema 已声明 `filePath/file_path` → mode=`hashline`
3. mode=`hashline` 时，上游 guidance / tool description / req profile 统一引导模型输出 hashline patch。
4. ingress 收到 `apply_patch` tool call 后：
   - 若 `args.patch` 是 hashline 模式 → 调用 `run_hashline_native_edit_json`
   - 若 `args.patch` 已是 canonical apply_patch → 走 canonical shape normalize
5. hashline native edit 输出：
   - `changeset`
   - `normalized_patch`
   - `errors/conflicts`
6. 对外统一回写 canonical apply_patch `{patch,input}`；client 不感知 hashline 中间层。

## 单一路径约束（2026-05-21 新增）

1. **client/tool surface**
   - 对 client 永远只暴露 `apply_patch`
   - 不新增 `hashline_patch`、`native_edit` 之类第二工具名

2. **upstream authoring**
   - 若 `apply_patch` schema 声明了 `filePath/file_path`，默认 authoring 主路径就是 hashline
   - 不再把 canonical apply_patch grammar 当成这一路的主 authoring 提示

3. **Rust transparent bridge**
   - upstream hashline → Rust native parse/apply/emit → canonical apply_patch
   - 返回 client 的始终是 canonical apply_patch 语义

4. **fail-fast**
   - hashline 缺 `filePath/file_path`
   - hashline anchor 校验失败
   - hashline parse 失败
   都必须显式失败，禁止偷偷退回 canonical 猜测或第二套 authoring
3. 按 feature flag 决定：
   - 严格模式：有错即 fail-fast 返回结构化错误。
   - 兼容观测模式：保留原请求并附 diagnostic（仅灰度）。
4. 回填 `tool_call.arguments.patch = normalized_patch`。

约束：

- 此处仅做 orchestration 与契约映射，不重写 parse/apply 逻辑。

## Type 定义（TypeScript 参考）

```ts
export type OpKind = "context" | "insert" | "delete" | "replace";

export interface HashlineOp {
  op: OpKind;
  filePath?: string;
  lineNum?: number; // 1-based input
  payload: string[];
  anchorBigram?: number;
  srcLine: number;
}

export interface ApplyResult {
  filePath: string;
  op: OpKind;
  lineIdx: number; // 0-based
  oldHash?: number;
  newHash?: number;
  lines: string[];
}

export interface HashlineConflict {
  kind: "AnchorMismatch" | "LineNotFound" | "MultiFileUnsupported" | "OpConflict";
  opIdx: number;
  lineNum?: number;
  message: string;
}

export interface HashlineChangeset {
  filePath: string;
  results: ApplyResult[];
  hasConflict: boolean;
  conflicts: HashlineConflict[];
}

export interface HashlineNativeEditResult {
  ok: boolean;
  normalizedPatch?: string;
  changeset?: HashlineChangeset;
  error?: HashlineErrorShape;
}

export interface HashlineErrorShape {
  code:
    | "HASHLINE_PARSE_ERROR"
    | "HASHLINE_ANCHOR_MISMATCH"
    | "HASHLINE_LINE_NOT_FOUND"
    | "HASHLINE_MULTI_FILE_UNSUPPORTED"
    | "HASHLINE_EMPTY_PATCH"
    | "HASHLINE_INTERNAL_ERROR";
  message: string;
  srcLine?: number;
  opIdx?: number;
  expected?: number;
  computed?: number;
}
```

> TS 类型仅用于桥接与观测，不是语义真源。

## 错误分类（Error Taxonomy）

统一错误码（Rust authoritative）：

1. `HASHLINE_PARSE_ERROR`
   - 非法前缀、坏行号、缺 payload、缺 anchor。
2. `HASHLINE_ANCHOR_MISMATCH`
   - `-`/`=` 目标行 hash 与期望不一致。
3. `HASHLINE_LINE_NOT_FOUND`
   - 行号越界或目标行不存在。
4. `HASHLINE_OP_CONFLICT`
   - 同行不兼容组合操作。
5. `HASHLINE_MULTI_FILE_UNSUPPORTED`
   - Phase 1 收到多文件 patch。
6. `HASHLINE_EMPTY_PATCH`
   - 空输入。
7. `HASHLINE_INTERNAL_ERROR`
   - 不应发生的内部异常（必须保留 diagnostic_id）。

错误策略：

- 默认 fail-fast，不做 silent fallback。
- 错误响应必须带可定位字段（`srcLine/opIdx/expected/computed`）。

## Feature Flag 设计

建议 flags：

```toml
[runtime.hashline_native_edit]
enabled = false
phase = 1
strict_mode = true
emit_changeset_diagnostics = true
```

语义：

1. `enabled`
   - false：不触发 native hashline pipeline。
   - true：进入 Rust 语义路径。
2. `phase`
   - `1`：单文件 update-only。
   - `2`：多文件。
   - `3`：增强错误语义/冲突恢复协议。
3. `strict_mode`
   - true：任何 hashline 错误直接失败。
   - false：仅允许灰度观测（生产默认 true）。
4. `emit_changeset_diagnostics`
   - 输出标准诊断块用于 snapshot 与回归比对。

## 测试策略

### 1) Unit Tests

覆盖模块：

- `hashline_hash.rs`
  - 同输入同 hash、跨平台确定性、边界字符。
- `hashline_parser.rs`
  - 四类 op 正常解析、payload 归属、非法输入报错。
- `hashline_apply.rs`
  - anchor 命中/不命中、越界、同线冲突、bottom-up 顺序。
- `hashline_to_apply_patch.rs`
  - header/footer、section 顺序、文本稳定性。

### 2) Integration Tests

场景矩阵：

1. 单文件 replace 成功。
2. delete + insert 组合成功。
3. anchor mismatch fail-fast。
4. 行号越界 fail-fast。
5. multi-file 输入在 Phase 1 明确拒绝。
6. inbound normalization 端到端：tool_call 入 -> normalized patch 出。

### 3) Snapshot 字段

建议 snapshot 固定字段：

- `normalized_patch`
- `changeset.file_path`
- `changeset.results[].{op,line_idx,old_hash,new_hash}`
- `has_conflict`
- `conflicts[].{kind,op_idx,line_num,message}`
- `error.code/message`

> snapshot 只比对稳定语义字段，排除时间戳/随机 id。

## 分阶段发布计划

### Phase 1：Single-file update-only

范围：

- 支持 `< + - =`。
- 仅单文件、仅 update。
- strict fail-fast。

门禁：

- 单测/集成测试全绿。
- inbound 集成 smoke 通过。
- 对现有非 hashline patch 行为零回归。

### Phase 2：Multi-file

新增：

- file bucket 扩展到 `HashMap<file_path, ops>`。
- per-file bottom-up apply。
- 统一 multi-file changeset emit。

门禁：

- 多文件冲突语义稳定。
- snapshot 覆盖跨文件排序稳定性。

### Phase 3：Error semantics 增强

新增：

- 更细粒度冲突分类（例如 overlap、payload-shape conflict）。
- 结构化 remediation hints（仅诊断，不做自动 fallback）。

门禁：

- 错误码与字段向后兼容策略明确。

## 回滚策略

原则：仅回滚开关，不回滚语义真源实现。

1. **首选**：关闭 feature flag
   - `runtime.hashline_native_edit.enabled = false`
   - 立即退出新路径。
2. **次选**：phase 降级
   - `phase=2/3 -> phase=1`。
3. **禁止**：引入 TS fallback 复制语义。
4. **证据要求**：回滚动作需记录
   - 触发条件
   - 影响范围
   - 恢复验证（请求样本 + 错误率）

## 成功判定

当且仅当以下全部满足，才算该设计落地成功：

1. hashline parse/hash/apply/emit 语义只在 Rust 一处实现。
2. `hub_req_inbound_tool_call_normalization.rs` 完成单点集成，TS 无 duplicate path。
3. Phase 1 约束（单文件 update-only）被严格执行并有测试证据。
4. 错误分类稳定、字段可定位、无 silent fallback。
5. snapshot 与集成回归可重复通过。

## 不接受的假完成状态

以下不算完成：

1. Rust 有实现，但 TS 仍保留第二套可执行语义。
2. 锚点 mismatch 被吞掉或降级为 warning。
3. patch emit 仍有不稳定格式分支。
4. 只有单测无 inbound 集成验证。
5. phase 边界不清导致多文件语义提前渗透。
