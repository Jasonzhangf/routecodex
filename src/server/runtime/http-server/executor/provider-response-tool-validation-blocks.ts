/**
 * Native-only tool call validation shell.
 *
 * Rust owns shape validation, broad-kill detection, and shell wrapper checks.
 * This layer re-exports the provider-response host calls so executor code does
 * not depend on the broad native binding facade.
 */

export {
  containsBroadKillCommand,
  hasInvalidShellWrapperShape,
  validateCanonicalClientToolCall,
} from '../../../../modules/llmswitch/bridge/provider-response-converter-host.js';
