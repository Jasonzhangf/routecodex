# 工具治理沉入 Rust — exec_command Guard Phase 3A 执行文档

## 目标

把 `exec_command` 相关的硬编码工具治理语义沉淀到 Rust runtime，TS 不再承载新的治理真源。

Phase 3A 只处理硬编码、确定性、可红测的 `exec_command` 规则：

1. 危险命令阻断；
2. git destructive scope 阻断；
3. shell 写入类命令阻断；
4. response-side 工具参数归一化后的统一拦截反馈；
5. TS 侧只保留最小调用壳，不新增/保留重复规则。

## 当前审计结论

### Rust 已有能力

| 能力 | Rust 位置 | 当前状态 |
| --- | --- | --- |
| exec_command 参数读取/归一化 | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/exec_command_args.rs` | 已有 |
| response tool args 归一化入口 | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/tool_args.rs` | 已有 |
| apply_patch Rust 校验/归一化 | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/napi_bindings.rs` + `napi_utilities.rs` | 已有 |
| response governance orchestrator | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/orchestrator.rs` | 已有 |
| 部分 dangerous command guard | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/exec_command_guard.rs` | 已有但不完整 |
| git checkout 单文件 scope | `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/exec_command_guard.rs` | 已有但需与 TS 对齐后成为唯一真源 |

### TS 残留治理语义

| 规则/能力 | TS 位置 | Phase 3A 处理 |
| --- | --- | --- |
| git reset hard 阻断 | `sharedmodule/llmswitch-core/src/tools/exec-command/validator.ts` | 沉入 Rust |
| git checkout scope | `sharedmodule/llmswitch-core/src/tools/exec-command/validator.ts` | Rust 唯一真源，TS 删除重复判定 |
| policy-file regex rules | `sharedmodule/llmswitch-core/src/tools/exec-command/validator.ts` | Phase 3A 暂不迁移，标记 Phase 3B；不得新增 fallback |
| shell wrapper shape invalid 判定 | `sharedmodule/llmswitch-core/src/tools/exec-command/validator.ts` | Phase 3A 暂不迁移，先保持现状；后续 Rust 化 |
| shell write guard：redirect/heredoc/sed/ed/tee | `sharedmodule/llmswitch-core/src/tools/tool-registry.ts` | 沉入 Rust |
| allowed tool name whitelist | `sharedmodule/llmswitch-core/src/tools/tool-registry.ts` | Phase 3B；需先确认生产入口 |
| validateToolCall 入口 | `sharedmodule/llmswitch-core/src/tools/tool-registry.ts` | Phase 3A 不扩写；最终应降为 Rust 委托壳 |

## 边界

### In scope

- Rust `exec_command_guard.rs`：补齐硬编码阻断规则与 blocked object builder。
- Rust `tool_args.rs`：在 `exec_command` 唯一归一化入口调用 guard。
- Rust 单元测试：覆盖每个阻断规则、允许规则、反馈 shape。
- TS 测试：只允许调整为验证 Rust 结果，不允许继续验证 TS 重复规则。
- TS 删除项：删除与 Phase 3A 已迁移规则重复的 TS 判定。

### Out of scope

- 不迁移动态 policy-file regex 读取，除非单独进入 Phase 3B。
- 不迁移 allowed tool whitelist，除非确认所有生产调用点已统一到 native。
- 不改 provider runtime，不写 provider 特例。
- 不做 fallback、降级、静默吞错。
- 不恢复或引入 `sudo` / `ssh` / `scp` / `rsync` 阻断：这些命令按用户要求允许。

## Rust 目标规则

### 必须阻断

| 类别 | 示例 | reason |
| --- | --- | --- |
| destructive remove | `rm -rf <path>`, `rm -fr <path>` | `forbidden_dangerous_rm` |
| broad process management | `killall <name>`, `pkill <pattern>` | `forbidden_process_mgmt` |
| git clean destructive | `git clean -f`, `git clean -fd`, `git clean -fdx` | `forbidden_git_clean` |
| git reset hard | `git reset --hard`, `git reset --hard <ref>` | `forbidden_git_reset_hard` |
| git checkout unsafe scope | branch checkout、directory restore、多文件 restore、链式命令、无 `--` scope | `forbidden_git_checkout_scope` |
| shell bulk write | `> file`, heredoc redirect, `sed -i`, `ed -s`, `tee file` | `forbidden_shell_write` |

### 必须允许

| 类别 | 示例 |
| --- | --- |
| read/search | `pwd`, `ls`, `tree`, `rg foo`, `cat file` |
| tests/build | `npm test`, `cargo test`, `npx tsc --noEmit` |
| safe git read | `git status`, `git diff`, `git show`, `git branch`, `git ls-files` |
| scoped restore | `git checkout -- src/a.ts`, `git checkout HEAD -- src/a.ts` |
| explicitly allowed remote/admin tools | `sudo`, `ssh`, `scp`, `rsync` |

## 设计原则

1. Rust 是规则唯一真源：任何 hardcoded tool governance rule 只能在 Rust 存在。
2. TS 只做调用壳：可以 stringify/parse/native call/fail-fast，但不得复制规则。
3. 单一入口：`exec_command` response-side 统一从 `tool_args.rs` 进入 guard。
4. 反馈必须显式：阻断后返回可执行 blocked script，stderr 输出 reason/message，并非静默 drop。
5. 不做 fallback：native 调用失败必须 fail-fast，不得回 TS 规则。
6. 不扩大范围：`sudo` / `ssh` / `scp` / `rsync` 允许，不得重新加入阻断。
7. 先红测后替换：新增 Rust 红测覆盖 TS 既有行为，再删除 TS 重复规则。

## 建议实施步骤

### Step 1 — 固化 Rust 红测

新增/补齐 Rust tests，先确保以下用例存在且能失败/通过反映真实缺口：

- `git reset --hard` 被阻断；
- `git reset --mixed` 不阻断；
- unsafe `git checkout` 被阻断；
- single-file `git checkout` restore 不阻断；
- `rm -rf` / `rm -fr`、`killall`、`pkill`、`git clean -f` 被阻断；
- `sudo` / `ssh` / `scp` / `rsync` 不阻断；
- shell write patterns 被阻断；
- read-only/search/test commands 不阻断；
- blocked object 包含 stable reason，并以非 0 exit 显式失败。

### Step 2 — 补 Rust guard

文件：
`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/exec_command_guard.rs`

处理：

- 扩展 `detect_dangerous_command`；
- 新增 `git reset --hard` 判定；
- 完善 `git checkout` scope 判定；
- 新增 shell write 判定；
- 保留/统一 `build_dangerous_command_blocked_object`；
- 确认 message 转义不会触发 shell command substitution。

### Step 3 — 接入唯一 Rust 调用点

文件：
`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance_blocks/tool_args.rs`

要求：

- `normalize_tool_args` 的 `exec_command` 分支必须调用 Rust guard；
- `normalize_tool_args_preserving_raw_shape` 的 `exec_command` 分支必须调用同一个 Rust guard；
- 不新增第二套入口；
- 不绕开 `apply_patch` / `write_stdin` / `update_plan` 既有逻辑。

### Step 4 — 删除 TS 重复规则

文件候选：

- `sharedmodule/llmswitch-core/src/tools/exec-command/validator.ts`
- `sharedmodule/llmswitch-core/src/tools/tool-registry.ts`

删除或收缩：

- `GIT_RESET_HARD_PATTERN`；
- `evaluateGitCheckoutScope`；
- 与 Phase 3A shell write guard 重复的 `detectForbiddenWrite` 分支；
- 任何 hardcoded dangerous pattern。

保留：

- JSON parse/stringify 壳；
- native 调用壳；
- Phase 3B 尚未迁移的 policy-file / shell wrapper shape 逻辑，但必须在文档中标明不是最终状态。

### Step 5 — TS 调用壳收敛

如果 TS 仍需要 `validateToolCall` 测试入口：

- `validateToolCall('exec_command', ...)` 只委托 Rust native guard/normalizer；
- native 不可用时 fail-fast；
- 禁止回退到 TS hardcoded validator；
- 测试断言应检查 Rust blocked reason/message，而不是 TS 函数内部细节。

### Step 6 — 验证

最小验证矩阵：

```bash
cd sharedmodule/llmswitch-core/rust-core
cargo test -p router-hotpath-napi exec_command_guard
cargo test -p router-hotpath-napi tool_args
cargo test -p router-hotpath-napi virtual_router_engine

