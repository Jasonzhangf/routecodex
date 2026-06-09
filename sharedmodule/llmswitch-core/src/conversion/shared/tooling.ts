/**
 * Shared helpers for standard tool normalization (shell packing rules).
 * The goal is deterministic, minimal shaping so executors succeed consistently.
 */
import {
  repairFindMetaWithNative,
} from '../../native/router-hotpath/native-shared-conversion-semantics.js';

function assertToolingNativeAvailable(): void {
  if (typeof repairFindMetaWithNative !== 'function') {
    throw new Error('[tooling] native bindings unavailable');
  }
}

// We intentionally do NOT evaluate shell control operators (&&, |, etc.).
// Codex CLI executor runs argv directly (execvp-like), not through a shell.
// So we avoid wrapping with "bash -lc" and leave such tokens as-is.

/**
 * Minimal, idempotent repairs for common `find` invocations inside shell scripts:
 * - ensure `-exec … ;` is escaped as `-exec … \;`
 * - collapse multiple backslashes before `;` into a single backslash
 * - escape bare parentheses used in predicates: `(` / `)` → `\(` / `\)`
 */
export function repairFindMeta(script: string): string {
  assertToolingNativeAvailable();
  return repairFindMetaWithNative(script ?? '');
}
