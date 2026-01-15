#!/usr/bin/env node

/**
 * Quota dry-run helper:
 * 从简单的 JSON 事件数组读取错误/成功/usage 事件，驱动 provider-quota-center，
 * 并将结果写入 ~/.routecodex/quota/provider-quota.json，方便人工检查。
 *
 * 用法:
 *   node scripts/quota-dryrun.mjs path/to/events.json
 *
 * 事件格式示例:
 * [
 *   { "type": "error", "providerKey": "antigravity.alias1.gemini-3-pro-high", "httpStatus": 429 },
 *   { "type": "success", "providerKey": "antigravity.alias1.gemini-3-pro-high", "usedTokens": 120 },
 *   { "type": "usage", "providerKey": "antigravity.alias1.gemini-3-pro-high", "requestedTokens": 80 }
 * ]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  applyErrorEvent,
  applySuccessEvent,
  applyUsageEvent,
  createInitialQuotaState
} from '../src/manager/quota/provider-quota-center.js';
import {
  saveProviderQuotaSnapshot
} from '../src/manager/quota/provider-quota-store.js';

async function main() {
  const fileArg = process.argv[2];
  if (!fileArg) {
    // eslint-disable-next-line no-console
    console.error('Usage: node scripts/quota-dryrun.mjs path/to/events.json');
    process.exitCode = 1;
    return;
  }
  const filePath = path.resolve(process.cwd(), fileArg);
  const raw = await fs.readFile(filePath, 'utf8');
  const events = JSON.parse(raw);
  if (!Array.isArray(events)) {
    throw new Error('events file must contain a JSON array');
  }

  const states = new Map();
  const nowMs = Date.now();

  for (const entry of events) {
    if (!entry || typeof entry !== 'object') {
      // eslint-disable-next-line no-console
      console.warn('[quota-dryrun] skip non-object event', entry);
      continue;
    }
    const record = entry;
    const providerKey = typeof record.providerKey === 'string' ? record.providerKey.trim() : '';
    if (!providerKey) {
      // eslint-disable-next-line no-console
      console.warn('[quota-dryrun] event missing providerKey', record);
      continue;
    }
    const type = typeof record.type === 'string' ? record.type.trim().toLowerCase() : '';
    if (!type) {
      // eslint-disable-next-line no-console
      console.warn('[quota-dryrun] event missing type', record);
      continue;
    }
    const existing = states.get(providerKey) as any | undefined;
    const baseState =
      existing ??
      createInitialQuotaState(providerKey, undefined, nowMs);
    let nextState = baseState;

    if (type === 'error') {
      nextState = applyErrorEvent(
        baseState,
        {
          providerKey,
          code: record.code,
          httpStatus: record.httpStatus,
          fatal: record.fatal === true
        },
        nowMs
      );
    } else if (type === 'success') {
      nextState = applySuccessEvent(
        baseState,
        {
          providerKey,
          usedTokens: record.usedTokens
        },
        nowMs
      );
    } else if (type === 'usage') {
      nextState = applyUsageEvent(
        baseState,
        {
          providerKey,
          requestedTokens: record.requestedTokens
        },
        nowMs
      );
    } else {
      // eslint-disable-next-line no-console
      console.warn('[quota-dryrun] unknown event type', type);
      continue;
    }
    states.set(providerKey, nextState);
  }

  const snapshot = Object.fromEntries(states.entries());
  await saveProviderQuotaSnapshot(snapshot, new Date());
  // eslint-disable-next-line no-console
  console.log(
    `[quota-dryrun] wrote snapshot for ${states.size} provider(s) to ~/.routecodex/quota/provider-quota.json`
  );
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[quota-dryrun] failed:', error);
  process.exitCode = 1;
});

