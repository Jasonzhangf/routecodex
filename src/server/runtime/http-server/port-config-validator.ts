/**
 * Port Config Validator — Per-Port Authoritative Config
 *
 * Validation rules:
 * 1. Router mode: MUST have routingPolicyGroup, MUST NOT have providerBinding/protocolBehavior
 * 2. Provider mode: MUST have providerBinding + protocolBehavior, MUST NOT have routingPolicyGroup
 * 3. routingPolicyGroup must reference an existing group (checked at loader level)
 * 4. No duplicate port numbers
 * 5. Port range 1024-65535
 */

import type { PortConfig, ProtocolBehavior } from './port-config-types.js';
import type { SameProtocolBehavior } from './port-config-types.js';
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
const VALID_SAME_PROTOCOL_BEHAVIORS: ReadonlySet<string> = new Set(['direct', 'relay']);

function validateStopMessageConfig(config: PortConfig, errors: PortValidationError[]): void {
  const stopMessage = config.stopMessage;
  if (stopMessage === undefined || stopMessage === null) {
    return;
  }
  if (typeof stopMessage !== 'object' || Array.isArray(stopMessage)) {
    errors.push({ port: config.port ?? 0, field: 'stopMessage', message: 'stopMessage must be an object when provided' });
    return;
  }
  const enabled = (stopMessage as { enabled?: unknown }).enabled;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    errors.push({ port: config.port ?? 0, field: 'stopMessage.enabled', message: 'stopMessage.enabled must be boolean when provided' });
  }
}

function readStopMessageConfig(value: unknown): PortConfig['stopMessage'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const enabled = (value as { enabled?: unknown }).enabled;
  return typeof enabled === 'boolean' ? { enabled } : undefined;
}

function validatePortConfig(config: PortConfig): PortValidationError[] {
  const errors: PortValidationError[] = [];
  const { port, host, mode, protocolBehavior, providerBinding, routingPolicyGroup } = config;
  validateStopMessageConfig(config, errors);

  // Port range
  if (typeof port !== 'number' || !Number.isInteger(port) || port < VALID_PORT_MIN || port > VALID_PORT_MAX) {
    errors.push({
      port: port ?? 0,
      field: 'port',
      message: `Port must be an integer between ${VALID_PORT_MIN} and ${VALID_PORT_MAX}, got: ${port}`,
    });
  }

  // Host
  if (!host || typeof host !== 'string' || !host.trim()) {
    errors.push({ port: port ?? 0, field: 'host', message: 'Host must be a non-empty string' });
  }

  // Mode
  if (!VALID_MODES.has(mode)) {
    errors.push({ port: port ?? 0, field: 'mode', message: `Mode must be "router" or "provider", got: "${mode}"` });
    return errors;
  }

  if (mode === 'router') {
    // Router mode MUST have routingPolicyGroup
    if (!routingPolicyGroup || typeof routingPolicyGroup !== 'string' || !routingPolicyGroup.trim()) {
      errors.push({ port, field: 'routingPolicyGroup', message: 'Router mode requires a non-empty routingPolicyGroup' });
    }
    // Router mode MUST NOT have providerBinding
    if (providerBinding !== undefined && providerBinding !== null && providerBinding !== '') {
      errors.push({ port, field: 'providerBinding', message: 'Router mode does not support providerBinding' });
    }
    // Router mode MUST NOT have protocolBehavior
    if (protocolBehavior !== undefined && protocolBehavior !== null) {
      errors.push({ port, field: 'protocolBehavior', message: 'Router mode does not support protocolBehavior' });
    }
    // Router mode: sameProtocolBehavior is allowed (optional, defaults to 'direct')
    if (config.sameProtocolBehavior !== undefined && config.sameProtocolBehavior !== null) {
      if (!VALID_SAME_PROTOCOL_BEHAVIORS.has(config.sameProtocolBehavior)) {
        errors.push({
          port,
          field: 'sameProtocolBehavior',
          message: `Router mode sameProtocolBehavior must be "direct" or "relay", got: "${config.sameProtocolBehavior}"`
        });
      }
    }
    return errors;
  }

  // Provider mode
  if (mode === 'provider') {
    // MUST have providerBinding
    if (!providerBinding || typeof providerBinding !== 'string' || !providerBinding.trim()) {
      errors.push({ port, field: 'providerBinding', message: 'Provider mode requires a non-empty providerBinding' });
    }
    // MUST have protocolBehavior
    if (!protocolBehavior || !VALID_BEHAVIORS.has(protocolBehavior)) {
      errors.push({ port, field: 'protocolBehavior', message: 'Provider mode requires protocolBehavior: "direct", "relay", or "auto"' });
    }
    // Provider mode MUST NOT have routingPolicyGroup
    if (routingPolicyGroup !== undefined && routingPolicyGroup !== null && routingPolicyGroup !== '') {
      errors.push({ port, field: 'routingPolicyGroup', message: 'Provider mode does not support routingPolicyGroup' });
    }
    // Provider mode: sameProtocolBehavior is NOT allowed
    if (config.sameProtocolBehavior !== undefined && config.sameProtocolBehavior !== null) {
      errors.push({
        port,
        field: 'sameProtocolBehavior',
        message: 'Provider mode does not support sameProtocolBehavior'
      });
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
    return (rawHttpserver.ports as PortConfig[]).map((entry) => {
      const stopMessage = readStopMessageConfig((entry as unknown as Record<string, unknown>).stopMessage);
      return stopMessage ? { ...entry, stopMessage } : entry;
    });
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
  const sameProtocolBehavior = rawHttpserver.sameProtocolBehavior;
  const stopMessage = readStopMessageConfig(rawHttpserver.stopMessage);
  // Fallback to router with default group (legacy compat for old configs without ports[])
  const portConfig: PortConfig = { port, host, mode: 'router', routingPolicyGroup: 'default' };
  if (typeof sameProtocolBehavior === 'string' && VALID_SAME_PROTOCOL_BEHAVIORS.has(sameProtocolBehavior)) {
    portConfig.sameProtocolBehavior = sameProtocolBehavior as SameProtocolBehavior;
  }
  if (stopMessage) {
    portConfig.stopMessage = stopMessage;
  }
  return [portConfig];
}
