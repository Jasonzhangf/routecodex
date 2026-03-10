import { isImagePathWithNative } from '../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

export function isImagePath(p: unknown): boolean {
  return isImagePathWithNative(p);
}
