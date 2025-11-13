# perKey 路由规则（确定性）

前提：启用 perKey 模式（全局或流水线级）。

- 流水线 ID（实例）：`<providerId>.<modelId>__<keyId>`
- routing 中的不带 key 的 ID（仅在 perKey 下有效）：`<providerId>.<modelId>` 表示“该 provider 在 keyVault 中所有启用 key 的并集”。
- 展开与顺序：
  - 将 `<pid>.<mid>` 展开为 `<pid>.<mid>__<kid>` 列表；
  - 按 keyId 字典序排序并去重，输出确定性一致。
- 校验：
  - 若 keyVault[pid] 无启用 key → 报错（非推测）；
  - 若 routing 同时包含 `<pid>.<mid>` 与 `<pid>.<mid>__<kid>` → 合并去重；
  - 若引用的 perKey id 不存在于 pipelines → 报错。

ID 规范：
- 实例 ID：`<providerId>.<modelId>__<keyId>`
- 模板 ID：`<providerId>.<modelId>`（仅用于 perKey 下 routing 的“all-keys”语义与诊断展示，不参与装配）