cd ../
npx tsc --noEmit
```

相关 TS 测试按实际改动补跑：

```bash
cd sharedmodule/llmswitch-core
npm test -- tests/sharedmodule/tool-governor-exec-command-guard.spec.ts
npm test -- tests/sharedmodule/tool-registry-tools.spec.ts
npm test -- tests/sharedmodule/exec-command-validator-shape-repair.spec.ts
```

## 风险与规避

| 风险 | 规避 |
| --- | --- |
| TS/Rust 双真源继续存在 | 每迁移一个规则，物理删除 TS 重复规则 |
| blocked message 中 shell 特殊字符触发命令替换 | Rust builder 必须安全转义；测试覆盖反引号、单引号、美元符 |
| shell write guard 误伤 read-only grep 输出重定向 | 先只迁移 TS 已有规则，新增规则需红测证明 |
| policy-file 仍在 TS | Phase 3A 明确记录，Phase 3B 单独处理，禁止把它当完成态 |
| validateToolCall 测试仍绕 TS | 测试改为 native 委托或标注 legacy，最终清理 |

## 完成定义（DoD）

Phase 3A 完成必须同时满足：

1. Rust 覆盖所有 Phase 3A hardcoded `exec_command` guard 规则；
2. TS 中不存在这些规则的重复 hardcoded 判定；
3. `sudo` / `ssh` / `scp` / `rsync` 明确允许且有测试；
4. 阻断反馈为显式 stderr + 非 0 exit，不静默失败；
5. Rust 定向测试、`virtual_router_engine` 测试、TS 类型检查通过；
6. `note.md` 记录本次迁移证据与剩余 Phase 3B 缺口。

## Phase 3B 候选

- policy-file regex rules 迁入 Rust；
- shell wrapper invalid shape 判定迁入 Rust；
- allowed tool whitelist 迁入 Rust；
- `tool-registry.ts` 降为纯 native 委托壳；
- `validator.ts` 物理删除。
