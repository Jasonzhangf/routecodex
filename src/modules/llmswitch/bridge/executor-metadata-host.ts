/**
 * Executor metadata bridge surface.
 *
 * Session identifier extraction and servertool CLI route-hint parsing stay
 * native-owned; this host only exposes the narrow calls used by executor
 * metadata capture.
 */

export {
  extractServertoolCliResultRouteHintFromRequestNative,
  extractSessionIdentifiersFromMetadataNative,
} from './native-exports.js';
