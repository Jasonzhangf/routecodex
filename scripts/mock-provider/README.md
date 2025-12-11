# Mock Provider 脚本概览

## extract.mjs（待实现）
- 输入：`--req <requestId>` 或 `--all`
- 步骤：
  1. 在 `~/.routecodex/codex-samples/<入口>/` 内查找 `provider-request/response` 文件。
  2. 根据 provider config 推断 `providerId`（目录名）和模型。
  3. 按命名规范重命名并复制到 `samples/mock-provider/<入口>/`。
  4. 更新 `_registry/index.json`。

## validate.mjs（待实现）
- 检查所有样本命名是否符合规范。
- 校验 request/response 中 reqId、endpoint、model、timestamp 是否一致。

## clean.mjs（待实现）
- 删除超过阈值的旧样本（例如按日期、标签）。
- 可选择只保留最新 N 个。
