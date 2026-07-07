/**
 * Shared common utilities — single source of truth for error formatting
 * and type guards for the app/root workspace. Lives under src/ so it's
 * accessible from all files within the main project rootDir.
 *
 * Sharedmodule TS shells keep their own minimal host-boundary helpers so the
 * llmswitch-core source surface can continue shrinking independently.
 */
export declare function formatUnknownError(error: unknown): string;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare const isObject: typeof isRecord;
export declare function getErrorText(error: unknown): string;
/**
 * Trim a string value and return undefined if it's empty or not a string.
 * Canonical implementation — import from here instead of defining locally.
 */
export declare function normalizeString(value: unknown): string | undefined;
/**
 * Check if a string flag value is truthy (1/true/yes/on).
 * Canonical implementation — import from here instead of defining locally.
 */
export declare function isTruthyFlag(value: string | undefined): boolean;
/**
 * Expand ~ to home directory in a path.
 * Canonical implementation — import from here instead of defining locally.
 */
export declare function expandHome(inputPath: string): string;
