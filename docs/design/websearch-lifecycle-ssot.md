# WebSearch Lifecycle SSOT（唯一真源）

## 索引概要
- L1-L26 `scope`: 范围、术语、硬约束
- L27-L74 `single-decision-gate`: 单一判定入口（direct vs servertool）
- L75-L146 `lifecycles`: 两条生命周期（互斥）
- L147-L198 `intent-and-turn-boundary`: 命中语义与“仅看本轮”
- L199-L248 `code-ownership`: 代码所有权与禁止重复实现
- L249-L300 `cleanup-plan`: 收敛/清理计划（物理删除）
- L301-L356 `verification`: 验证门与证据要求

---

## 1) 范围与硬约束

本文档是 WebSearch 运行时语义唯一真源（SSOT）。目标不是“只保留一种执行模式”，而是：

1. **保留两种执行模式**，但必须由**单一判定入口**互斥分流；
2. 禁止双轨并行争抢（同一请求不能同时走 direct 与 servertool）；
3. 禁止重复实现、隐式 fallback、静默降级；
4. 客户端必须看到语义透明的一次响应（允许服务端 followup）。

术语：
- `websearch-direct`：provider/model 原生 web search 能力；
- `websearch`：servertool web search 能力（本地执行 + followup 续轮）；
- `用户意图命中`：当前轮 user 输入触发搜索；
- `工具意图命中`：模型调用我们注入的 websearch 工具触发搜索。

---

## 2) 单一判定入口（唯一分流门）

唯一分流门：**route + capability 判定联合函数**（Rust 主导，TS 只做薄壳调用）。

判定规则（互斥）：

1. 若目标模型声明 `websearch-direct`：
   - 命中搜索意图时走 **Direct Native 模式**；
   - 不进入 servertool websearch 执行链。

2. 否则若目标模型声明 `websearch`：
   - 命中搜索意图时走 **ServerTool 模式**；
   - 允许工具意图命中触发 servertool 执行。

3. 普通历史声明（兼容存量）：
   - 按旧规则归一映射到 `websearch`（servertool）；
   - 不可隐式映射为 `websearch-direct`。

> 说明：用户意图命中是最强触发信号；工具意图命中是 servertool 路径的重要触发信号。
> 说明：`auto` 只用于“同协议直连 vs 异协议 relay”的协议路径选择，不是 websearch 分流门本身。

---

## 3) 两条生命周期（互斥）

## 3.1 Direct Native 生命周期（`websearch-direct`）

1. 用户意图命中 web_search route；
2. 请求发送到支持原生搜索的 provider/model；
3. provider 远端执行搜索并返回结果；
4. RouteCodex 不执行本地 websearch 工具，不进行 websearch servertool 执行；
5. 返回给客户端（可按标准链路继续处理，但不进入本地 websearch handler）。

关键约束：
- **Direct 模式不需要清理 tools 列表**；
- 不触发本地 websearch servertool handler。

## 3.2 ServerTool 生命周期（`websearch`）

1. 用户意图命中或工具意图命中；
2. 注入/识别 websearch（非官方同名可兼容别名）；
3. 模型发出 websearch tool call；
4. servertool 拦截并执行搜索；
5. 搜索结果不直接终止返回客户端，而是进入 server-side followup；
6. followup 续轮继续推理，最终输出回客户端（透明）。

关键约束：
- 必须支持 followup 透明续轮；
- 续轮工具面按策略恢复完整工具列表（不永久锁死）。
- 只有在 servertool 模式下，才允许注入本地 websearch 工具（命名与官方可不同）。

---

## 4) 命中语义与轮次边界（新增）

### 4.1 命中条件（唯一）

WebSearch 命中只有两条路：

1. **用户意图命中**（最强）：仅看**当前轮 user 输入**；
2. **工具意图命中**：模型调用了我们注入的 websearch 工具（servertool 模式）。

禁止把历史轮“曾经命中过搜索”当作当前轮强制继承条件。

### 4.2 轮次边界（必须）

1. user 轮命中搜索后，若 direct 模式成立：走 provider 原生搜索，不走本地 websearch handler；
2. user 轮命中搜索后，若 servertool 模式成立：注入/执行本地 websearch 工具并 followup；
3. tool 轮是否继续走 web_search route，仅由“本轮工具意图”决定，不得使用历史 user 文本复判。

### 4.3 工具面规则（必须）

1. **Direct 模式**：不清理完整工具列表，不注入本地 websearch 替身工具；
2. **ServerTool 模式**：注入本地 websearch 工具，工具结果走 server-side followup，最终再返回客户端；
3. 同一请求内 direct/servertool 必须互斥，禁止双激活。

---

## 5) 代码所有权（唯一实现边界）

保留主链（必须）：
- `classifier.rs`（双命中入口：用户意图 + 工具意图）
- `req_process_stage1_tool_governance.rs`
- `chat_servertool_orchestration.rs`
- `servertool/handlers/web-search.ts`

允许存在但必须受“单一分流门”控制的 direct 能力桥接：
- `hub_pipeline.rs` 中 direct builtin websearch 相关逻辑（仅 direct 路径可达）

禁止：
- 新增第二套 websearch 判定入口；
- 在 Host/Provider 侧偷偷重建分流语义；
- direct 与 servertool 同请求并发命中。

---

## 6) 收敛计划（物理清理）

目标：删除“仅为旁链服务且不受单一分流门控制”的代码。

执行顺序：
1. 先把 capability 语义明确为：`websearch-direct` / `websearch`；
2. 建立单一分流函数（返回 direct 或 servertool）；
3. 把现有 direct/servertool 各处分支改为调用该函数；
4. 删除重复判定分支与死代码（物理删除，不保留注释墓碑）；
5. 更新测试与文档。

---

## 7) 验证门（必须）

定向测试：
1. `user-intent -> websearch-direct`：命中 direct，且不触发 servertool websearch handler；
2. `user-intent -> websearch(servertool)`：触发 servertool + followup；
3. `tool-intent -> websearch(servertool)`：工具调用触发 servertool 执行；
4. 互斥性：同一请求 direct/servertool 不可同时激活；
5. followup 透明：客户端看到最终回答，不暴露中间执行细节。
6. **轮次边界**：工具轮不应因为“历史 user 搜索词”重复命中 web_search route；
7. **路由策略**：web_search 路由池可配置 `priority` / `load_balance`，并验证生效。

日志证据：
- 记录 direct 与 servertool 的决策标签；
- 不再出现双轨分歧（同 req 同时出现 direct+servertool）。
- 记录 route 命中理由，能区分 `web_search:explicit-or-intent` 与 `web_search:tool-intent`。

---

## 8) 非目标

1. 不在本轮改动所有 provider 适配细节；
2. 不引入 fallback/降级策略；
3. 不改变非 websearch 路由行为。
