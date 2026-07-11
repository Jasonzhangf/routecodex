/**
 * Finish-reason bridge surface.
 *
 * Response finish-reason derivation stays Rust-owned; this host file only
 * exposes the narrow server-facing native call.
 */

import { deriveFinishReasonNative } from './native-exports.js';

export { deriveFinishReasonNative };
