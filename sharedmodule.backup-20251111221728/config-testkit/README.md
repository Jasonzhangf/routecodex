# routecodex-config-testkit

用于配置引擎/兼容层的测试与样例集锦（共享模块）。包含黑盒/白盒测试脚本与样例快照，方便离线验证配置。

## 内容
- `debug-*.js`：各类调试脚本（环境变量展开、校验、排序等）
- `test/` 与 `test-snapshots/`：快照与期望输出

## 使用
```bash
node sharedmodule/config-testkit/debug-validation.js
node sharedmodule/config-testkit/debug-blackbox-tester.js
```

## 构建顺序（提示）
本目录多为脚本与样例，无需构建。但若依赖 `config-engine` 或 `config-compat` 的产物，请先构建对应共享模块，再在根目录构建：
- 先模块：`npm --prefix sharedmodule/config-engine run build`
- 后整包：`npm run build`

