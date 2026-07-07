import os from 'node:os';
import path from 'node:path';
/**
 * Shared common utilities — single source of truth for error formatting
 * and type guards for the app/root workspace. Lives under src/ so it's
 * accessible from all files within the main project rootDir.
 *
 * Sharedmodule TS shells keep their own minimal host-boundary helpers so the
 * llmswitch-core source surface can continue shrinking independently.
 */
export function formatUnknownError(error) {
    if (error instanceof Error) {
        return error.stack || `${error.name}: ${error.message}`;
    }
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error);
    }
}
export function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
export const isObject = isRecord;
export function getErrorText(error) {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    try {
        return JSON.stringify(error);
    }
    catch {
        return String(error);
    }
}
/**
 * Trim a string value and return undefined if it's empty or not a string.
 * Canonical implementation — import from here instead of defining locally.
 */
export function normalizeString(value) {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
}
/**
 * Check if a string flag value is truthy (1/true/yes/on).
 * Canonical implementation — import from here instead of defining locally.
 */
export function isTruthyFlag(value) {
    const raw = String(value || '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}
/**
 * Expand ~ to home directory in a path.
 * Canonical implementation — import from here instead of defining locally.
 */
export function expandHome(inputPath) {
    if (!inputPath.startsWith('~')) {
        return inputPath;
    }
    const homeDir = String(process.env.HOME || '').trim() || os.homedir();
    return path.join(homeDir, inputPath.slice(1));
}
