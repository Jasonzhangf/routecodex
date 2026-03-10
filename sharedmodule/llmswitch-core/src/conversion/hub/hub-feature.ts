import { normalizeProviderProtocolTokenWithNative } from '../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

const DISABLE_FLAG = (process.env.ROUTECODEX_HUB_ENABLED || process.env.ROUTECODEX_ENABLE_HUB) ?? '1';
const PROTOCOL_LIST = process.env.ROUTECODEX_HUB_PROTOCOLS;

function parseProtocolList(input?: string): Set<string> | null {
  if (!input) return null;
  const entries = input
    .split(',')
    .map((token) => normalizeProviderProtocolTokenWithNative(token) ?? token.trim().toLowerCase())
    .filter(Boolean);
  if (!entries.length) {
    return null;
  }
  return new Set(entries);
}

const normalizedList = parseProtocolList(PROTOCOL_LIST);

export function isHubProtocolEnabled(protocol: string): boolean {
  if (DISABLE_FLAG.trim() === '0' || DISABLE_FLAG.trim().toLowerCase() === 'false') {
    return false;
  }
  if (!normalizedList) {
    return true;
  }
  const normalizedProtocol = normalizeProviderProtocolTokenWithNative(protocol) ?? protocol.trim().toLowerCase();
  return normalizedList.has(normalizedProtocol);
}
