export function resolveRepoRoot(currentModuleUrl: string): string {
  // 保留原函数签名以兼容已有调用，但当前实现只返回 package.json 所在目录，
  // 具体 llmswitch-core 模块加载由 modules/llmswitch/bridge 负责。
  if (!currentModuleUrl) {
    return process.cwd();
  }
  try {
    const url = new URL(currentModuleUrl);
    const filePath = url.pathname || '';
    const lastIndex = filePath.lastIndexOf('/');
    if (lastIndex > 0) {
      return filePath.slice(0, lastIndex);
    }
  } catch {
    // fallback: return input as-is when not a valid URL
    return currentModuleUrl;
  }
  return currentModuleUrl;
}
