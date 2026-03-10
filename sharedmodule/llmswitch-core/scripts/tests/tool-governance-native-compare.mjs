#!/usr/bin/env node
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function moduleUrl(relPath) {
  return pathToFileURL(path.join(repoRoot, 'dist', relPath)).href;
}

function cacheBustedImport(url, tag) {
  return import(`${url}?case=${tag}_${Date.now()}_${Math.random().toString(16).slice(2)}`);
}

function stripTimestamp(summary) {
  if (!summary || typeof summary !== 'object') return summary;
  const { timestamp, ...rest } = summary;
  return rest;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeName(rawName, rules, stats, field) {
  const defaultName = rules.defaultName ?? 'tool';
  let next = typeof rawName === 'string' ? rawName : '';
  let changed = false;
  if (rules.trimWhitespace !== false) {
    next = next.trim();
  }
  if (!next) {
    next = defaultName;
    stats.defaultedNames += 1;
    changed = true;
  }
  if (rules.forceCase === 'lower') {
    const forced = next.toLowerCase();
    if (forced !== next) {
      next = forced;
      changed = true;
    }
  } else if (rules.forceCase === 'upper') {
    const forced = next.toUpperCase();
    if (forced !== next) {
      next = forced;
      changed = true;
    }
  }
  if (rules.allowedCharacters) {
    const matcher = new RegExp(rules.allowedCharacters.source);
    const filtered = next
      .split('')
      .filter((ch) => matcher.test(ch))
      .join('');
    matcher.lastIndex = 0;
    if (filtered.length === 0) {
      next = defaultName;
      stats.defaultedNames += 1;
      changed = true;
    } else if (filtered !== next) {
      next = filtered;
      changed = true;
    }
  }
  if (rules.maxNameLength && next.length > rules.maxNameLength) {
    if (rules.onViolation === 'reject') {
      const error = new Error(`Tool name exceeds max length of ${rules.maxNameLength}`);
      error.field = field;
      throw error;
    }
    next = next.slice(0, rules.maxNameLength);
    stats.truncatedNames += 1;
    changed = true;
  }
  if (changed || (typeof rawName === 'string' && rawName !== next)) {
    stats.sanitizedNames += 1;
  }
  stats.applied = true;
  return next || defaultName;
}

function sanitizeToolCall(tc, rules, stats, context) {
  if (!tc || typeof tc !== 'object') return tc;
  const fn = tc.function;
  if (!fn || typeof fn !== 'object') return tc;
  const sanitizedName = sanitizeName(fn.name, rules, stats, context);
  if (sanitizedName === fn.name) return tc;
  return { ...tc, function: { ...fn, name: sanitizedName } };
}

function sanitizeChoice(choice, rules, stats) {
  const message = choice?.message;
  if (!message || typeof message !== 'object') return;
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls = message.tool_calls.map((tc, index) =>
      sanitizeToolCall(tc, rules, stats, `choices[].message.tool_calls[${index}].function.name`)
    );
  }
  if (message.function_call && typeof message.function_call === 'object') {
    message.function_call.name = sanitizeName(
      message.function_call.name,
      rules,
      stats,
      'choices[].message.function_call.name'
    );
  }
  if (typeof message.name === 'string' || message.role === 'tool') {
    message.name = sanitizeName(message.name, rules, stats, 'choices[].message.name');
  }
}

function legacyGovernResponse(payload, rules, protocol) {
  const cloned = clone(payload);
  const stats = {
    protocol,
    direction: 'response',
    applied: false,
    sanitizedNames: 0,
    truncatedNames: 0,
    defaultedNames: 0
  };
  const choices = Array.isArray(cloned?.choices) ? cloned.choices : [];
  for (const choice of choices) {
    sanitizeChoice(choice, rules, stats);
  }
  if (Array.isArray(cloned?.tool_calls)) {
    cloned.tool_calls = cloned.tool_calls.map((tc) =>
      sanitizeToolCall(tc, rules, stats, 'choices[].message.tool_calls[].function.name')
    );
  }
  return {
    payload: cloned,
    summary: {
      protocol,
      direction: 'response',
      applied: stats.applied,
      sanitizedNames: stats.sanitizedNames,
      truncatedNames: stats.truncatedNames,
      defaultedNames: stats.defaultedNames,
      timestamp: Date.now()
    }
  };
}

async function main() {
  const nativeMod = await cacheBustedImport(
    moduleUrl('conversion/hub/tool-governance/engine.js'),
    'tool-governance-native'
  );

  const { ToolGovernanceEngine, ToolGovernanceError } = nativeMod;
  assert.equal(typeof ToolGovernanceEngine, 'function');

  const registry = {
    'openai-chat': {
      request: {
        maxNameLength: 8,
        allowedCharacters: /[a-z]/,
        defaultName: 'tool',
        trimWhitespace: true,
        onViolation: 'truncate'
      },
      response: {
        maxNameLength: 4,
        allowedCharacters: /[a-z]/,
        defaultName: 'tool',
        trimWhitespace: true,
        forceCase: 'lower',
        onViolation: 'truncate'
      }
    }
  };

  const payload = {
    choices: [
      {
        message: {
          role: 'assistant',
          tool_calls: [
            { function: { name: 'AB12$$', arguments: '{}' } },
            { function: { name: 123, arguments: '{}' } }
          ],
          function_call: { name: 'TOOL_123', arguments: '{}' },
          name: 'MiXeD'
        }
      },
      {
        message: {
          role: 'tool',
          name: '  $$  '
        }
      }
    ],
    tool_calls: [
      { function: { name: 'BAD$$$', arguments: '{}' } }
    ]
  };

  const nativeEngine = new ToolGovernanceEngine(registry);
  const nativeResp = nativeEngine.governResponse(clone(payload), 'openai-chat');
  const legacyResp = legacyGovernResponse(clone(payload), registry['openai-chat'].response, 'openai-chat');

  assert.deepEqual(nativeResp.payload, legacyResp.payload);
  assert.deepEqual(stripTimestamp(nativeResp.summary), stripTimestamp(legacyResp.summary));

  const rejectRegistry = {
    'openai-chat': {
      request: {
        maxNameLength: 8,
        allowedCharacters: /[a-z]/,
        defaultName: 'tool',
        trimWhitespace: true,
        onViolation: 'truncate'
      },
      response: {
        maxNameLength: 2,
        allowedCharacters: /[a-z]/,
        defaultName: 'tool',
        trimWhitespace: true,
        onViolation: 'reject'
      }
    }
  };

  const rejectPayload = {
    choices: [
      {
        message: {
          role: 'assistant',
          tool_calls: [
            { function: { name: 'TOO-LONG', arguments: '{}' } }
          ]
        }
      }
    ]
  };

  const nativeRejectEngine = new ToolGovernanceEngine(rejectRegistry);
  assert.throws(() => nativeRejectEngine.governResponse(clone(rejectPayload), 'openai-chat'), ToolGovernanceError);
  assert.throws(
    () => legacyGovernResponse(clone(rejectPayload), rejectRegistry['openai-chat'].response, 'openai-chat'),
    /Tool name exceeds max length/
  );

  console.log('✅ tool-governance native vs legacy parity passed');
}

main().catch((error) => {
  console.error('❌ tool-governance native vs legacy parity failed:', error);
  process.exit(1);
});
