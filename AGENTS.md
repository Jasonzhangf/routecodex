# AGENTS 指南

- 涉及 `sharedmodule/` 下的修改，需要遵循“先模块、后整包”的顺序完成构建。
  - 先编译共享模块（例如：`sharedmodule/llmswitch-core`），再编译根包并进行安装或发布。

