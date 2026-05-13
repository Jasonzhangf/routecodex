/**
 * Port Mode & Protocol Routing — Configuration Types
 */
import type { ProviderProtocol } from './types.js';

export type PortMode = 'router' | 'provider';
export type ProtocolBehavior = 'direct' | 'relay' | 'auto';

export interface PortConfig {
  port: number;
  host: string;
  mode: PortMode;
  protocolBehavior?: ProtocolBehavior;
  providerBinding?: string;
  apikey?: string;
  timeout?: number;
  bodyLimit?: string;
}

export type PortStatus = 'starting' | 'running' | 'error' | 'stopped';

export interface PortRuntimeState {
  port: number;
  host: string;
  mode: PortMode;
  protocolBehavior?: ProtocolBehavior;
  providerBinding?: string;
  status: PortStatus;
  activeConnections: number;
  error?: string;
  serverId?: string;
}

export interface PortCreateOrUpdateRequest {
  host?: string;
  mode: PortMode;
  protocolBehavior?: ProtocolBehavior;
  providerBinding?: string;
  apikey?: string;
  timeout?: number;
  bodyLimit?: string;
}

export interface PortView {
  port: number;
  host: string;
  mode: PortMode;
  protocolBehavior?: ProtocolBehavior;
  providerBinding?: string;
  status: PortStatus;
  activeConnections: number;
  error?: string;
}

export interface PortListView {
  ports: PortView[];
}

export function createDefaultRouterPort(port: number, host = '0.0.0.0'): PortConfig {
  return { port, host, mode: 'router' };
}

export function createDefaultProviderPort(
  port: number,
  providerBinding: string,
  protocolBehavior: ProtocolBehavior = 'auto',
  host = '0.0.0.0',
): PortConfig {
  return { port, host, mode: 'provider', protocolBehavior, providerBinding };
}
