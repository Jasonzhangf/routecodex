# V3 Usage 归一化矩阵（完整版 v3）

> v1 经独立设计 review FAIL（F1–F10），v2 经二轮 review FAIL（BLOCKER-1/2/3 + MINOR-1..4）。
> 本版按**已落地代码**校准：命名使用实际 shipped symbol，DAG 与真实 Value 级数据流一致，
> 并显式声明仍存在的缺口。设计文本不得引用不存在的 symbol 或不可达的 harness。

## 1. 触发证据（provenance）

live 样本目录 `~/.rcc/codex-samples/<endpoint>/ports/<port>/<requestId>/`，candidate 基线 `f3c2ed601`。
口径：逐 requestId 枚举样本目录中带客户端 `response.json` 的请求（证据而非代码事实）。

| 样本（provider） | 客户端实际收到的 usage |
|---|---|
| `openai-responses` / `goai…`(anthropic) | `{"cache_creation_input_tokens":0,"cache_read_input_tokens":217088,"input_tokens":3748,"output_tokens":707,"total_tokens":4455}` |
| 同上（`goaichat-ai`） | `input_tokens=4410, cache_read=229376, output=1438, total=5848` |
| 同上（`goaichat-ai`） | `input_tokens=2944, cache_read=216064, output=1037, total=3981` |

形状普查合计 **42** 例：`responses` provider 9 例、`openai_chat` provider 5 例为正确 OpenAI 形状；
`anthropic` provider 3 例为泄漏形状；chat 端点 20 例正确（#289 已修）；余 5 例为采集缺口
（`rawSse` 长度 0，request-record 有完整 usage）。重放以 `response.json` 的
`materializedResponse.usage` 与 `rawSse` 的 `response.completed` 为准。

可执行复现（已从 RED 转绿）：`v3/crates/routecodex-v3-server/tests/multi_listener_server.rs`
`responses_client_anthropic_cache_usage_projects_openai_details_shape`。

## 2. 真实数据流（Value 级，DAG 必须与之一致）

```text
provider wire usage (serde_json::Value)
  └─ canonical_usage_cache_for_value(&Value) -> V3CanonicalUsageCache
       └─ split_v3_canonical_usage_cache(input, cached_subcount, read, creation)   ← 唯一分类真源
            ├─ project_v3_chat_usage_from_canonical(&Value)      -> OpenAI Chat wire usage
            ├─ project_v3_responses_usage_from_canonical(&Value) -> Responses wire usage
            └─ project_v3_anthropic_usage_from_canonical(&Value) -> Anthropic Messages wire usage
```

shipped symbol（唯一真源 `hub_v1/usage_normalization.rs`）：`V3CanonicalUsageCache`、
`split_v3_canonical_usage_cache`、`read_v3_canonical_usage_cache_fields`、
`canonical_usage_cache_for_value`，以及三个 projection。

**DAG 建模口径（BLOCKER-3）**：三个 projection 的入参都是原始 provider-wire usage `Value`，
分类在节点内部调用 `canonical_usage_cache_for_value` 完成；运行期**不存在**一个中间
`canonical-usage` Value。因此每个投影图是**单节点图**（provider-wire-usage → client-wire-usage），
不虚构 `m01 → m02` 的 Value 边；分类真源作为节点内部逻辑与共享符号存在，不另立第二张图。
命中率消费方是独立单节点图，owner 为 `row_canonical_usage_cache`。

`extract_v3_runtime_usage_summary`（`responses_relay_runtime.rs:592`）返回 `V3RuntimeUsageSummary`，
只服务 observability，**不参与**任何 client 投影，也不作为分类真源。

## 3. Canonical 契约（三种输入语义）

| 输入语义 | 判定 | canonical 字段语义 | effective_input |
|---|---|---|---|
| OpenAI / Responses | 存在 `input_tokens_details.cached_tokens`（或 `prompt_tokens_details`） | `input_tokens` **已含**缓存 | `input_tokens` |
| Anthropic / MiniMax / glm | 存在 `cache_read_input_tokens` **或** `cache_creation_input_tokens` | `input_tokens` 只记未命中增量；read/creation 独立 | `input + read + creation` |
| Gemini | `promptTokenCount` / `cachedContentTokenCount` | `promptTokenCount` **已含** `cachedContentTokenCount`（OpenAI-like） | `promptTokenCount` |

