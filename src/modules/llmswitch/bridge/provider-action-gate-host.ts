import { getRouterHotpathJsonBindingSync } from './native-exports.js';

export type ProviderActionGatePoll = {
  state: 'wait' | 'admitted' | 'released_by_success';
  generation: number;
  mode: 'idle' | 'isolated' | 'sustained';
  waitMs: number;
};

export type ProviderActionFailureRecorded = {
  generation: number;
  mode: 'isolated' | 'sustained';
  minimumDelayMs: number;
};

export type ProviderActionGateContract = {
  isolatedDelayMs: number;
  sustainedDelayMs: number;
  singleAdmissionPerGeneration: true;
  explicitAdmissionOwnership: true;
  wallClockExpiryForbidden: true;
  waiterOrder: 'fifo_ticket';
  abandonIsHealthNeutral: true;
};

function requiredBinding<K extends keyof ReturnType<typeof getRouterHotpathJsonBindingSync>>(
  name: K
): NonNullable<ReturnType<typeof getRouterHotpathJsonBindingSync>[K]> {
  const binding = getRouterHotpathJsonBindingSync()[name];
  if (typeof binding !== 'function') {
    throw new Error(`[provider-action-gate-host] native ${String(name)} not available`);
  }
  return binding as NonNullable<ReturnType<typeof getRouterHotpathJsonBindingSync>[K]>;
}

function parseObject<T>(label: string, raw: string): T {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`[provider-action-gate-host] ${label} returned invalid result`);
  }
  return parsed as T;
}

export function recordProviderActionFailureNative(
  laneKey: string,
  laneGroupKey?: string,
  actionScopeKey?: string
): ProviderActionFailureRecorded {
  const fn = requiredBinding('recordProviderActionFailureJson') as (inputJson: string) => string;
  return parseObject(
    'recordProviderActionFailureJson',
    fn(JSON.stringify({
      laneKey,
      ...(laneGroupKey ? { laneGroupKey } : {}),
      ...(actionScopeKey ? { actionScopeKey } : {})
    }))
  );
}

export function readProviderActionGateContractNative(): ProviderActionGateContract {
  const fn = requiredBinding('providerActionGateContractJson') as () => string;
  return parseObject('providerActionGateContractJson', fn());
}

export function beginProviderActionWaitNative(
  laneKey: string,
  waiterId: string,
  actionScopeKey: string
): ProviderActionGatePoll {
  const fn = requiredBinding('beginProviderActionWaitJson') as (inputJson: string) => string;
  return parseObject(
    'beginProviderActionWaitJson',
    fn(JSON.stringify({ laneKey, waiterId, actionScopeKey }))
  );
}

export function pollProviderActionAdmissionNative(
  laneKey: string,
  waiterId: string,
  actionScopeKey: string
): ProviderActionGatePoll {
  const fn = requiredBinding('pollProviderActionAdmissionJson') as (inputJson: string) => string;
  return parseObject(
    'pollProviderActionAdmissionJson',
    fn(JSON.stringify({ laneKey, waiterId, actionScopeKey }))
  );
}

export function commitProviderActionTerminalNative(
  laneKey: string,
  generation: number,
  actionScopeKey: string
): boolean {
  const fn = requiredBinding('commitProviderActionTerminalJson') as (inputJson: string) => string;
  const result = parseObject<{ committed: boolean }>(
    'commitProviderActionTerminalJson',
    fn(JSON.stringify({ laneKey, generation, actionScopeKey }))
  );
  return result.committed === true;
}

export function abandonProviderActionAdmissionNative(
  laneKey: string,
  generation: number,
  actionScopeKey: string
): boolean {
  const fn = requiredBinding('abandonProviderActionAdmissionJson') as (inputJson: string) => string;
  const result = parseObject<{ abandoned: boolean }>(
    'abandonProviderActionAdmissionJson',
    fn(JSON.stringify({ laneKey, generation, actionScopeKey }))
  );
  return result.abandoned === true;
}

export function recordProviderActionSuccessNative(
  laneGroupKey: string,
  actionScopeKey: string
): { accepted: boolean; removedLanes: number } {
  const fn = requiredBinding('recordProviderActionSuccessJson') as (inputJson: string) => string;
  return parseObject(
    'recordProviderActionSuccessJson',
    fn(JSON.stringify({ laneGroupKey, actionScopeKey }))
  );
}

export function cancelProviderActionWaitNative(
  laneKey: string,
  waiterId: string,
  actionScopeKey: string
): void {
  const fn = requiredBinding('cancelProviderActionWaitJson') as (inputJson: string) => string;
  fn(JSON.stringify({ laneKey, waiterId, actionScopeKey }));
}

export function peekProviderActionWaitNative(laneKey: string): number {
  const fn = requiredBinding('peekProviderActionWaitJson') as (inputJson: string) => number;
  return fn(JSON.stringify({ laneKey }));
}

export function resetProviderActionGateNative(args: {
  laneKey?: string;
  lanePrefix?: string;
  laneGroupKey?: string;
}): number {
  const fn = requiredBinding('resetProviderActionGateJson') as (inputJson: string) => number;
  return fn(JSON.stringify(args));
}
