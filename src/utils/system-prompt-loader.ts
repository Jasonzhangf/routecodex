import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Source = 'codex' | 'claude';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPT_DIR = path.resolve(__dirname, '../config/system-prompts');
const PROMPT_FILES: Record<Source, string> = {
  codex: path.join(PROMPT_DIR, 'codex-cli.txt'),
  claude: path.join(PROMPT_DIR, 'claude-cli.txt')
};

const promptCache = new Map<Source, string | null>();

type ClaudeSystemEntry = { type: string; text: string };

type PromptAwarePayload = Record<string, unknown> & {
  messages?: unknown[];
  system?: ClaudeSystemEntry[];
  instructions?: string;
};

/**
 * Basic tool guidance (router-style)
 */
export function getBasicToolGuidance(): string {
  return [
    '<system-reminder>Tool mode is active. You are expected to proactively execute the most suitable tool to help complete the task.',
    '',
    '## Shell Commands Format',
    '- Prefer a single string for the entire command; meta operators (|, >, &&, ||) must appear inside that string.',
    '- If you need argv tokens, avoid placing meta operators as separate array elements. For complex commands, use a single string; the runtime will wrap with bash -lc as needed.',
    '- Always use proper JSON formatting for tool arguments',
    '',
    '## File Operations Priority',
    '- Use Read tool for reading files (preferred over shell commands)',
    '- Use Write tool for creating new files',
    '- Use Edit tool for modifying existing files',
    '- Only use shell commands for file operations when dedicated tools are not available',
    '',
    '## Execution Guidelines',
    '- Evaluate tool applicability before invocation',
    '- Use tools efficiently and appropriately',
    '- Provide clear context and purpose for tool usage',
    '- Handle errors gracefully and provide meaningful feedback</system-reminder>'
  ].join('\n');
}

/**
 * Get tool guidance (simplified router-style)
 */
export function getDynamicToolGuidance(): string {
  return getBasicToolGuidance();
}

/**
 * Check if system prompt replacement should be enabled
 */
export function shouldReplaceSystemPrompt(): Source | null {
  return getRequestedPromptSource();
}

function getRequestedPromptSource(): Source | null {
  // Only enable when explicitly opted-in via ROUTECODEX_SYSTEM_PROMPT_ENABLE=1
  const enabled = String(process.env.ROUTECODEX_SYSTEM_PROMPT_ENABLE || '0') === '1';
  if (!enabled) {
    return null;
  }
  const sel = (process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE || '').toLowerCase();
  if (sel === 'codex') {
    return 'codex';
  }
  if (sel === 'claude') {
    return 'claude';
  }
  return null;
}

function loadPromptFromFile(source: Source): string | null {
  if (promptCache.has(source)) {
    const cached = promptCache.get(source) ?? null;
    return cached;
  }
  try {
    const filePath = PROMPT_FILES[source];
    const content = fs.readFileSync(filePath, 'utf8').trim();
    promptCache.set(source, content);
    return content || null;
  } catch {
    promptCache.set(source, null);
    return null;
  }
}

export function getCodexSystemPrompt(): string | null {
  const prompt = loadPromptFromFile('codex');
  if (!prompt) {
    return null;
  }
  const trimmed = prompt.trim();
  return trimmed.length ? trimmed : null;
}

export function getSystemPromptOverride(): { source: Source; prompt: string } | null {
  const source = getRequestedPromptSource();
  if (!source) {
    return null;
  }
  const prompt = loadPromptFromFile(source);
  if (!prompt) {
    return null;
  }
  return { source, prompt };
}

/**
 * Replace or append system message in OpenAI messages
 */
export function replaceSystemInOpenAIMessages(messages: unknown[], systemText: string): unknown[] {
  if (!Array.isArray(messages)) {
    return messages;
  }
  const out = [...messages];

  const idx = out.findIndex((m) => m && typeof m === 'object' && (m as Record<string, unknown>).role === 'system');
  if (idx >= 0) {
    const m = { ...(out[idx] || {}) };
    (m as Record<string, unknown>).content = systemText;
    out[idx] = m;
  } else {
    out.unshift({ role: 'system', content: systemText });
  }
  return out;
}

export function applySystemPromptOverride(entryEndpoint: string, payload: PromptAwarePayload | null | undefined): void {
  const override = getSystemPromptOverride();
  if (!override || !payload || typeof payload !== 'object') {
    return;
  }
  switch (entryEndpoint) {
    case '/v1/chat/completions':
      if (Array.isArray(payload.messages)) {
        payload.messages = replaceSystemInOpenAIMessages(payload.messages, override.prompt);
      }
      break;
    case '/v1/messages':
      payload.system = [
        { type: 'text', text: override.prompt }
      ];
      break;
    case '/v1/responses':
      payload.instructions = override.prompt;
      break;
    default:
      break;
  }
}
