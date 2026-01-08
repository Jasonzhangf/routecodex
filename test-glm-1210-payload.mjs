/**
 * GLM 1210 payload debugger
 *
 * 使用 snapshot + 本地 glm 配置，构造不同变体的请求体，帮助排查
 * 哪些字段 / 历史消息组合会触发 HTTP 400 / code=1210。
 *
 * 默认只打印 payload 摘要，不实际请求上游。
 * 如需真实调用，请显式传入 `--send`。
 *
 * 用法示例：
 *   node test-glm-1210-payload.mjs baseline
 *   node test-glm-1210-payload.mjs dropLastTools --send
 *   node test-glm-1210-payload.mjs minimalHistory --send
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODES = new Set([
  'baseline',
  'dropLastTools',
  'minimalHistory',
  'noTools',
  'noThinking',
  'bisectHistory',
  'dropInlineImagesHistory'
]);

function readJson(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(text);
}

function resolveSnapshotPath() {
  const home = os.homedir();
  return path.join(
    home,
    '.routecodex',
    'codex-samples',
    'anthropic-messages',
    'anthropic-messages-glm.key1.glm-4.7-glm-4.7-20260104T233128647-018_provider-request.json'
  );
}

function resolveGlmConfigPath() {
  const home = os.homedir();
  return path.join(home, '.routecodex', 'provider', 'glm', 'config.v1.json');
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function findFirstSystemAndLastUser(messages) {
  let firstSystemIdx = -1;
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m && m.role === 'system') {
      firstSystemIdx = i;
      break;
    }
  }
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  return { firstSystemIdx, lastUserIdx };
}

function buildVariantBody(baseBody, mode) {
  const body = clone(baseBody);

  if (!Array.isArray(body.messages)) {
    return body;
  }

  if (mode === 'baseline') {
    return body;
  }

  if (mode === 'dropLastTools') {
    if (body.messages.length >= 2) {
      body.messages = body.messages.slice(0, body.messages.length - 2);
    }
    return body;
  }

  if (mode === 'minimalHistory') {
    const messages = body.messages;
    const firstSystem = messages.find((m) => m && m.role === 'system');
    let lastUser = null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m && m.role === 'user') {
        lastUser = m;
        break;
      }
    }
    const next = [];
    if (firstSystem) {
      next.push(firstSystem);
    }
    if (lastUser) {
      next.push(lastUser);
    }
    body.messages = next;
    return body;
  }

  if (mode === 'noTools') {
    delete body.tools;
    delete body.tool_choice;
    return body;
  }

  if (mode === 'noThinking') {
    delete body.thinking;
    return body;
  }

  return body;
}

function summarizeBody(body, label) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const summary = {
    label,
    model: body.model,
    messageCount: messages.length,
    hasTools: Array.isArray(body.tools) && body.tools.length > 0,
    toolChoice: body.tool_choice,
    hasThinking: Boolean(body.thinking),
    maxTokens: body.max_tokens
  };
  const lastTwo = messages.slice(-2);
  return { summary, lastTwo };
}

async function sendToGlm(baseUrl, apiKey, payload) {
  const url = payload.__url || `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const { __url, ...body } = payload;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // leave as raw text
  }
  return { status: res.status, body: parsed ?? text };
}

async function runHistoryBisect({
  baseBody,
  urlFromSnapshot,
  baseUrl,
  apiKey
}) {
  const messages = Array.isArray(baseBody.messages) ? baseBody.messages : [];
  if (!messages.length) {
    console.error('[glm-1210][bisect] no messages in baseBody');
    process.exit(1);
  }

  const { firstSystemIdx, lastUserIdx } = findFirstSystemAndLastUser(messages);
  if (lastUserIdx === -1) {
    console.error('[glm-1210][bisect] last user message not found');
    process.exit(1);
  }

  const historyIndices = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (i === firstSystemIdx || i === lastUserIdx) continue;
    // 仅在最后一条 user 之前的消息视作“历史”，理论上 lastUserIdx 应该是最后一条。
    if (i > lastUserIdx) continue;
    historyIndices.push(i);
  }

  if (!historyIndices.length) {
    console.error('[glm-1210][bisect] no history messages to bisect');
    process.exit(1);
  }

  console.log(
    `[glm-1210][bisect] messages=${messages.length}, historyCount=${historyIndices.length}, firstSystemIdx=${firstSystemIdx}, lastUserIdx=${lastUserIdx}`
  );

  function buildBodyWithHistoryPrefix(prefixIndex) {
    const body = clone(baseBody);
    const nextMessages = [];
    if (firstSystemIdx !== -1) {
      nextMessages.push(messages[firstSystemIdx]);
    }
    if (prefixIndex >= 0) {
      const idxList = historyIndices.slice(0, prefixIndex + 1);
      for (const idx of idxList) {
        nextMessages.push(messages[idx]);
      }
    }
    nextMessages.push(messages[lastUserIdx]);
    body.messages = nextMessages;
    return body;
  }

  async function testPrefix(prefixIndex) {
    const body = buildBodyWithHistoryPrefix(prefixIndex);
    const payload = { ...body, __url: urlFromSnapshot || undefined };
    const result = await sendToGlm(baseUrl, apiKey, payload);
    const isErrorObject =
      result &&
      typeof result.body === 'object' &&
      result.body !== null &&
      'error' in result.body;
    const code = isErrorObject
      ? (result.body.error && result.body.error.code) || null
      : null;
    const status = result.status;
    const messageCount = Array.isArray(body.messages)
      ? body.messages.length
      : 0;

    console.log(
      `[glm-1210][bisect] test prefixIndex=${prefixIndex} ` +
        `(historyIncluded=${prefixIndex >= 0 ? prefixIndex + 1 : 0}, ` +
        `messageCount=${messageCount}) -> status=${status}, code=${code}`
    );

    const isFail = status === 400 && code === '1210';
    return { isFail, status, code };
  }

  // 预检：无历史（只保留 system + last user）应为 200。
  const baseCheck = await testPrefix(-1);
  if (baseCheck.isFail) {
    console.error(
      '[glm-1210][bisect] base case (no history) still fails, cannot bisect.'
    );
    process.exit(1);
  }

  // 预检：完整历史应为 400 / 1210。
  const fullIndex = historyIndices.length - 1;
  const fullCheck = await testPrefix(fullIndex);
  if (!fullCheck.isFail) {
    console.error(
      '[glm-1210][bisect] full history no longer fails with 1210, snapshot not reproducible.'
    );
    process.exit(1);
  }

  let low = -1; // last known passing prefixIndex
  let high = fullIndex; // first known failing prefixIndex

  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    const result = await testPrefix(mid);
    if (result.isFail) {
      high = mid;
    } else {
      low = mid;
    }
  }

  console.log(
    `[glm-1210][bisect] finished: first failing history prefixIndex=${high}`
  );

  const pivotHistoryIdx = high;
  const pivotGlobalIdx = historyIndices[pivotHistoryIdx];
  const pivotMsg = messages[pivotGlobalIdx];

  let contentSnippet = '';
  if (pivotMsg && typeof pivotMsg.content === 'string') {
    const raw = pivotMsg.content;
    contentSnippet = raw.length > 200 ? `${raw.slice(0, 200)}...` : raw;
  } else if (pivotMsg && Array.isArray(pivotMsg.content)) {
    contentSnippet = `[array content, length=${pivotMsg.content.length}]`;
  } else if (pivotMsg && pivotMsg.content === null) {
    contentSnippet = '[null content]';
  } else {
    contentSnippet = `[type=${typeof (pivotMsg && pivotMsg.content)}]`;
  }

  console.log(
    '[glm-1210][bisect] pivot message:',
    JSON.stringify(
      {
        pivotHistoryIdx,
        pivotGlobalIdx,
        role: pivotMsg && pivotMsg.role,
        name: pivotMsg && pivotMsg.name,
        hasToolCalls: !!(pivotMsg && pivotMsg.tool_calls),
        contentSnippet
      },
      null,
      2
    )
  );
}

async function main() {
  const [, , modeArg, ...rest] = process.argv;
  const mode = modeArg && MODES.has(modeArg) ? modeArg : 'baseline';
  const send = rest.includes('--send');

  const snapshotPath = resolveSnapshotPath();
  const glmConfigPath = resolveGlmConfigPath();

  if (!fs.existsSync(snapshotPath)) {
    console.error('[glm-1210] snapshot not found:', snapshotPath);
    process.exit(1);
  }
  if (!fs.existsSync(glmConfigPath)) {
    console.error('[glm-1210] glm config not found:', glmConfigPath);
    process.exit(1);
  }

  const snapshot = readJson(snapshotPath);
  const glmConfig = readJson(glmConfigPath);

  const baseBody = snapshot.body;
  const urlFromSnapshot = snapshot.url;
  const providerNode =
    glmConfig?.virtualrouter?.providers?.glm ??
    glmConfig?.providers?.glm ??
    null;
  if (!providerNode) {
    console.error('[glm-1210] glm provider config not found in glm config file');
    process.exit(1);
  }
  const baseUrl =
    (providerNode.baseURL && String(providerNode.baseURL)) ||
    (providerNode.endpoint && String(providerNode.endpoint)) ||
    'https://open.bigmodel.cn/api/coding/paas/v4';
  const apiKey =
    (providerNode.auth && providerNode.auth.apiKey) ||
    process.env.GLM_API_KEY ||
    '';
  if (!apiKey) {
    console.error(
      '[glm-1210] API key not found. Please set it in glm config or GLM_API_KEY env var.'
    );
    process.exit(1);
  }

  if (mode === 'bisectHistory') {
    if (!send) {
      console.error(
        '[glm-1210][bisect] --send is required to run history bisection.'
      );
      process.exit(1);
    }
    await runHistoryBisect({
      baseBody,
      urlFromSnapshot,
      baseUrl,
      apiKey
    });
    return;
  }

  if (mode === 'dropInlineImagesHistory') {
    const messages = Array.isArray(baseBody.messages) ? baseBody.messages : [];
    if (!messages.length) {
      console.error('[glm-1210][dropInlineImagesHistory] no messages');
      process.exit(1);
    }
    const { lastUserIdx } = findFirstSystemAndLastUser(messages);
    const nextMessages = [];
    for (let i = 0; i < messages.length; i += 1) {
      const msg = messages[i];
      if (!msg || typeof msg !== 'object') {
        nextMessages.push(msg);
        continue;
      }
      if (i >= 0 && i < lastUserIdx && msg.role === 'user' && Array.isArray(msg.content)) {
        const newContent = [];
        for (const part of msg.content) {
          if (!part || typeof part !== 'object') {
            newContent.push(part);
            continue;
          }
          const t = typeof part.type === 'string' ? part.type.toLowerCase() : '';
          if (t === 'image' || t === 'image_url' || t === 'input_image') {
            const imageUrlBlock =
              part.image_url && typeof part.image_url === 'object'
                ? part.image_url
                : part;
            const urlValue =
              typeof imageUrlBlock.url === 'string'
                ? imageUrlBlock.url
                : typeof imageUrlBlock.data === 'string'
                  ? imageUrlBlock.data
                  : '';
            const url = urlValue.trim();
            if (url.startsWith('data:image')) {
              // drop this inline image part from history
              // eslint-disable-next-line no-continue
              continue;
            }
          }
          newContent.push(part);
        }
        if (newContent.length === 0) {
          // drop this history message entirely
          continue;
        }
        nextMessages.push({ ...msg, content: newContent });
      } else {
        nextMessages.push(msg);
      }
    }

    const variantBody = { ...baseBody, messages: nextMessages };
    const { summary, lastTwo } = summarizeBody(variantBody, mode);
    console.log('[glm-1210] mode summary:', JSON.stringify(summary, null, 2));
    console.log('[glm-1210] last two messages:', JSON.stringify(lastTwo, null, 2));

    if (!send) {
      console.log(
        '\n[glm-1210] Dry run only. Pass --send to actually call GLM with this payload.'
      );
      return;
    }

    const payload = {
      ...variantBody,
      __url: urlFromSnapshot || undefined
    };

    console.log('[glm-1210] Sending request to GLM...');
    const result = await sendToGlm(baseUrl, apiKey, payload);
    console.log('[glm-1210] Response status:', result.status);
    console.log(
      '[glm-1210] Response body:',
      typeof result.body === 'string'
        ? result.body
        : JSON.stringify(result.body, null, 2)
    );
    return;
  }

  const variantBody = buildVariantBody(baseBody, mode);
  const { summary, lastTwo } = summarizeBody(variantBody, mode);

  console.log('[glm-1210] mode summary:', JSON.stringify(summary, null, 2));
  console.log('[glm-1210] last two messages:', JSON.stringify(lastTwo, null, 2));

  if (!send) {
    console.log(
      '\n[glm-1210] Dry run only. Pass --send to actually call GLM with this payload.'
    );
    return;
  }

  const payload = {
    ...variantBody,
    __url: urlFromSnapshot || undefined
  };

  console.log('[glm-1210] Sending request to GLM...');
  const result = await sendToGlm(baseUrl, apiKey, payload);
  console.log('[glm-1210] Response status:', result.status);
  console.log(
    '[glm-1210] Response body:',
    typeof result.body === 'string'
      ? result.body
      : JSON.stringify(result.body, null, 2)
  );
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main().catch((error) => {
  console.error('[glm-1210] failed:', error);
  process.exit(1);
});
