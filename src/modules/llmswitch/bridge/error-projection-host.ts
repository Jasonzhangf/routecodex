/**
 * Error projection bridge surface.
 *
 * ErrorErr06 projection stays Rust-owned; this host file only exposes the
 * narrow server-facing native call so callers do not depend on the broad
 * native export facade.
 */

import { projectSseErrorEventPayloadNative } from './native-exports.js';

export { projectSseErrorEventPayloadNative };
