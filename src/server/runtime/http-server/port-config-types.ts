/**
 * Port Mode & Protocol Routing — Configuration Types
 */

export type PortMode = 'router' | 'provider';
export type ProtocolBehavior = 'direct' | 'relay' | 'auto';
export type SameProtocolBehavior = 'direct' | 'relay';

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
