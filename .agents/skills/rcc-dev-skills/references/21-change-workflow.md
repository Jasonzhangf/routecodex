# 21 Change Workflow（功能变更标准流程）

## 目的
- 解决“路径有新旧函数、grep 到多处、容易改错层”的问题。
- 目标不是“找到一个能改的地方”，而是先锁唯一 owner，再只改唯一真源。

## 标准顺序

1. 查 `function map`
- 先查 `docs/architecture/function-map.yml`。
- 先拿到：
  - `feature_id`
  - `owner module`
  - `allowed_paths`
  - `forbidden_paths`
  - `required_tests`
- 如果这里已经明确唯一 owner，先不要继续 grep 整仓。

2. 查 `verification map`
- 再查 `docs/architecture/verification-map.yml`。
- 先锁：
  - 最小 white-box
  - 最小 module black-box
  - 必要 build / smoke / live replay
- 没有验证映射时，只能说“准备改代码”，不能说“能闭环验证”。

3. 查 `mainline call map`
- 再查 `docs/architecture/mainline-call-map.yml`。
- 目标是确认 live 主线到底经过哪个 caller / callee，不要把 facade / wrapper / transitional layer 误当 owner。
- 必须锁到：
  - from node
  - to node
  - caller
  - callee
  - file path
  - status

4. 查 wiki / mainline source
- 再看对应 wiki 页面或 mainline source，确认节点编号、主线位置、分支位置。
- 重点不是“看图”，而是确认你要改的是哪一个 lifecycle 节点，不是最终症状节点。

5. 锁唯一修改点
- 用下面四问锁死：
  - 首次语义变化发生在哪个节点？
  - 这个节点唯一 owner 是谁？
  - 这个 owner 的允许修改路径是什么？
  - 哪些层明确禁止改？
- 若 1-2 次查询后仍不能锁到唯一 owner：
  - 先补 map / mainline binding / wiki node anchor。
  - 不允许靠猜测同时改 TS / Rust、host / native、bridge / runtime 两层。

## 唯一修改点判定法

### A. 改“首次污染节点”，不改“最终报错点”
- provider request 污染，不一定改 provider runtime；先找污染第一次进入主线的位置。
- client response 错，不一定改 response handler；先找错误第一次被投影的位置。
- continuation 恢复错，不一定改 store；先锁 restore / materialize owner。

### B. 编排层薄，语义层厚
- orchestrator / route / adapter / handler 默认只做编排。
- 真正承载 builder / parser / validator / projector / normalize 语义的地方，才是优先 owner。
- 如果编排层和语义层同时都“看起来能修”，优先改语义 owner，除非 function map 明确写编排层就是 owner。

### C. 新旧函数并存时
- 先看 mainline call map 哪条边是 `anchored`。
- 再看调用链里谁真的被当前入口命中。
- 旧函数如果不在当前主线上，不允许因为名字像就顺手改。

## 修改前必须锁的东西

1. 红测或 failing sample
- 先固化最小失败样本：
  - 单测
  - 模块黑盒
  - 真实样本 replay
- 没有“先红”证据，不进入实现。

2. 禁止修改路径
- 明确本轮不能改哪些层：
  - SSE / protocol projection
  - provider adapter
  - host wrapper
  - direct lane
  - docs only
- 如果根因不在这些层，禁止去这些层补偿。

3. live 入口
- 先确认最终复核入口：
  - 哪个端口
  - 哪个 endpoint
  - 哪个 sample
  - 哪个日志关键字

## 修改动作

1. 只改唯一 owner
- 只让红测命中的唯一 owner 变绿。
- 禁止双写同义逻辑。

2. 同步补绑定
- 改动如果改变了：
  - owner
  - mainline edge
  - 节点语义
  - 验证栈
- 必须同步更新对应 map / wiki / source anchor。

3. 物理删除错误残留
- 已确认错误的旧 helper、旧路径、旧 carrier、旧 normalizer，不允许只闲置。
- 必须物理删除或至少进入本轮明确删除计划。

## 验证顺序

1. 先跑最小 white-box
2. 再跑 module black-box
3. 再跑项目黑盒 / replay
4. 再编译 / 构建 / 全局安装
5. 再重启服务并用旧样本在线复放

## 汇报格式
- 改了什么 owner
- 为什么这是唯一修改点
- 跑了哪些 white-box / black-box / build / live replay
- 哪些位置明确排除了
- 剩余缺口是什么

## 反模式
- 靠 grep 命中最多的文件直接改
- 在最终输出层补丁而不追首次污染节点
- TS / Rust 双侧都补一版“等价逻辑”
- 没有 failing sample 就先改
- 只跑单测，不跑 live replay 就宣称闭环
