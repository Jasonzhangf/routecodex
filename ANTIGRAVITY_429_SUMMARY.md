# Antigravity 429 排查总结

## 📋 **当前状态**

### **问题描述**
RouteCodex使用Antigravity provider时报429错误（`Resource has been exhausted`），但：
- ✅ Quota快照显示 `remainingFraction: 1`（100%可用）
- ✅ gcli2api使用相同token能成功请求（200 OK）
- ❌ RouteCodex请求相同模型报429

**结论**: 不是真的quota用完，而是**请求格式问题导致上游拒绝**。

---

## 🔍 **已发现的差异**

### **1. 缺少 `requestType` 字段** ✅ 已修复
**RouteCodex原始请求**:
```json
{
  "model": "gemini-3-pro-high",
  "requestId": "req-...",
  "userAgent": "antigravity",
  "request": {...}
}
```

**gcli2api请求body** (正确格式):
```json
{
  "requestId": "req-...",
  "model": "gemini-3-pro-high",
  "userAgent": "antigravity",
  "requestType": "agent",  // ← 必需！
  "request": {...}
}
```

**修复**: 在 `gemini-cli-http-provider.ts` 第304-306行添加：
```typescript
if (isAntigravity && !this.hasNonEmptyString(payload.requestType)) {
  payload.requestType = 'agent';
}
```

### **2. 包含大量MCP Tools** ✅ 已修复
**RouteCodex发送了27个MCP tools**，包括：
- `mcp__chrome-devtools__*` 系列（20+个）
- `list_mcp_resources`, `list_mcp_resource_templates` 等

**gcli2api**: 通常**不发送tools**，或只发送 `googleSearch`。

**Antigravity限制**: 
- 注释说明：*"Multiple tools are supported only when they are all search tools."*  
- 即：只支持 `googleSearch` 类型的工具

**修复**: 在 `gemini-cli-http-provider.ts` 第116-139行添加过滤逻辑：
```typescript
if (this.isAntigravityRuntime()) {
  const tools = recordPayload.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    // 只保留googleSearch工具
    const googleSearchTools = tools.filter((tool) => {
      return tool && typeof tool === 'object' && 'googleSearch' in tool;
    });
    
    if (googleSearchTools.length === 0) {
      delete recordPayload.tools;  // 没有googleSearch就完全移除
    } else {
      recordPayload.tools = googleSearchTools;
    }
  }
}
```

### **3. 包含 `session_id` 字段** ✅ 已修复
**RouteCodex**: 在 `request` 中包含 `session_id`
**gcli2api**: **不发送** `session_id` 到Antigravity

**修复**: 在 `gemini-cli-http-provider.ts` 第318-320行：
```typescript
// 对齐 gcli2api：Antigravity 运行时不发送 session_id 字段。
if (!isAntigravity && !this.hasNonEmptyString(payload.session_id)) {
  payload.session_id = `session-${randomUUID()}`;
}
```

---

## 🧪 **系统化验证方法（Task.md）**

按照 `task.md` 第87-114行的方法，从gcli2api能200的基础逐步添加差异：

### **已完成**:
- ✅ Step A1: session_id → gcli2api验证仍200
- ✅ Step A2: Accept/Accept-Encoding → 验证仍200

### **待执行**:
使用提供的测试脚本系统化验证：

```bash
# 一键运行所有测试
./run-antigravity-429-debug.sh
```

**或分步执行**:
```bash
# Step B: Header深度对齐
python3 test-antigravity-task-b1.py

# Step C: Tools差异
python3 test-antigravity-task-c.py
```

#### **Step B: Header测试**
- B1.1: 基准（gcli2api默认headers）
- B1.2: + X-Goog-Api-Client
- B1.3: + Client-Metadata  
- B1.4: + 两者（完整RouteCodex headers）

#### **Step C: Tools测试**
- C1.1: 无tools
- C1.2: 只有googleSearch
- C2.1: 单个MCP tool
- C2.2: 5个MCP tools
- C2.3: 混合（googleSearch + MCP）

---

## 📊 **修复验证**

### **RouteCodex修改已完成**:
1. ✅ 添加 `requestType: "agent"`
2. ✅ 过滤非googleSearch的MCP tools
3. ✅ 移除 `session_id` (仅Antigravity)

### **验证步骤**:
1. **重新编译**: `npm run build` (已完成，v0.89.846)
2. **重启服务器**: 重启RouteCodex
3. **发送测试请求**: 
   ```bash
   node test-antigravity-debug.mjs
   ```
4. **检查provider-request快照**:
   ```bash
   find ~/.routecodex/codex-samples -name "*provider-request*" -mmin -2 | tail -1 | xargs cat | jq '.body'
   ```

### **预期结果**:
请求body应该包含：
```json
{
  "model": "gemini-3-pro-low",
  "requestType": "agent",        // ← 新增
  "requestId": "req-...",
  "userAgent": "antigravity",
  "request": {
    "contents": [...],
    // NO session_id           // ← 移除
    // NO tools or only googleSearch  // ← 过滤
  }
}
```

---

## 🎯 **下一步**

1. **执行系统化测试** (Task.md方法):
   ```bash
   ./run-antigravity-429-debug.sh
   ```
   
2. **如果测试发现新问题**: 根据结果调整RouteCodex

3. **如果测试都200**: 验证RouteCodex的修复是否生效

4. **最终验证**: 在RouteCodex中测试所有之前429的模型

---

## 📁 **相关文件**

- 修改的主文件: `src/providers/core/runtime/gemini-cli-http-provider.ts`
- 测试脚本:
  - `test-antigravity-task-b1.py` (Header测试)
  - `test-antigravity-task-c.py` (Tools测试)
  - `run-antigravity-429-debug.sh` (一键运行)
- 文档:
  - `task.md` (原始计划)
  - `ANTIGRAVITY_429_DEBUG_GUIDE.md` (详细指南)
  - 本文件 (总结)