- `cached_tokens`（命中子计数）= OpenAI 子计数，否则 `cache_read_input_tokens`。
- `cache_creation_input_tokens` 单独保留（诊断用），只在 Anthropic 语义下参与分母。
- **creation-only 边界（F5）**：只有 `cache_creation_input_tokens`、没有 `cache_read_input_tokens`
  的 payload 必须判为 Anthropic 语义（`effective = input + creation`），不得回退成 OpenAI 语义丢弃 creation。
- 判定优先级固定为：子计数 → read/creation → 无缓存字段。

## 4. 完整矩阵：canonical -> client wire（唯一 owner）

| client 协议 | 唯一 owner（shipped） | 现状 | 目标 wire 形状 |
|---|---|---|---|
| OpenAiChat | `project_v3_chat_usage_from_canonical` | ✅ 已有（#289），已收敛到共享分类 | `prompt_tokens`=effective；`completion_tokens`；`total_tokens`=prompt+completion；`prompt_tokens_details.cached_tokens`；`completion_tokens_details.reasoning_tokens` |
| Responses | `project_v3_responses_usage_from_canonical` | ✅ 本次新增 | `input_tokens`=effective；`output_tokens`；`total_tokens`=input+output；`input_tokens_details.cached_tokens`；`output_tokens_details.reasoning_tokens`；**禁止** `cache_read_input_tokens` / `cache_creation_input_tokens` |
| Anthropic | `project_v3_anthropic_usage_from_canonical` | ✅ 本次新增 | `input_tokens`=effective−cached−creation（未命中增量）；`output_tokens`；`cache_read_input_tokens`；`cache_creation_input_tokens`；**禁止** `total_tokens` / `input_tokens_details` |
| Gemini | 无（same-protocol 直通） | ✅ 已有 | `usageMetadata` 原样直通；不存在 canonical→Gemini 投影格 |

三个 projection 都接受原始 usage `Value`，内部调用 `canonical_usage_cache_for_value`
（= `read_v3_canonical_usage_cache_fields` + `split_v3_canonical_usage_cache`）；
投影层只做字段名映射，不重复推导 `effective_input` / `cached`。

**Gemini client 行（F3）**：Gemini 是 config-reachable client entry
（`hub_v1.rs` entry_protocols、`endpoint_handlers.rs:749`、黑盒 `gemini_relay_controlled.rs:178`
断言客户端收到 `usageMetadata.totalTokenCount`）。`gemini_relay_runtime.rs:246` 固定
`EXPECTED_PROVIDER_TYPE = Some("Gemini")`（比较见 `relay_runtime_shared.rs:133-147`），
因此 Gemini client 只有 **same-protocol 直通**格，无独立投影 owner，已由该黑盒覆盖。

**已知缺口（MINOR-1，显式声明，不在本次范围）**：`provider_wire_protocol_for_provider_type`
把 `gemini → Gemini`（`provider_compat_shared.rs:20-38`），且 `openai_chat_relay_runtime.rs:1297`
的 `EXPECTED_PROVIDER_TYPE = None`，所以 Gemini **provider** 理论上可服务 Chat/Responses/Anthropic
client，第 3 行语义对 provider 侧 Gemini 形状是 load-bearing 的。但所有 projection 调用点读
`object.get("usage")`，只有 observability 提取器读 `usageMetadata`（`responses_relay_runtime.rs:601`），
上游没有 `usageMetadata`→`usage` 的映射。因此 **gemini provider → 非 gemini client 目前不产出
client usage**。当前 active config 无 Gemini provider，该格不可达；本变更不接线，仅在此声明为缺口，
避免把未接线的能力写成已覆盖。

**其它 client-facing usage writer 的角色声明（F4）**：
- `materialize_v3_responses_terminal_usage`（`responses_relay_runtime.rs:856`）：仅补缺失
  `input_tokens`/`output_tokens`/`total_tokens` 的填充器，不重算缓存语义。
