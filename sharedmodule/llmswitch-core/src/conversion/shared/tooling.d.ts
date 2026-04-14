export interface ShellArgs {
    command: string | string[];
    workdir?: string;
    timeout_ms?: number;
}
/**
 * Minimal, idempotent repairs for common `find` invocations inside shell scripts:
 * - ensure `-exec … ;` is escaped as `-exec … \;`
 * - collapse multiple backslashes before `;` into a single backslash
 * - escape bare parentheses used in predicates: `(` / `)` → `\(` / `\)`
 */
export declare function repairFindMeta(script: string): string;
export declare function splitCommandString(input: string): string[];
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
export declare function packShellArgs(input: Record<string, unknown>): Record<string, unknown>;
export declare function flattenByComma(arr: string[]): string[];
export declare function chunkString(s: string, minParts?: number, maxParts?: number, targetChunk?: number): string[];
