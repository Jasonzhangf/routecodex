import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
function resolveModuleDir() {
    try {
        const metaUrl = Function('return import.meta.url')();
        if (typeof metaUrl === 'string' && metaUrl.startsWith('file:')) {
            return path.dirname(fileURLToPath(metaUrl));
        }
    }
    catch {
        // Jest/CJS transforms may not expose import.meta.
    }
    if (typeof __dirname === 'string' && __dirname.length > 0) {
        return __dirname;
    }
    return path.resolve(process.cwd(), 'src/utils');
}
const moduleDir = resolveModuleDir();
const PROMPT_DIR = path.resolve(moduleDir, '../config/system-prompts');
const PROMPT_FILES = {
    codex: path.join(PROMPT_DIR, 'codex-cli.txt'),
    claude: path.join(PROMPT_DIR, 'claude-cli.txt')
};
const promptCache = new Map();
/**
 * Basic tool guidance (router-style)
 */
export function getBasicToolGuidance() {
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
export function getDynamicToolGuidance() {
    return getBasicToolGuidance();
}
/**
 * Check if system prompt replacement should be enabled
 */
export function shouldReplaceSystemPrompt() {
    return getRequestedPromptSource();
}
function getRequestedPromptSource() {
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
function loadPromptFromFile(source) {
    if (promptCache.has(source)) {
        const cached = promptCache.get(source) ?? null;
        return cached;
    }
    try {
        const filePath = PROMPT_FILES[source];
        const content = fs.readFileSync(filePath, 'utf8').trim();
        promptCache.set(source, content);
        return content || null;
    }
    catch {
        promptCache.set(source, null);
        return null;
    }
}
export function getCodexSystemPrompt() {
    const prompt = loadPromptFromFile('codex');
    if (!prompt) {
        return null;
    }
    const trimmed = prompt.trim();
    return trimmed.length ? trimmed : null;
}
export function getSystemPromptOverride() {
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
export function replaceSystemInOpenAIMessages(messages, systemText) {
    if (!Array.isArray(messages)) {
        return messages;
    }
    const out = [...messages];
    const idx = out.findIndex((m) => m && typeof m === 'object' && m.role === 'system');
    if (idx >= 0) {
        const m = { ...(out[idx] || {}) };
        m.content = systemText;
        out[idx] = m;
    }
    else {
        out.unshift({ role: 'system', content: systemText });
    }
    return out;
}
function mergeResponsesInstructions(existing, override) {
    const normalizedOverride = override.trim();
    const normalizedExisting = typeof existing === 'string' ? existing.trim() : '';
    if (!normalizedExisting) {
        return normalizedOverride;
    }
    if (normalizedExisting.includes(normalizedOverride)) {
        return normalizedExisting;
    }
    return `${normalizedOverride}\n\n${normalizedExisting}`;
}
export function applySystemPromptOverride(entryEndpoint, payload) {
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
            payload.instructions = mergeResponsesInstructions(payload.instructions, override.prompt);
            break;
        default:
            break;
    }
}
