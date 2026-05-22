# Windsurf Cascade 单一路径重建计划

## 1. 目标与验收标准

### 目标
在已物理删除旧错误主线文件的前提下，仅保留 `src/providers/core/runtime/windsurf-chat-provider.ts` 这一条本地实现，按解析语义真源重建 Windsurf provider：request 只走 `chat -> provider -> cascade`，response 只走 `cascade -> provider(chat) -> hubpipeline`；禁止新增第二套实现。

> 2026-05-22 更新：`GetChatCompletions` 旧 JSON 主链已被最黑盒证伪。
> 本计划中的“单一路径”现在必须明确为：
> - `StartCascade`
> - `SendUserCascadeMessage`
> - `GetCascadeTrajectorySteps/poll`

### 验收标准
1. 仓库内不存在第二套本地活实现，Windsurf provider 只剩单一路径。
2. `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 中 cascade 语义相关测试全部通过，至少覆盖：
   - assistant tool call
   - tool result -> function_call_output
   - 多轮 continuity
   - 空内容 / 异常内容 / 重复 tool call fail-fast
3. `windsurf-chat-provider.ts` 内只有一套解析真源：assistant/tool_result/roundtrip 的语义解析必须收敛到单一函数族，不能并行保留旧 temporary text carrier 主实现。
4. send/response parse 主链若继续推进，必须直接建立在当前语义解析真源上；不得引回任何第二实现。
5. `GetChatCompletions` / `chatMessagePrompts` / `completionsRequest` 旧主链必须从文档、测试、实现中物理移除，不能再作为“过渡主链”保留。
6. 实机链路恢复后，5520 same-shape smoke 不再出现任何旧本地实现错误形态；当前主验证重点转为 cascade 鉴权头、上游响应语义、tool/history continuity。
7. summary 必须明确说明：哪些测试先红、哪些修改点转绿、为何这些修改点是唯一正确真源。

## 2. 范围与边界

### In Scope
- `tests/providers/core/runtime/windsurf-chat-provider.spec.ts` 的 cascade 语义红测补强与回归
- `src/providers/core/runtime/windsurf-chat-provider.ts` 的单一路径解析实现
- send path / response parse 主链的 reference 真源审计与 fail-fast 边界
- 旧 `GetChatCompletions` 主链叙事、测试与实现删除
- 删除或替换 remaining temporary text carrier 依赖
- `note.md` 过程记录；结论稳定后再提炼到 `MEMORY.md`
- 最终定向测试、类型检查、构建、安装、restart、same-shape smoke

### Out of Scope
- 不恢复任何本地中间链路设计
- 不新增第二个 Windsurf provider 或并行 transport
- 不改 Host/Router 去替 Windsurf 做语义解析
- 不做与本任务无关的 Hub Pipeline / 其他 provider 逻辑重构
- 不引入 fallback / 降级 / 双路径补偿

## 3. 设计原则
1. **单一路径真源**：Windsurf 本地只允许 `windsurf-chat-provider.ts` 这一套实现。
2. **对齐解析语义，不对齐旧结构**：以真实上游 assistant/tool_result/roundtrip 语义为准，不模仿被删除旧结构。
3. **先红后绿**：所有新增或收紧行为必须先补红测，再改实现，再转绿。
4. **Fail-fast / no fallback**：空内容、异常内容、重复 tool call、orphan tool result 都必须显式报错。
5. **send path 只能接语义真源**：恢复发送链时，只能接当前解析函数，不得重新发明 carrier 或本地 bridge。
6. **物理删除错误实现**：确认错误实现后必须直接删除，不能仅闲置。
7. **错误路径先删再对齐细节**：既然最黑盒已确认 `GetChatCompletions` 不是主链，就不能继续把它当成 shape 微调对象。

## 4. 技术方案（文件清单）

### 真源文件
- `src/providers/core/runtime/windsurf-chat-provider.ts`
- `tests/providers/core/runtime/windsurf-chat-provider.spec.ts`

### 支撑文档
- `docs/providers/windsurf-chat-provider-design.md`
- `note.md`

### 当前已确认的收敛方向
1. assistant / tool_result / semantic roundtrip 解析真源已集中到 `windsurf-chat-provider.ts`。
2. async parse 包装层必须只是薄壳，真正语义判断在 sync 真源函数内。
3. `normalizeMessages` 对 continuity 语义应逐步委托给 semantic parser true source，而不是继续靠 text flattening。
4. send path 若未来恢复，应直接：
   - 发送真实上游请求
   - 拿到真实上游响应
   - 进入单一 cascade semantic parser
   - 收口为当前 provider 需要的 chat completion / downstream shape
5. send path 的“真实上游请求”已收口为：
   - `StartCascade`
   - `SendUserCascadeMessage`
   - `GetCascadeTrajectorySteps/poll`
   而不是 `GetChatCompletions`

### 本轮必须继续完成的切片
#### Slice A：补强 cascade 解析红测
- assistant tool call
- tool result -> function_call_output
- 多轮 continuity
- 空内容 / 异常内容 / 重复 tool call / orphan tool result fail-fast
- responses parse / tool call / tool result 锚点覆盖
- servertool 相关场景若当前 spec 已覆盖，也必须保持全绿

#### Slice B：解析真源收敛
在 `windsurf-chat-provider.ts` 中把以下语义压到唯一真源：
- assistant tool call 提取
- tool result 提取
- roundtrip continuity 拼装
- 重复/空/错序异常的 fail-fast
- 不再让 temporary text carrier 参与主判定

#### Slice C：send / response parse 主链边界
- 当前阶段：唯一允许的本地主线是 `chat -> windsurf-chat-provider -> cascade`
- 若未来恢复：send path 只能调用当前 semantic parser 真源
- 从真实 upstream response shape 提取候选输出
- 正确区分：文本响应 / tool call / tool result / empty malformed payload
- 任何空 assistant payload 必须 fail-fast，不得伪装 `finish_reason=stop`
- 必须先物理删除 `GetChatCompletions` 旧主线叙事/测试/实现入口，再接 `StartCascade/SendUserCascadeMessage/poll` 真链

#### Slice D：移除 remaining temporary carrier 依赖
- 对仍依赖 temporary text carrier 的路径先补测试锁定现状
- 再逐步替换为语义解析真源
- 替换后物理删除已确认无用的 carrier 主逻辑

## 5. 风险与规避
1. **误把非 cascade 叙事当真源**
   - 规避：只允许 `chat -> provider -> cascade`。
2. **只把测试跑绿，但主链仍走旧分支**
   - 规避：send path 恢复前后都补定向测试，明确断言调用当前 semantic parser 真源。
3. **temporary text carrier 偷偷继续做主判断**
   - 规避：对 assistant tool call / tool_result / continuity 都补“不得依赖 text flattening”红测。
4. **空 payload 被伪装成 stop**
   - 规避：补 `EMPTY_ASSISTANT_RESPONSE` / raw empty completion 红测并 fail-fast。
5. **删不干净，仓库残留第二套实现**
   - 规避：grep + build + targeted smoke 验证无旧本地实现依赖残留。

## 6. 测试计划

### 第一优先：定向单测
```bash
node --experimental-vm-modules ./node_modules/jest/bin/jest.js --runTestsByPath tests/providers/core/runtime/windsurf-chat-provider.spec.ts
```
要求：
- 先补红测，再转绿
- 保留现有已转绿语义测试
- 新增对 send/response parse、responses 解析锚点、tool_result continuity 的红测

### 第二优先：类型与构建门禁（当前也必须保持通过）
```bash
npx tsc -p tsconfig.json --noEmit
npm run build:min
npm run install:global
routecodex restart --port 5520
```

### 第三优先：same-shape 实机 smoke（仅在 send path 具备新真源后执行恢复验证）
- 用 5520 发同形请求
- 验证多轮工具调用 continuity 是否正确
- 验证无旧本地实现错误形态
- 验证空内容/异常内容会 fail-fast，而不是静默 stop 或自循环

## 7. 实施步骤（顺序）
1. 打开 `windsurf-chat-provider.spec.ts`，继续补 cascade 语义与 send/response parse 的红测。
2. 运行定向 jest，确认先红。
3. 只改 `windsurf-chat-provider.ts`，把解析与收口继续收敛到单一语义真源。
4. 再跑定向 jest，转绿。
5. 若 send path 已拿到新的 reference 真源，再把真实 send/response parse 主链直接接到当前 semantic parser；否则保持 fail-fast。
6. 再跑定向 jest，确保 send path 场景也绿。
7. 记录过程到 `note.md`；结论稳定后再提炼到 `MEMORY.md`。
8. 最后执行 `tsc -> build:min -> install:global -> routecodex restart --port 5520 -> same-shape smoke`。

## 8. 完成定义（DoD）
1. Windsurf provider 只剩单一路径；仓库内不再存在第二套错误本地实现。
2. cascade assistant tool call / tool result / continuity / fail-fast 解析测试全部转绿。
3. send path 若恢复，必须直接建立在当前语义解析真源上；若未恢复，fail-fast 边界必须保持明确且有测试覆盖。
4. temporary text carrier 不再作为主语义判断路径；剩余依赖已删除或明确退居过渡观察位并有后续清理计划。
5. 定向测试、类型检查、构建、全局安装、restart、same-shape smoke 全部通过并留证据。
6. summary 明确给出唯一性论证：为什么修改点只能落在 `windsurf-chat-provider.ts` 的解析/收口真源，而不能改 Host/Router、不能恢复旧本地中间主线、不能保留双实现。
