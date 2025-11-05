export type Source = 'codex' | 'claude';

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
  // Only enable when explicitly opted-in via ROUTECODEX_SYSTEM_PROMPT_ENABLE=1
  const enabled = String(process.env.ROUTECODEX_SYSTEM_PROMPT_ENABLE || '0') === '1';
  if (!enabled) return null;
  const sel = (process.env.ROUTECODEX_SYSTEM_PROMPT_SOURCE || '').toLowerCase();
  if (sel === 'codex') {return 'codex';}
  if (sel === 'claude') {return 'claude';}
  return null;
}

/**
 * Replace or append system message in OpenAI messages
 */
export function replaceSystemInOpenAIMessages(messages: unknown[], systemText: string): unknown[] {
  if (!Array.isArray(messages)) {return messages;}
  const out = [...messages];

  const idx = out.findIndex((m) => m && typeof m === 'object' && (m as Record<string, unknown>).role === 'system');
  if (idx >= 0) {
    const m = { ...(out[idx] || {}) };
    const existingContent = (m as Record<string, unknown>).content as string || '';

    // Append tool guidance to existing system content
    (m as Record<string, unknown>).content = existingContent + '\n\n' + systemText;

    out[idx] = m;
  } else {
    out.unshift({ role: 'system', content: systemText });
  }
  return out;
}
