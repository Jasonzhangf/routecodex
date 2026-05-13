/**
 * Port Config Validator
 *
 * 端口配置验证规则：
 * 1. Router 模式不允许设置 protocolBehavior / providerBinding
 * 2. Provider 模式必须设置 providerBinding
 * 3. Direct 模式跨协议时 fail-fast
 * 4. 端口号不重复
 * 5. 端口号范围 1024-65535
 */

import type { PortConfig, PortMode, ProtocolBehavior } from './port-config-types.js';
import type { ProviderProtocol } from './types.js';

export interface PortValidationError {
  port: number;
  field: string;
  message: string;
}

export interface PortValidationResult {
  valid: boolean;
  errors: PortValidationError[];
}

const VALID_PORT_MIN = 1024;
const VALID_PORT_MAX = 65535;
const VALID_MODES: ReadonlySet<string> = new Set(['router', 'provider']);
const VALID_BEHAVIORS: ReadonlySet<string> = new Set(['direct', 'relay', 'auto']);

function validatePortConfig(config: PortConfig): PortValidationError[] {
  const errors: PortValidationError[] = [];
  const { port, host, mode, protocolBehavior, providerBinding } = config;

  if (typeof port !== 'number' || !Number.isInteger(port) || port < VALID_PORT_MIN || port > VALID_PORT_MAX) {
    errors.push({
      port: port ?? 0,
      field: 'port',
      message: `Port must be an integer between ${VALID_PORT_MIN} and ${VALID_PORT_MAX}, got: ${port}`,
    });
  }

  if (!host || typeof host !== 'string' || !host.trim()) {
    errors.push({ port: port ?? 0, field: 'host', message: 'Host must be a non-empty string' });
  }

  if (!VALID_MODES.has(mode)) {
    errors.push({ port: port ?? 0, field: 'mode', message: `Mode must be "router" or "provider", got: "${mode}"` });
    return errors;
  }

  if (mode === 'router') {
    if (protocolBehavior !== undefined && protocolBehavior !== null) {
      errors.push({ port, field: 'protocolBehavior', message: `Router mode does not support protocolBehavior, got: "${protocolBehavior}"` });
    }
    if (providerBinding !== undefined && providerBinding !== null && providerBinding !== '') {
      errors.push({ port, field: 'providerBinding', message: `Router mode does not support providerBinding, got: "${providerBinding}"` });
    }
    return errors;
  }

  if (mode === 'provider') {
    if (!providerBinding || typeof providerBinding !== 'string' || !providerBinding.trim()) {
      errors.push({ port, field: 'providerBinding', message: 'Provider mode requires a non-empty providerBinding' });
    }
    if (protocolBehavior !== undefined && protocolBehavior !== null && !VALID_BEHAVIORS.has(protocolBehavior)) {
      errors.push({ port, field: 'protocolBehavior', message: `ProtocolBehavior must be "direct", "relay", or "auto", got: "${protocolBehavior}"` });
    }
  }

  return errors;
}

export function validatePortConfigs(configs: PortConfig[]): PortValidationResult {
  const errors: PortValidationError[] = [];
  const seenPorts = new Map<number, number>();

  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    if (seenPorts.has(config.port)) {
      errors.push({ port: config.port, field: 'port', message: `Duplicate port ${config.port} (index ${seenPorts.get(config.port)} and ${i})` });
    } else {
      seenPorts.set(config.port, i);
    }
    errors.push(...validatePortConfig(config));
  }

  return { valid: errors.length === 0, errors };
}

export function checkDirectProtocolMatch(
  inboundProtocol: ProviderProtocol,
  providerProtocol: ProviderProtocol,
): string | null {
  if (inboundProtocol !== providerProtocol) {
    return `Provider mode with protocolBehavior=direct requires matching protocols: inbound=${inboundProtocol}, provider=${providerProtocol}`;
  }
  return null;
}

export function resolveActualBehavior(
  protocolBehavior: ProtocolBehavior,
  inboundProtocol: ProviderProtocol,
  providerProtocol: ProviderProtocol,
): 'direct' | 'relay' {
  if (protocolBehavior === 'direct') return 'direct';
  if (protocolBehavior === 'relay') return 'relay';
  return inboundProtocol === providerProtocol ? 'direct' : 'relay';
}

export function normalizePortsConfig(rawHttpserver: Record<string, unknown>): PortConfig[] {
  if (Array.isArray(rawHttpserver.ports) && rawHttpserver.ports.length > 0) {
    return rawHttpserver.ports as PortConfig[];
  }
  const port =
    typeof rawHttpserver.port === 'number'
      ? rawHttpserver.port
      : typeof rawHttpserver.port === 'string'
        ? parseInt(rawHttpserver.port, 10)
        : 8080;
  const host =
    typeof rawHttpserver.host === 'string' && rawHttpserver.host.trim()
      ? rawHttpserver.host.trim()
      : '0.0.0.0';
  return [{ port, host, mode: 'router' }];
}
