export type CliPackageModeInput = {
  pkgName: string;
  buildMode: 'dev' | 'release';
};

export function resolveCliIsDevPackage(input: CliPackageModeInput): boolean {
  const pkgName = input.pkgName.trim();
  if (pkgName !== 'routecodex') {
    return false;
  }
  return input.buildMode === 'dev';
}
