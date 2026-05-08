export function replaceMutableRecord(
  target: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!target || typeof target !== "object") {
    return undefined;
  }
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, next);
  return target;
}
