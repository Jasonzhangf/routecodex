# Virtual Router Hit 时间戳功能说明

## 新增功能

在 Virtual Router hit 日志中添加了本地时间戳显示，方便用户追踪请求时序和性能。

## 日志格式

### 修改前
```
[virtual-router-hit] default -> crs.gpt-5.2-codex reason=route:default
```

### 修改后
```
[virtual-router-hit] 21:23:45 default -> crs.gpt-5.2-codex reason=route:default
```

## 显示效果

时间戳格式：`HH:mm:ss` (24小时制)
- 使用灰色显示，不干扰主要信息
- 精确到秒，便于计算请求间隔
- 自动使用本地时区

## 示例日志

```bash
[virtual-router-hit] 20:32:15 default -> crs.gpt-5.2-codex reason=route:default
[virtual-router-hit] 20:32:16 coding -> tab.gpt-5.2-codex reason=coding(apply_patch)
[virtual-router-hit] 20:32:18 thinking -> antigravity.claude-sonnet-4-5-thinking reason=thinking
[virtual-router-hit] 20:32:45 default -> glm.glm-4.7 reason=fallback:default
```

从这些时间戳可以看出：
- 第一个请求：20:32:15
- 第二个请求：20:32:16（间隔 1 秒）
- 第三个请求：20:32:18（间隔 2 秒）
- 第四个请求：20:32:45（间隔 27 秒 - 可能是重试或降级）

## 实现细节

### 正常路径（彩色终端）
- 使用 `padStart` 确保时间格式统一（例如 `09:05:03`）
- 时间戳显示为灰色（`\x1b[90m`），不影响其他颜色标记
- 路由名称保持原有颜色编码

### 降级路径（纯文本）
- 使用 `toLocaleTimeString('zh-CN', { hour12: false })` 
- 确保即使彩色渲染失败也能显示时间

## 使用场景

1. **性能分析**：查看请求间隔，识别高峰时段
2. **故障排查**：结合时间戳定位问题发生时刻
3. **负载监控**：观察请求频率和分布
4. **等待时间计算**：计算从发起到路由的延迟

## 版本信息

- **添加版本**: 0.89.360
- **文件位置**: `sharedmodule/llmswitch-core/src/router/virtual-router/engine.ts`
- **修改行数**: 564-585

## 测试

启动服务器并发送请求，观察日志：

```bash
routecodex start

# 在另一个终端发送测试请求
curl -X POST http://localhost:5555/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

预期输出包含类似：
```
[virtual-router-hit] 21:25:30 default -> crs.gpt-5.2-codex reason=route:default
```
