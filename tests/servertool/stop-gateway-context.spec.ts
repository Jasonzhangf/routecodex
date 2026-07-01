import * as fs from 'node:fs';
import { describe, expect, test } from '@jest/globals';

import {
  attachStopGatewayContext,
  inspectStopGatewaySignal
} from '../../sharedmodule/llmswitch-core/src/servertool/metadata-center-carrier.js';

const METADATA_CENTER_SYMBOL = Symbol.for('routecodex.metadataCenter');

function bindRuntimeControlTarget(initialRuntimeControl: Record<string, unknown> = {}): {
  target: Record<string, unknown>;
  runtimeControl: Record<string, unknown>;
} {
  const runtimeControl: Record<string, unknown> = { ...initialRuntimeControl };
  const target: Record<string, unknown> = {};
  Reflect.set(target, METADATA_CENTER_SYMBOL, {
    readRuntimeControl: () => runtimeControl,
    writeRuntimeControl: (key: string, value: unknown) => {
      runtimeControl[key] = value;
    }
  });
  return { target, runtimeControl };
}

describe('servertool stop-gateway context', () => {
  test('metadata carrier does not export bound request-truth session helper', () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/metadata-center-carrier.ts',
      'utf8'
    );

    expect(source).not.toContain('export function readRequestTruthSessionIdFromBoundMetadataCenter(');
    expect(source).toContain('function readRequestTruthSessionIdFromBoundMetadataCenter(');
    expect(source).not.toContain('export function readRequestTruthSessionIdFromAnyBoundMetadataCenter(');
    expect(source).toContain('function readRequestTruthSessionIdFromAnyBoundMetadataCenter(');
    expect(source).not.toContain('export function readRequestTruthFromAnyBoundMetadataCenter(');
    expect(source).not.toContain('export function readProviderObservationFromAnyBoundMetadataCenter(');
    expect(source).toContain('function readRequestTruthFromAnyBoundMetadataCenter(');
    expect(source).toContain('function readProviderObservationFromAnyBoundMetadataCenter(');
    expect(source).not.toContain('export function readRuntimeControlFromBoundMetadataCenter(');
    expect(source).toContain('function readRuntimeControlFromBoundMetadataCenter(');
    expect(source).not.toContain("return value && typeof value === 'object'");
    expect(source).toContain("return value != null && typeof value === 'object'");
    expect(source).not.toContain("runtimeControl && typeof runtimeControl === 'object'");
    expect(source).toContain("runtimeControl != null && typeof runtimeControl === 'object'");
    expect(source).not.toContain("requestTruth && typeof requestTruth === 'object'");
    expect(source).toContain("requestTruth != null && typeof requestTruth === 'object'");
    expect(source).not.toContain("providerObservation && typeof providerObservation === 'object'");
    expect(source).toContain("providerObservation != null && typeof providerObservation === 'object'");
  });

  test('metadata carrier does not export stop eligibility facade helpers', () => {
    const source = fs.readFileSync(
      'sharedmodule/llmswitch-core/src/servertool/metadata-center-carrier.ts',
      'utf8'
    );

    expect(source).not.toContain('export function resolveStopGatewayContext(');
    expect(source).not.toContain('export function isStopEligibleForServerTool(');
    expect(source).not.toContain('export function readStopGatewayContext(');
    expect(source).not.toContain('normalizeStopGatewayContextWithNative');
  });

  test('uses native inspect and preserves the last finish_reason choice index', () => {
    const context = inspectStopGatewaySignal({
      choices: [
        {
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'old' }
        },
        {
          finish_reason: 'length',
          message: { role: 'assistant', content: 'latest' }
        }
      ]
    });

    expect(context).toEqual({
      observed: true,
      eligible: false,
      source: 'chat',
      reason: 'finish_reason_length',
      choiceIndex: 1,
      hasToolCalls: false
    });
  });

  test('native inspect detects spaced uppercase embedded tool marker', () => {
    const context = inspectStopGatewaySignal({
      choices: [{
        finish_reason: 'stop',
        message: { role: 'assistant', content: '<|  TOOL_CALL_BEGIN  |>test' }
      }]
    });

    expect(context.eligible).toBe(false);
    expect(context.reason).toBe('finish_reason_stop_with_embedded_tool_markers');
  });

  test('attach writes explicit metadata-center runtime control context', () => {
    const { target, runtimeControl } = bindRuntimeControlTarget();
    attachStopGatewayContext(target as any, {
      observed: true,
      eligible: true,
      source: 'chat',
      reason: 'finish_reason_stop',
      choiceIndex: 0,
      hasToolCalls: false
    });

    expect(target.__rt).toBeUndefined();
    expect(runtimeControl.stopGatewayContext).toEqual({
      observed: true,
      eligible: true,
      source: 'chat',
      reason: 'finish_reason_stop',
      choiceIndex: 0,
      hasToolCalls: false
    });
  });
});
