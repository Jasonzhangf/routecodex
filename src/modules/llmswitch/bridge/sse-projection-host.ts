/**
 * SSE projection bridge surface.
 *
 * The handler owns transport IO only. Frame projection and terminal-state
 * evidence remain Rust/NAPI-owned behind these narrow native calls.
 */

import {
  projectResponsesSseFrameForClientNative,
  updateResponsesSseTransportTerminalStateNative,
} from './native-exports.js';

export {
  projectResponsesSseFrameForClientNative,
  updateResponsesSseTransportTerminalStateNative,
};
