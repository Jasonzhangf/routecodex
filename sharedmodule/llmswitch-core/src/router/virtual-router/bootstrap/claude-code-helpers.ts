/**
 * Claude Code specific helpers for Virtual Router bootstrap.
 */

export const CLAUDE_CODE_DEFAULT_USER_AGENT = 'claude-cli/2.0.76 (external, cli)';
export const CLAUDE_CODE_DEFAULT_X_APP = 'claude-cli';
export const CLAUDE_CODE_DEFAULT_ANTHROPIC_BETA = 'claude-code';

/**
 * Parse the Claude Code app version from a user agent string.
 * Returns the version string (e.g., "2.0.76") or null if not found.
 */
export function parseClaudeCodeAppVersionFromUserAgent(userAgent: string): string | null {
  const ua = typeof userAgent === 'string' ? userAgent.trim() : '';
  if (!ua) return null;

  // Example: 'claude-cli/2.0.76 (external, cli)'
  const match = /claude-cli\/([\d.]+)/.exec(ua);
  return match?.[1] ?? null;
}
