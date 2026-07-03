// feature_id: sse.public_ts_lib_surface
import {
  buildJsonFromSseWithNative,
  buildReadableFromSseFrames,
  buildSseFramesFromJsonWithNative,
  collectSseBodyText,
  type NativeSseFramesInput,
  type NativeSseFramesOutput,
  type NativeSseJsonInput,
  type NativeSseRuntimeProtocol,
} from '../native/router-hotpath/native-sse-runtime.js';

export const sseCodecPublicSurfaceFeatureAnchor = true;

export function jsonToSseFrames(input: NativeSseFramesInput): NativeSseFramesOutput {
  return buildSseFramesFromJsonWithNative(input);
}

export function sseToJson(input: NativeSseJsonInput): Record<string, unknown> {
  return buildJsonFromSseWithNative(input);
}

export {
  collectSseBodyText,
  buildReadableFromSseFrames,
};

export type {
  NativeSseFramesInput,
  NativeSseFramesOutput,
  NativeSseJsonInput,
  NativeSseRuntimeProtocol,
};
