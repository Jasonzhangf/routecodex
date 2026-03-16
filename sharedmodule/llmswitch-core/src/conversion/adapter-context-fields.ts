/**
 * AdapterContext 全局唯一真源字段定义
 *
 * 严格遵守 camelCase 命名规范，废弃所有 snake_case 别名
 *
 * 原则：
 * - 每个语义只保留一个标准字段
 * - 优先使用 camelCase
 * - 兼容性层负责转换，不引入别名
 */

/**
 * 工作目录字段
 * 
 * 唯一真源：`cwd`
 * 
 * 废弃：`workdir`, `workingDirectory`
 */
export const ADAPTER_CONTEXT_CWD = 'cwd' as const;

/**
 * tmux 会话字段
 * 
 * 唯一真源：`tmuxSessionId`
 * 
 * 废弃：`tmux_session_id`, `client_tmux_session_id`
 */
export const ADAPTER_CONTEXT_TMUX_SESSION_ID = 'tmuxSessionId' as const;

/**
 * Clock daemon 字段
 * 
 * 唯一真源：`clockDaemonId`
 * 
 * 废弃：`clock_daemon_id`, `clockClientDaemonId`, `clock_client_daemon_id`
 */
export const ADAPTER_CONTEXT_CLOCK_DAEMON_ID = 'clockDaemonId' as const;

/**
 * Client inject 就绪状态字段
 * 
 * 唯一真源：`clientInjectReady`
 * 
 * 废弃：`client_inject_ready`, `clientInjectReason`, `client_inject_reason`
 */
export const ADAPTER_CONTEXT_CLIENT_INJECT_READY = 'clientInjectReady' as const;

/**
 * 标准化 AdapterContext 字段集合
 * 
 * 用于 `propagateAdapterContextMetadataFields` 调用
 */
export const STANDARD_ADAPTER_CONTEXT_FIELDS = [
  ADAPTER_CONTEXT_CWD,
  ADAPTER_CONTEXT_TMUX_SESSION_ID,
  ADAPTER_CONTEXT_CLOCK_DAEMON_ID,
  ADAPTER_CONTEXT_CLIENT_INJECT_READY,
] as const;
