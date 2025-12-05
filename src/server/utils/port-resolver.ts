export function resolvePortForMode(params: {
  mode: 'dev' | 'release';
  cliPort?: number | null;
  configPort?: number | null;
}): number {
  const { mode, cliPort, configPort } = params;
  // CLI override always wins if provided and valid
  if (typeof cliPort === 'number' && Number.isFinite(cliPort) && cliPort > 0) {
    return cliPort;
  }
  if (mode === 'dev') {
    return 5555; // dev 固定默认端口
  }
  // release 模式必须从配置读取，缺失则 Fail Fast
  if (typeof configPort === 'number' && Number.isFinite(configPort) && configPort > 0) {
    return configPort;
  }
  throw new Error('httpserver.port is required in release mode');
}
