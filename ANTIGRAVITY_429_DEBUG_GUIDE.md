# Antigravity 429 Debug - Task.md方法执行指南

根据 `task.md` 第87-114行的系统化方法，从 gcli2api 能200的基础逐步添加 RouteCodex 差异项。

## 前置准备

1. **获取 Antigravity Access Token**:
```bash
# 方法1: 从RouteCodex token文件获取
cat ~/.routecodex/auth/antigravity-oauth-1-geetasamodgeetasamoda.json | jq -r '.access_token'

# 方法2: 从gcli2api获取
# (如果gcli2api有专门的token获取命令)
```

2. **设置环境变量**:
```bash
export ANTIGRAVITY_ACCESS_TOKEN="your_token_here"
export ANTIGRAVITY_API_BASE="https://daily-cloudcode-pa.sandbox.googleapis.com"
```

## 执行测试序列

### Step A: 基础对齐（你已完成）
- ✅ A1: session_id → 已验证200
- ✅ A2: Accept/Accept-Encoding → 已验证200

### Step B: Header深度对齐

```bash
cd /Users/fanzhang/Documents/github/routecodex
python3 test-antigravity-task-b1.py
```

**预期结果**:
- 如果 B1.1-B1.4 都返回200 → Headers不是问题，继续Step C
- 如果某个步骤开始429 → 找到了Header层面的触发点

### Step C: Tools差异测试

```bash
python3 test-antigravity-task-c.py
```

**预期结果**:
- C1.1 (无tools) = 200
- C1.2 (googleSearch) = 200  
- C2.1 (单个MCP tool) = ?
- C2.2 (多个MCP tools) = ?
- C2.3 (混合) = ?

**如果C2.1就429** → 任何非googleSearch的tool都不被Antigravity接受
**如果C2.2才429** → 有tool数量限制

### Step D: generationConfig测试

如果B和C都没问题，再测试generationConfig的影响。

## 快速测试（组合）

```bash
#!/bin/bash
# 运行完整测试序列

echo "设置Token..."
export ANTIGRAVITY_ACCESS_TOKEN=$(cat ~/.routecodex/auth/antigravity-oauth-1-geetasamodgeetasamoda.json | jq -r '.access_token')

echo ""
echo "========================================="
echo "Step B: Header测试"
echo "========================================="
python3 test-antigravity-task-b1.py

echo ""
echo "========================================="
echo "Step C: Tools测试" 
echo "========================================="
python3 test-antigravity-task-c.py

echo ""
echo "========================================="
echo "测试完成！请查看上方结果找出429的触发点"
echo "========================================="
```

保存为 `run-antigravity-429-debug.sh` 并执行：
```bash
chmod +x run-antigravity-429-debug.sh
./run-antigravity-429-debug.sh
```

## 结果分析

根据测试结果填写：

- [ ] B1 结果: Headers ___ (是/否) 导致429
- [ ] C1 结果: Tools ___ (是/否) 导致429
  - 如果是，具体是: □ 任何MCP tool  □ 多个MCP tools  □ 特定tool类型
  
## 修复方向

**如果Headers导致429**:
→ 在RouteCodex中移除或修改相关headers

**如果Tools导致429**:
→ 在RouteCodex的gemini-cli-http-provider中过滤MCP tools（已实现）

**如果都不是**:
→ 继续Step D测试generationConfig

## 当前RouteCodex修改状态

已实施的修复：
1. ✅ 添加 `requestType: "agent"` 字段
2. ✅ 过滤非googleSearch的MCP tools
3. ✅ 移除Antigravity请求中的 `session_id`

需要验证这些修改是否解决了问题。
