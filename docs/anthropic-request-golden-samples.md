### Anthropic Golden Request Samples

我们把真实 `/v1/messages` 请求快照统一保存在 `~/.routecodex/golden_samples/anthropic_requests/`，每个目录
包含：

```
<slug>/
  request_payload.json  # 直接发送给 Anthropics API 的 json
  meta.json             # 来源阶段、采样说明、endpoint 等元数据
```

> **提示**：仓库内 `samples/chat-blackbox/anthropic/request-basic.json` 为上述样本的版本化拷贝，可在代码评审时直接 diff。
> 建议先用真实 provider 生成阶段快照，并把 `body` + `stageFile` 写入
> `~/.routecodex/golden_samples/new/anthropic-messages/<providerId>/`。随后执行
> `node scripts/tools/capture-provider-goldens.mjs --update-golden`，脚本会读取这些快照并同步
> `provider_golden_samples/`，检测到字段差异时会提示是否覆盖。

当前样本：

| slug | 描述 | Source Stage |
|------|------|--------------|
| `glm46-toolcall-20251209T223550158-010` | 用户让助手列出仓库目录，prompt 中包含 Codex/CLAUDE 大段 system 规则，`stream=true`，用于验证工具治理路径 | `anthropic-messages/req_1765290950164_req_inbound_stage1_format_parse.json` |
| `glm46-toolcall-20251209T223550463-011` | 用户只说“列出本地文件”，模型应拒绝直接读取本地盘，适合验证拒绝/告警逻辑 | `anthropic-messages/req_1765290950463_req_inbound_stage1_format_parse.json` |

#### 如何回放

1. 启动 RouteCodex，确保目标 provider（例如 `glm.key1.glm-4.6`）可用。
2. 直接将样本作为请求体发送：

```bash
curl -s http://127.0.0.1:5555/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer test' \
  --data @~/.routecodex/golden_samples/anthropic_requests/glm46-toolcall-20251209T223550158-010/request_payload.json
```

3. 如果需要切换 provider，只需修改 JSON 中的 `model` 字段或配合用户配置热更（无需 CLI 抓样本）。

#### 验证快照

- 设置 `ROUTECODEX_HUB_SNAPSHOTS=1` 后回放，`~/.routecodex/golden_samples/anthropic-messages/` 将刷新对应的
  `req_*` 与 `resp_*` 阶段文件，可直接 diff。
- `anthropic/glm46-toolcall-…` 目录内已有响应黄金样本，可与请求目录交叉比对，确认入站/出站一致性。

#### 扩展样本

1. 捕获目标请求期间的 `req_*_req_inbound_stage1_format_parse.json`
2. 在 `anthropic_requests/` 下创建新子目录，复制 `body.payload` 为 `request_payload.json`
3. 写入 `meta.json` 说明模型、来源阶段、场景描述
4. 更新本文档表格即可
