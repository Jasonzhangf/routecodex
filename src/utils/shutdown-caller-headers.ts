export function buildShutdownCallerHeaders(): Record<string, string> {
  return {
    'x-routecodex-stop-caller-pid': String(process.pid),
    'x-routecodex-stop-caller-ts': new Date().toISOString(),
    'x-routecodex-stop-caller-cwd': process.cwd(),
    'x-routecodex-stop-caller-cmd': process.argv.join(' ').slice(0, 1024),
  };
}
