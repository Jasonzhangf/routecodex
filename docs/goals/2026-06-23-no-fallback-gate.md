# 2026-06-23 no-fallback 全量 gate 源码面收敛

## 禁止项
1. 禁止批量 rename/move 文件
2. 禁止批量搜索替换（不区分调用链的全局替换）
3. 禁止改动 verify:no-fallback-all 的扫描脚本本身来"伪装通过"
4. 禁止在没有调用链证据的情况下直接删 fallback 参数或改函数签名
5. 禁止引入新的 fallback 模式替代旧模式（如把 `?? ''` 改成 `|| ''`）

## 执行项
1. 逐个文件/逐个函数基于调用链分析后精确改
2. 只改 gate 规则和业务实现，不改无关代码
3. 每改完一个独立单元，立即跑相关测试验证，不要攒到最后一起跑
4. 核实静态扫描命中（verify:no-fallback-all）是否仍产生 fallback-keyword 误报；若 gate 缺类规则，先补 gate，不做无关的业务代码变更
5. 必须补 ebpf/compile 校验和集成测试

## 当前状态
- npm run verify:no-fallback-all 仍 FAIL，剩余 173 个 fallback-keyword 命中（83 文件）
- `npm run verify:architecture-fallback-denylist` 验证结果为 0 条违规
- `git diff --check` PASS
- 剩余债务清单：/tmp/fallback_hits_detail.txt

## 验证标准
- npm run verify:no-fallback-all PASS
- git diff --check PASS
- npm run verify:architecture-fallback-denylist PASS
- 剩余命中仅剩无法通过规则收敛的真实 fallback 债务并写入 note.md
