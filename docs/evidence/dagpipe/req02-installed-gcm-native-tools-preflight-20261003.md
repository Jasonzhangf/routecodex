# 当前已安装入口的 GCM 工具最小 probe

状态：PASS，仅证明当前 GCM 客户端的一次原生 apply_patch Add→Update→exec 回读闭环。不是 REQ02 接线、候选 binary、MCP 或两模型完整工具验收。

- 当前安装命令：`/Users/fanzhang/.local/bin/rccv3`；命令版本 `0.90.4825`（crate 0.1.0）。本 probe 未执行安装或服务 lifecycle。
- 新建 child：gcm profile，显式请求 model `gpt-5.5`；thread `01a1012d-c904-7f92-96db-0793e152dbd3`；handle 3234 实际 exit0。
- 原生 Add 和 Update 均有真实 completed `file_change` 回执；exec item8 实际 exit0，回读文件并输出 SHA256；最终回答消费了文件内容与哈希。
- 父独立读取文件内容为两行 `REQ02_NATIVE_PATCH_UPDATED`、`REQ02_NATIVE_PATCH_TAIL`；SHA256 `b052e89df4d58da13dac7f7dbf6c48db5152d6eeafe51fbfe32a0d8ae6c47940`。
- 原始日志：`.execution/native-tool-probe-r1/worker.jsonl`、`.stderr`；标记：`.execution/native-tool-probe-r1/marker.txt`。源码与生产配置只读。

此前测试作者的“文件已创建”描述没有 file_change 回执且实际文件不存在。此 probe 表明当前原生工具可执行，不能将那个作者的未落盘结果归因到代理回归；没有绑定 provider 样本，也不判断其具体 provider/model 根因。

父继续 REQ02 作者实现与真实测试，最终候选仍须分别通过 gpt-5.5/gpt-5.6 的 exec、apply_patch、MCP 和 follow-up 验收。
