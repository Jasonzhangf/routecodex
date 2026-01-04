export function parse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

export function stringify(value) {
  return JSON.stringify(value);
}
