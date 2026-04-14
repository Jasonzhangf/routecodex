/**
 * Shared helpers for standard tool normalization (shell packing rules).
 * The goal is deterministic, minimal shaping so executors succeed consistently.
 */
import { chunkStringWithNative, flattenByCommaWithNative, packShellArgsWithNative, repairFindMetaWithNative, splitCommandStringWithNative } from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';
function assertToolingNativeAvailable() {
    if (typeof repairFindMetaWithNative !== 'function' ||
        typeof splitCommandStringWithNative !== 'function' ||
        typeof packShellArgsWithNative !== 'function' ||
        typeof flattenByCommaWithNative !== 'function' ||
        typeof chunkStringWithNative !== 'function') {
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
export function repairFindMeta(script) {
    assertToolingNativeAvailable();
    return repairFindMetaWithNative(script ?? '');
}
export function splitCommandString(input) {
    assertToolingNativeAvailable();
    return splitCommandStringWithNative(input ?? '');
}
/**
 * Pack shell arguments per unified rules:
 * - command: string -> ["bash","-lc","<string>"]
 * - command: tokens[]
 *   - if starts with ["cd", path, ...rest]:
 *       - set workdir to path when absent
 *       - if rest empty => command=["pwd"]
 *       - else if rest has control tokens => command=["bash","-lc", join(rest)]
 *       - else command=rest (argv)
 *   - else if tokens contain control tokens => command=["bash","-lc", join(tokens)]
 *   - else command=tokens (argv)
 * - join(rest) uses single-space join without extra quoting
 */
export function packShellArgs(input) {
    assertToolingNativeAvailable();
    return packShellArgsWithNative(input);
}
export function flattenByComma(arr) {
    assertToolingNativeAvailable();
    return flattenByCommaWithNative(arr);
}
// Helper to chunk a long string into N parts (bounded)
export function chunkString(s, minParts = 3, maxParts = 12, targetChunk = 12) {
    assertToolingNativeAvailable();
    return chunkStringWithNative(s, minParts, maxParts, targetChunk);
}
//# sourceMappingURL=tooling.js.map