# 70 Gate Discovery

## 何时用
- 你不知道这次改动最少要跑哪些 gate
- 你要从 `feature_id` 反查验证栈
- 你要证明 owner/gate/queryability 已闭环

## 先查 feature 自己的 gate
1. `rg -n 'feature_id: <id>' docs/architecture/verification-map.yml`
2. 看：
   - `contract`
   - `integration`
   - `smoke`
   - `build`
3. 再查 `docs/architecture/function-map.yml` 的 `required_gates`
4. `required_gates` / verification `smoke` 里要写可反查的 `npm run <script>`；不要直接写裸 `cargo test ...` 或长 `jest:run ...`。裸命令会被 owner-queryability 判红，先在 `package.json` 建脚本再挂 map。

## 架构基线 gate
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-owner-queryability`
- `npm run verify:architecture-feature-map-growth-discipline`
- `npm run verify:architecture-provider-specific-leaks`
- `npm run verify:architecture-thin-wrapper-only`
- `npm run verify:architecture-error-chain-bypass`
- `npm run verify:architecture-metadata-leak-boundary`
- `npm run verify:architecture-nonadjacent-conversion`
- `npm run verify:architecture-forbidden-path-growth`

## 什么时候至少跑这三个
- 新增 owner
- 改 owner_module / owner_scope / owner_kind
- 新增 `feature_id`
- 改 allowed/forbidden paths

最小三件套：
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-owner-queryability`
- `npm run verify:architecture-feature-map-growth-discipline`

## 查某 gate 谁在用
- `rg -n 'verify:function-map-compile-gate' docs/architecture/function-map.yml docs/architecture/verification-map.yml package.json scripts`

## 查某 feature 的最小验证栈
- `rg -n 'feature_id: hub\\.servertool_followup' docs/architecture/verification-map.yml -A 20`

## live 验证原则
- gate 只是门禁
- 真正 closure 还要：
  - build / health
  - real sample replay
  - live `/v1/responses` or target entry probe

## 反模式 / 边界
- ❌ 只跑 unit tests 就宣称闭环
- ❌ 只看 package.json，不看 verification map
- ❌ 跑 broad 全量 gate 替代最小 feature gate 分析
- ✅ 先 feature -> required_gates，再补 architecture baseline，再做 live

## 相关 references
- [40-owner-registry.md](./40-owner-registry.md)
- [50-rcc-config-ssot.md](./50-rcc-config-ssot.md)
