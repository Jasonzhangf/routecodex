/**
 * Responses-to-chat request bridge surface.
 *
 * Responses/OpenAI request conversion stays Rust-owned; this host file only
 * exposes the narrow native call needed by HTTP/client compatibility shells.
 */

import { convertResponsesRequestToChatNative } from './native-exports.js';

export { convertResponsesRequestToChatNative };