- `materialize_v3_runtime_input_usage_estimate_from_request`（`responses_relay_runtime.rs:664`，
  调用点 `responses_relay_runtime_inner.rs:857,1216`）：provider 语义缺 usage 时写入**估算**
  input/total，随后仍必须经过对应 projection；它是填充器，不是第二分类真源。
- Direct 模式同协议直通（`kernel/direct_runtime_helpers_stream.rs:587`）：provider 与 client 同协议时
  不重投影，属声明性直通。

## 5. 收敛与删除清单（消融）

| 待删/收敛对象 | 位置 | 收敛到 |
|---|---|---|
| `anthropic_usage_as_responses_usage` | `anthropic_codec/responses_to_anthropic.rs`（已删） | `project_v3_responses_usage_from_canonical` |
| `normalize_v3_hub_responses_usage_from_openai_chat_usage` | `responses_openai_chat_conversion.rs`（已删） | 同上 |
| Anthropic client 直通 writer | `anthropic_relay_runtime_codec.rs:80-82` | `project_v3_anthropic_usage_from_canonical` |
| Anthropic client 重建 writer | `anthropic_relay_runtime_codec.rs:194-201` | 同上 |
| chat projection 自带分类 | `openai_chat_codec.rs`（改为 re-export） | `split_v3_canonical_usage_cache` |
| console 第三份命中率规则 | `routecodex-v3-server/src/console/impl_display.rs:45-67` | `split_v3_canonical_usage_cache` |
| console 第二份字段提取/别名规则 | `routecodex-v3-server/src/console/impl_display.rs:121-177`（`extract_v3_console_usage_summary`） | 同上 |
| timeseries 第二份命中率规则 | `routecodex-v3-admin/src/api/timeseries.rs:289-296` | 同上 |
| timeseries 旧 read/cached 回退 | `routecodex-v3-admin/src/api/timeseries.rs:48-54`（`row_cache_read`） | 同上 |
| observability 命中率规则 | `routecodex-v3-admin/src/api/observability.rs:687-697` | `row_canonical_usage_cache` → 同上 |

**形状差异（MINOR-3）**：admin/console 的行数据是**扁平**的（`V3ObsUsageSummary`
`webui_observability.rs:531-543`、`TimeseriesRow.usage`），Value 级 reader
`read_v3_canonical_usage_cache_fields` 只读嵌套 `*_details.cached_tokens` + 顶层
`cache_read/creation` + `cachedContentTokenCount`，**不读扁平 `cached_tokens`**。因此扁平消费方
直接调用 `split_v3_canonical_usage_cache(input, cached, read, creation)`（`observability.rs:689-707`
`row_canonical_usage_cache`、`console/impl_display.rs:49-57`、`timeseries.rs:182-210,292-312`），
而不是 `canonical_usage_cache_for_value`。这是同一分类规则的两种入参形状，不是第二规则。

`routecodex-v3-admin` 已依赖 `routecodex-v3-runtime`，共享规则不需要新依赖。

**仍未收敛的第四/五份副本（显式声明，本次范围外）**：admin webui 前端 JS 仍自带命中率算式
`v3/admin-webui/app/views/usage.js:167-170`（`hitRateText` 用 `read/input`）与 `:328`
（`mergeStats` 用 `cache_read_input_tokens/input_tokens`）。它们消费 admin API 的行数据，对
Anthropic 行同样会低估分母；但属 webui 展示面，需 `verify:webui-smoke` 门禁，本变更不触碰。
这是同一语义的已知剩余重复实现，列为后续收敛项。

**Admin 数据来源（ADVISORY-1）**：observability 读的是 **finalized provider 语义**
（`relay_runtime_core.rs:1140`、`responses_relay_runtime_inner.rs:935,1308` 读
`finalized_provider_value`），Anthropic provider payload 由 `resp_inbound_02_normalized.rs:30-55`
转成 Responses canonical 后才进入该语义。投影修好后新行已是 OpenAI 形状，
`max(input,cached)` 天然正确；共享分类规则对**历史行 / Direct 行**必要，属兼容既有数据的一次性收敛。

