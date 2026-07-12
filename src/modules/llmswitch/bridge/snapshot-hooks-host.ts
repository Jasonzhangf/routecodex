/**
 * Snapshot hook native bridge surface.
 *
 * Snapshot hook planning and writes remain Rust/NAPI-owned; runtime
 * integrations use this narrow host for snapshot hook calls only.
 */

export {
  shouldRecordSnapshotsNative,
  writeSnapshotViaHooksNative,
} from './native-exports.js';
