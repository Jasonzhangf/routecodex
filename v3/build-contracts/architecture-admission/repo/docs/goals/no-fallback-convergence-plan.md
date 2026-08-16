# no-fallback 全量 gate 源码面收敛计划

## 目标
让 `npm run verify:no-fallback-all` PASS，输出剩余真实 fallback 债务清单。

## 当前状态
- `verify:no-fallback` (diff gate) PASS
- `verify:no-fallback-all` FAIL: 173 fallback-keyword hits, 6 empty-default-operator hits (共 179 hits)
- 排除生成物/临时物已完成
- 剩余 83 个文件含 fallback-keyword 命中
- 不允许批量改名，不允许批量操作

## 3 类 allowlist 补全（精确 per-path + per-text，禁止目录级一刀切）

### a. 初始化默认值
- `?? {}` / `|| {}` / `?? []` / `|| []` 仅用于顶层 spread/克隆
- 用 allowlist 条目覆盖，每条: pathContains + textContains

### b. parser/transport 容错
- catch → return <原始值>/null/false
- 函数签名不含 fallback: 参数
- 用 allowlist 覆盖 catch 块和容错路径

### c. 术语字面量
- 注释/类型声明/测试字符串/审计工作文案
- 用 allowlist 覆盖 pattern 精确匹配

## 不能做什么
- 不允许用 Python 批量改 TS 源码文件
- 不允许批量重命名文件/变量
- 不允许用 npm/python 脚本直接改写业务代码逻辑
- 不能直接修改 `.cjs` / `.mjs` 业务文件里的函数签名参数名（rename fallback → defaultValue 等）——这是 Jason 明确禁止的
- 不碰 `package.json`
- 不碰 `eslint.config.js`
- 不碰 `dist/`、`tmp/`、`test/` 下的生成物

## 要做什么
1. 每补完一类 allowlist → 跑一次 `npm run verify:no-fallback-all` 确认命中数下降
2. 补 allowlist 用 `apply_patch` 改 `docs/architecture/no-fallback-diff-rules.json`，每次 1-2 条
3. 三类收口后，输出剩余命中清单（按文件+规则分组）
4. 将剩余债务写入 note.md

## 验证要求
- `npm run verify:no-fallback-all` PASS
- `git diff --check` PASS

## 完成标准
- `verify:no-fallback-all` PASS，或剩余仅剩已确认无法通过规则收敛的真实 fallback 债务
- note.md 收录本轮收口记录（命中数变化、allowlist 条目、剩余债务）
