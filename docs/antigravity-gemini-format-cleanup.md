---
title: Antigravity Gemini 格式清理要求
date: 2026-01-25
tags:
  - routecodex
  - antigravity
  - gemini
  - claude
status: active
---

# Antigravity Gemini 格式清理要求（gcli2api 对齐）

> [!summary]
> 本文汇总当前 **antigravity** 走 Gemini 协议时的格式清理要求，覆盖 **Gemini 系列** 与 **Claude 系列** 的关键输出/请求规范、UA/Headers 规范、工具历史一致性要求等。
> 本次改动已生效：历史 `functionCall` 强制补 `thoughtSignature: "skip_thought_signature_validator"`。

## 1) 适用范围
- **Gemini 系列**：`gemini-3-pro-low / gemini-3-pro-high` 等 Gemini 协议模型。
- **Claude 系列**：`claude-*` 走 antigravity/兼容层的 Gemini 路由时的兼容字段统一。

---

## 2) UA 与 Headers（gcli2api 对齐）
- **User-Agent**：固定为 `gcloud-cli/1.11.3`（对齐 gcli2api 行为）。
- **Headers 关键项**：
  - `x-goog-api-client`: `gl-go/1.0.0 gccl/1.11.3`
  - `x-goog-user-project`: 使用 `project`（保持与 gcli2api 一致）
  - `x-goog-request-params`: `model=...`
  - `x-client-request-id` + `x-goog-request-id`（使用 requestId/requestType 组合）
- **Body 结构**：
  - 仅保留 gcli2api 需要的最小字段集合
  - **不带 sessionId**
  - 保持 `contents / systemInstruction / safetySettings / generationConfig / tools` 的一致性顺序与结构

---

## 3) 工具与历史一致性（核心要求）

> [!important]
> **历史中出现的工具调用必须与当前请求 tools 对齐**。历史中不得出现当前 tools 列表中不存在的工具调用。

- **历史工具清理**：
  - 对 **history 中出现但当前 tools 不存在** 的 `functionCall`/`functionResponse` 做 **移除或降级为纯文本**。
  - 保持 **tools 列表与历史工具调用**的 **一一对应**。
- **工具名合法性**：
  - Gemini 对函数名字符集/形状严格校验；不合法名称需 **清理或过滤**。
- **工具 schema 对齐**：
  - 历史 `functionCall.args` 必须与当前工具 schema 对齐。
  - 对 `args` 做 **结构修正**：Gemini 期望 `functionCall.args` 为对象（Struct），非对象需包 `value`。

---

## 4) Gemini 协议的格式清理要点

### 4.1 functionCall 历史补签名
- **新增要求（已生效）**：
  - 历史 `functionCall` **必须包含**：
    - `thoughtSignature: "skip_thought_signature_validator"`
  - 这是 gcli2api 的行为：即使没有真实签名，也需要该字段以通过 Cloud Code 严格校验。

### 4.2 工具 schema 输出
- **始终输出工具 schema**（Gemini 需要工具声明来校验 `functionCall`/`functionResponse`）。
- `toolConfig.functionCallingConfig`：
  - `NONE / ANY / ALLOWED` 按 `tool_choice` 映射。

### 4.3 Content 清理
- 统一 `contents` 结构，确保每条 entry 的 parts 合法。
- 对无效 part 做降级或过滤，避免 Gemini 侧 malformed。

---

## 5) Claude 系列在 Antigravity 中的兼容统一

- Claude-thinking / 非 thinking 输出在 antigravity 侧 **统一形态**：
  - 保证与 Gemini/OpenAI 响应结构一致的 **content 形状**。
- 保持 **history/tool 行为与 Gemini 同步**（同样遵循历史工具一致性要求）。

---

## 6) 当前已生效的关键修复

- ✅ **历史 functionCall 强制补 `thoughtSignature`**（gcli2api 行为一致）。
- ✅ **history/tool 对齐清理**：历史工具调用不再允许与当前 tools 不一致。
- ✅ **args 结构修正**：非对象 args 包装到 `{ value }`。
- ✅ **UA/Headers 与 gcli2api 对齐**（最小 body、requestId/requestType headers）。

---

## 7) 验证方式（建议）

- 对比两条请求（首条无历史、次条带历史）：
  - `provider-request.json` 中 **`functionCall` 必须带 `thoughtSignature`**。
  - `tools` 与历史 functionCall **必须一一对齐**。
  - `args` 必须为对象（Struct）。

---

## 8) 备注

> [!note]
> 本次修改已验证生效。若后续仍出现 429 或 Cloud Code 严格校验失败，优先检查 **history 中工具清理是否遗漏** 或 **functionCall/Response 的结构化字段是否存在差异**。
