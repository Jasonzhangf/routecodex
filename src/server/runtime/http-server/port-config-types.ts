/**
 * Port Mode & Protocol Routing — Configuration Types
 */

export type PortMode = 'router' | 'provider';
export type ProtocolBehavior = 'direct' | 'relay' | 'auto';
export type SameProtocolBehavior = 'direct' | 'relay';

/**
 * G10: Provider-mode ports may declare an explicit failure-handling exemption
 * from the unified ErrorErr05 reroute/cooldown budget. The only currently
 * supported value is `single_binding_rethrow`, which is the
 * spec-documented behavior for provider-mode single-binding ports: a
 * provider send failure on a provider-mode port MUST be rethrown to the
 * caller (5xx to the client). Host MUST NOT silently reroute the request
 * to any other provider (which would mean the caller no longer has the
 * provider they contracted to). See
 * `docs/goals/provider-error-chain-direct-relay-audit-2026-06-15.md` G10.
 */
export type ProviderFailureExemption = 'single_binding_rethrow';

export interface PortStopMessageConfig {
  enabled?: boolean;
  includeDirect?: boolean;
}

export interface PortConfig {
  port: number;
  host: string;
  mode: PortMode;
  // router mode: must reference a virtualrouter.routingPolicyGroups key
  routingPolicyGroup?: string;
  // provider mode: must reference a provider key
  providerBinding?: string;
  // provider mode: direct/relay/auto
  protocolBehavior?: ProtocolBehavior;
  apikey?: string;
  timeout?: number;
  bodyLimit?: string;
  // router mode: same-protocol direct bypass behavior (default: 'direct')
  sameProtocolBehavior?: SameProtocolBehavior;
  // provider mode: optional explicit failure-handling exemption. Currently
  // only 'single_binding_rethrow' is allowed; router mode rejects this field.
  providerFailureExemption?: ProviderFailureExemption;
  // per-port stopMessage gate; when enabled=false, stopMessage auto followup is disabled for requests entering this port.
  stopMessage?: PortStopMessageConfig;
}

export type PortStatus = 'starting' | 'running' | 'error' | 'stopped';

export interface PortRuntimeState {
  port: number;
  host: string;
  mode: PortMode;
  protocolBehavior?: ProtocolBehavior;
  routingPolicyGroup?: string;
  providerBinding?: string;
  status: PortStatus;
  // router mode: same-protocol behavior
  sameProtocolBehavior?: SameProtocolBehavior;
  stopMessage?: PortStopMessageConfig;
  activeConnections: number;
  error?: string;
  serverId?: string;
}

export interface PortCreateOrUpdateRequest {
  host?: string;
  mode: PortMode;
  routingPolicyGroup?: string;
  protocolBehavior?: ProtocolBehavior;
  providerBinding?: string;
  // router mode: same-protocol behavior
  sameProtocolBehavior?: SameProtocolBehavior;
  // provider mode: explicit failure-handling exemption
  providerFailureExemption?: ProviderFailureExemption;
  apikey?: string;
  timeout?: number;
  bodyLimit?: string;
  stopMessage?: PortStopMessageConfig;
}

export interface PortView {
  port: number;
  host: string;
  mode: PortMode;
  protocolBehavior?: ProtocolBehavior;
  routingPolicyGroup?: string;
  providerBinding?: string;
  // router mode: same-protocol behavior
  sameProtocolBehavior?: SameProtocolBehavior;
  // provider mode: explicit failure-handling exemption
  providerFailureExemption?: ProviderFailureExemption;
  stopMessage?: PortStopMessageConfig;
  status: PortStatus;
  activeConnections: number;
  error?: string;
}

export interface PortListView {
  ports: PortView[];
}

export function createDefaultRouterPort(
  port: number,
  host = '0.0.0.0',
  routingPolicyGroup = 'default',
  sameProtocolBehavior: SameProtocolBehavior = 'direct'
): PortConfig {
  return { port, host, mode: 'router', routingPolicyGroup, sameProtocolBehavior };
}

export function createDefaultProviderPort(
  port: number,
  providerBinding: string,
  protocolBehavior: ProtocolBehavior = 'auto',
  host = '0.0.0.0',
): PortConfig {
  return { port, host, mode: 'provider', protocolBehavior, providerBinding };
}
