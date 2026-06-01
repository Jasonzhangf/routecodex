/**
 * ProviderForwarder — TS 配置类型
 *
 * Forwarder 把同 protocol+model 的 N 个 ProviderProfile 折叠为 1 个 logical target。
 * 真源在 Rust Virtual Router；本文件仅声明配置 schema。
 *
 * 硬约束：
 * 1. forwarder id **仅做命名空间**（必须以 `fwd.` 开头）；禁止按 `split(".")` 推算 model/protocol
 * 2. 显式 `id / protocol / model` 字段独立配置
 * 3. 不持有 transport/auth/compat（纯索引，real target 字段由 ProviderProfile 提供）
 */

import type { ProviderProtocol } from './provider-profile.js';

export type ProviderForwarderStrategy = 'round-robin' | 'priority' | 'weighted';

export type ProviderForwarderResolutionMode = 'model-first' | 'provider-first';

export type ProviderForwarderStickyKey = 'session' | 'request' | 'none';

export interface ProviderForwarderTarget {
  /** 引用已有 ProviderProfile.id（必须同 protocol） */
  providerId: string;
  /** weighted 模式权重（可省略，省略时使用 entry-level weights 兜底） */
  weight?: number;
  /** priority 模式优先级（数字小者优先，可省略） */
  priority?: number;
  /** 标记 disabled（与 disabled_keys 同步） */
  disabled?: boolean;
}

export interface ProviderForwarderProfile {
  /** forwarder id，必须以 `fwd.` 开头；只做命名空间，不解析语义 */
  id: string;
  protocol: ProviderProtocol;
  /** 显式 model 字段；禁止从 id 推算（model 可能含 `.`） */
  model: string;
  /** 解析模式：model-first（按 model 找 forwarder） / provider-first（按 provider 找 forwarder） */
  resolutionMode: ProviderForwarderResolutionMode;
  /** 内部选路策略 */
  strategy: ProviderForwarderStrategy;
  /** 加权兜底（target 未覆盖 weight 时使用） */
  weights?: Record<string, number>;
  /** target 列表 */
  targets: ProviderForwarderTarget[];
  /** sticky 维度：session / request / none */
  stickyKey: ProviderForwarderStickyKey;
}

export interface ProviderForwarderCollection {
  profiles: ProviderForwarderProfile[];
  byId: Record<string, ProviderForwarderProfile>;
}

/** forwarder id 前缀常量（与 Rust forwarder.rs::FORWARDER_ID_PREFIX 保持一致） */
export const FORWARDER_ID_PREFIX = 'fwd.';

/** 命名空间校验：仅检查前缀，不解析语义 */
export function validateForwarderId(id: string): { ok: true } | { ok: false; reason: string } {
  if (!id.startsWith(FORWARDER_ID_PREFIX)) {
    return { ok: false, reason: `forwarder id '${id}' must start with '${FORWARDER_ID_PREFIX}'` };
  }
  if (id.length <= FORWARDER_ID_PREFIX.length) {
    return { ok: false, reason: `forwarder id '${id}' is empty after prefix` };
  }
  return { ok: true };
}
