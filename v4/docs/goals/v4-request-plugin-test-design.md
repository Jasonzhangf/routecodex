# V4 请求链插件测试设计

## 生命周期

```text
HTTP raw body
  -> Node01 raw capture
  -> Node02 JSON/SSE frame boundary
  -> Node03 Responses normalize
  -> Node04 scope/continuation/tool governance
  -> VR entry-model admission/candidate filter/target select
  -> Node05 provider semantic + target model replacement
  -> Node06 Direct/Relay compat
  -> Node07 provider wire validation
  -> provider transport
```

## 白盒合同

- Node01/02/03 不读取或判定 `model`；malformed、非 object、multi-data SSE fail-fast。
- Node04 小插件分别拥有 scope restore、continuation restore、tool governance；不做协议/路由/model replacement。
- VR 小插件分别拥有 entry model admission、candidate filter、target selection；结果只写 typed route resources。
- Node05 读取 typed target selection，把 entry model 替换为 provider wire model；route/control 字段不进入 semantic payload。
- Node06 Direct 保持 Responses shape；Relay 只执行登记的相邻 compat；无映射 fail-fast。
- Node07 只验证 wire boundary；auth/transport 不进入插件 payload。

## 模块黑盒

- `standard-plugins`：Node01-07 与 VR 小插件 descriptors/handles/plan 可执行；无 mock id。
- `router`：alias admission 与 provider model replacement 分离；unknown/invalid model fail-fast；无 model 时按 manifest priority。
- `runtime`：真实 NodeContainer/Cordis bridge 顺序执行；trace 含 Node01-07 与 VR 私有节点；输出 typed target + provider wire。
- `cordis-bridge`：data/control 分离；config/route/target typed resource 权限严格。

## 项目黑盒

- Direct：Responses entry -> Responses provider，同协议 wire；JSON/SSE 均完成。
- Relay：Responses entry -> governed semantic -> registered compat -> provider wire；JSON/SSE 均完成。
- 反向：unknown model、未登记 compat、control/debug/scope/error 字段、handler 旁路均失败。

## 已固化前置红态

- runtime package 初始不在 workspace，定向命令报 package not found。
- standard plugin registry 初始缺 Node01/VR 小插件，L2 明确报 missing plugin id。
- router 初始缺 admission/selection symbols，L2 编译红。
- runtime-bin 初始直接调用 VR/wire，静态旁路 gate 红。

以上红态已由对应 owner 实现转绿；红自测继续锁住插件删除、handler 旁路、
runtime dispatch 删除与 map edge 删除。
