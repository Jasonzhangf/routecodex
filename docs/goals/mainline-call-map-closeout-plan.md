# Mainline Call Map Closeout Plan

## Objective
把 `function-map` 从 feature owner registry 升级为可查询的 mainline call map，补上 request / response / error 三条主线的 caller-callee 绑定，降低多文件项目里改错 facade/wrapper/transition 层的风险。

## Target Docs
- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/architecture/mainline-call-map.yml`
- `docs/design/pipeline-type-topology-and-module-boundaries.md`
- `docs/ARCHITECTURE.md`

## Execution Rules
- 先补绑定，不猜 symbol。
- 只写相邻节点边，不跳层。
- 真源 owner 必须同步写入 `feature_id`，`binding pending` 只允许在未验证边上使用。
- TS 只记桥接/薄壳；真语义 owner 仍以 Rust 为准。
- 删除旧 owner / 旧壳前先补红测，再物理删除。

## Verification
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-owner-queryability`
- `npm run verify:architecture-adjacent-builder-naming`
- 后续补 `verify:architecture-mainline-call-map` 或等价 gate

## Completion
当 request / response / error 三条主线都能从 feature_id 反查到唯一 owner、唯一相邻边、唯一验证栈时完成。