## 6. 回归面（必须同步更新的具体断言）

| 文件:行 | 现断言 | 处理 |
|---|---|---|
| `multi_listener_server.rs`（本变更新增 3 条黑盒） | RED：Responses client 收到 anthropic 形状 | 变绿（3 格） |
| `responses_relay_runtime_extra_tests.rs:1053-1056` | `input_tokens==7`、`total_tokens==10`、`cache_read_input_tokens==5` | 改为 `input_tokens==12`、`total_tokens==15`、`input_tokens_details.cached_tokens==5`，且无私有字段 |
| `responses_relay_runtime_tests_extra.rs:758-767` | 旧 OpenAI 形状转换调用点 | 按新 owner 语义复核（未变） |
| `anthropic_relay_runtime_integration.rs:539-541` | Anthropic client `usage.total_tokens == 21` | 输入 `{input_tokens:13,output_tokens:8,total_tokens:21}` **无缓存字段**，新输出为 `{input_tokens:13,output_tokens:8}`：无 `total_tokens`、无 `input_tokens_details`，也**不产生** `cache_read_input_tokens` |
| `timeseries.rs:478`（断言在 `:516`） | 期望 `Some(70.0)`（input=1000/read=700/creation=200） | 期望 `Some(36.8)`（700/1900） |
| `observability.rs:1314,1331` | 命中率单测 | 按共享规则复核 |
| console 测试 `routecodex-v3-server/src/tests/mod.rs:1312-1332` | 分母 101826 | 改为 101833（59842+41984+7，含 creation）；`:3152` 同批复核 |

## 7. 黑盒测试矩阵（每格一条，走真实入口）

| provider wire | client | harness | 入口 | 状态 |
|---|---|---|---|---|
| anthropic | Responses | `multi_listener_server.rs` manifest `:369` + terminal upstream `:1185` | `POST /v1/responses` | ✅ 本次新增 |
| anthropic | Anthropic | 同上 manifest，覆盖 `server.endpoints`（模式见 `:1566`）+ `:1200` `/v1/messages` upstream | `POST /v1/messages`（SSE） | ✅ 本次新增 |
| anthropic | Chat | 同上 manifest + terminal upstream | `POST /v1/chat/completions` | ✅ 本次新增 |
| responses | Responses | `multi_listener_server.rs:369/1185` | `POST /v1/responses` | ✅ 既有 |
| openai_chat | Responses | `multi_listener_server.rs:369` + terminal upstream（OpenAI-Chat 形状 body） | `POST /v1/responses` | ✅ 既有 |
| openai_chat | Chat | `openai_chat_relay_controlled.rs:324/33` | `POST /v1/chat/completions` | ✅ 既有 |
| gemini | Gemini | `gemini_relay_controlled.rs:178`（同协议直通） | `POST /v1beta/models/:model:generateContent` | ✅ 既有 |
| gemini provider | 非 gemini client | — | — | ❌ 缺口（见 §4，不可达，不接线） |

> v2 曾把 "anthropic | Chat" 归到 `openai_chat_relay_controlled.rs:324/33`；该 manifest 硬编码
> `type = "openai_chat"`、上游 `:33 controlled_openai_chat_upstream` 返回 OpenAI-Chat body，
> 无法承载 Anthropic provider。本版改用同一 Anthropic-provider manifest + terminal upstream。

每格断言：① 只出现本协议字段；② `effective_input` 含缓存；③ `cached` 子计数正确；
④ `total` = 投影后 input+output；⑤ 缺缓存字段的 provider 不得伪造 0 子计数。

## 8. 非目标

- 不新增 client 协议；不改 provider 请求侧 `include_usage` / `stream_options` 语义。
- 不接线 gemini provider → 非 gemini client 的 `usageMetadata`→`usage` 映射（§4 缺口，当前不可达）。
- 不为 Gemini 增加 cross-protocol provider 支持（现为固定 provider type）。
- 不从样本、日志或 snapshot 反推控制状态。
