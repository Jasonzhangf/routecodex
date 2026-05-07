export function resolveRepoRoot(currentModuleUrl: string): string {
  // 保留原函数签名以兼容已有调用，但当前实现只返回 package.json 所在目录，
  // 具体 llmswitch-core 模块加载由 modules/llmswitch/bridge 负责。
  if (!currentModuleUrl) {
    throw new Error('[llmswitch-loader] currentModuleUrl is required');
  }
  const url = new URL(currentModuleUrl);
  const filePath = url.pathname || '';
  const lastIndex = filePath.lastIndexOf('/');
  if (lastIndex > 0) {
    return filePath.slice(0, lastIndex);
  }
  throw new Error(`[llmswitch-loader] unable to resolve repo root from module url: ${currentModuleUrl}`);
}
