export interface StripInternalKeysOptions {
    /**
     * Preserve specific internal keys (e.g. framework carriers).
     * Keys must match exactly (no glob).
     */
    preserveKeys?: ReadonlySet<string>;
}
/**
 * Removes keys that start with "__" from any object/array tree.
 * Intended for enforcing the E1 boundary rule (no internal env vars reach client/provider payloads).
 */
export declare function stripInternalKeysDeep<T>(value: T, options?: StripInternalKeysOptions): T;
