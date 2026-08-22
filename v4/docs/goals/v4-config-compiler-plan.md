# V4 Config Compiler Independent Freeze Plan

## Objective

实现并冻结 `routecodex-v4-config`：把 authoring 配置严格编译为唯一 deterministic runtime manifest。runtime 只能消费该 manifest，不得扫描 authoring 目录；配置、控制、secret handle 都不得进入业务 payload。

## Fixed Chain

```text
V4Config01AuthoringFileSource
  -> V4Config02AuthoringParsed
  -> V4Config03SchemaValidated
  -> V4Config04ResourceRegistryBuilt
  -> V4Config05ManifestPublished
```

每段只允许相邻 information edge。五个节点派生冻结的 BaseNode；边校验复用冻结的 Edge。Config 不拥有业务 payload、runtime loader、provider 行为或路由决策。

## Contract

1. 所有 authoring struct 使用 strict unknown-field rejection。
2. node、operator、plugin、hook、resource、edge 引用必须存在且唯一。
3. operator/plugin 绑定一致；hook kind 与 entry/exit slot 一致。
4. config edge 只承载 information 资源且只连相邻节点。
5. data/payload 资源禁止绑定到 config 节点或 edge。
6. auth 只允许 `env:` / `token_file:` handle；secret material 不进 manifest。
7. manifest 对无语义顺序差异稳定排序，记录 manifest version、chain version 与 SHA-256 hash。
8. 失败显式返回 typed ConfigError；无 fallback、silent strip 或 runtime 补偿。

## Regression

- Whitebox: unknown field、unknown/mismatched references、non-adjacent edge、resource axis、payload binding、secret material 全部 fail-fast。
- Blackbox: 公共 `compile_authoring` 产生可消费 manifest，固定 version/hash/canonical output；相同语义不同 authoring 顺序产物一致。
- Freeze: `cargo test -p routecodex-v4-config --test l2_config` 至少 15 tests；AppSDK records 绑定 source/artifact/API/scope/input hashes。

## Boundaries

- 不修改 V3。
- 不实现 runtime config loader。
- 不解析 provider-specific action 语义；provider 差异后续仅以 operator/plugin 声明扩展。
- Active 只发布编译后的 Rust library；Generated/Protected/Active artifact 不提交 Git。
