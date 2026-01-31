import type { Command } from 'commander';

type TokenDescriptorLike = {
  provider: string;
  alias: string;
  filePath: string;
};

type FileLike = {
  existsSync: (path: string) => boolean;
  statSync: (path: string) => { isFile: () => boolean };
};

type PathLike = {
  resolve: (...paths: string[]) => string;
  join: (...paths: string[]) => string;
  basename: (p: string) => string;
  isAbsolute: (p: string) => boolean;
};

function expandHome(pathLike: PathLike, homedir: () => string, raw: string): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('~/')) {
    return pathLike.join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function resolveTokenHintFromFilename(fileName: string): { provider: string; alias: string } | null {
  const name = String(fileName || '').trim();
  if (!name) return null;
  // Preferred: <provider>-oauth-<seq>-<alias>.json (alias optional)
  const seq = name.match(/^(.+)-oauth-(\d+)(?:-(.+))?\.json$/i);
  if (seq) {
    const providerPrefix = String(seq[1] || '').trim().toLowerCase();
    const alias = String(seq[3] || 'default').trim() || 'default';
    const provider = providerPrefix === 'gemini' ? 'gemini-cli' : providerPrefix;
    return { provider, alias };
  }
  // Fallback: <provider>-oauth.json (alias defaults to "default")
  const plain = name.match(/^(.+)-oauth\.json$/i);
  if (plain) {
    const providerPrefix = String(plain[1] || '').trim().toLowerCase();
    const provider = providerPrefix === 'gemini' ? 'gemini-cli' : providerPrefix;
    return { provider, alias: 'default' };
  }
  return null;
}

async function resolveTokenForCamoufox(opts: {
  selector: string;
  fsImpl: FileLike;
  pathImpl: PathLike;
  homedir: () => string;
  findTokenBySelector: (selector: string) => Promise<TokenDescriptorLike | null>;
}): Promise<TokenDescriptorLike | null> {
  const { selector, fsImpl, pathImpl, homedir, findTokenBySelector } = opts;
  const trimmed = String(selector || '').trim();
  if (!trimmed) return null;

  const fromDaemon = await findTokenBySelector(trimmed).catch(() => null);
  if (fromDaemon) {
    return fromDaemon;
  }

  // Allow passing an absolute/relative path outside ~/.routecodex/auth.
  const expanded = expandHome(pathImpl, homedir, trimmed);
  const filePath = pathImpl.isAbsolute(expanded) ? expanded : pathImpl.resolve(expanded);
  try {
    if (fsImpl.existsSync(filePath) && fsImpl.statSync(filePath).isFile()) {
      const hint = resolveTokenHintFromFilename(pathImpl.basename(filePath));
      if (!hint) return null;
      return { provider: hint.provider, alias: hint.alias, filePath };
    }
  } catch {
    // ignore stat failures
  }

  return null;
}

export function createCamoufoxCommand(
  program: Command,
  deps: {
    env: Record<string, string | undefined>;
    fsImpl: FileLike;
    pathImpl: PathLike;
    homedir: () => string;
    findTokenBySelector: (selector: string) => Promise<TokenDescriptorLike | null>;
    openInCamoufox: (opts: { url: string; provider: string; alias: string }) => Promise<boolean>;
    log: (line: string) => void;
    error: (line: string) => void;
    exit: (code: number) => never;
  }
): void {
  program
    .command('camoufox')
    .description('Launch Camoufox using the fingerprint+profile derived from an OAuth token file (养号/verify)')
    .argument(
      '<authfile>',
      'Token selector: file basename or full path (e.g. "antigravity-oauth-3-alias.json" or "~/.routecodex/auth/antigravity-oauth-3-alias.json")'
    )
    .option('--url <url>', 'Initial URL to open', 'https://accounts.google.com/')
    .action(async (authfile: string, options: { url?: string }) => {
      const url = String(options?.url || '').trim() || 'https://accounts.google.com/';
      const token = await resolveTokenForCamoufox({
        selector: authfile,
        fsImpl: deps.fsImpl,
        pathImpl: deps.pathImpl,
        homedir: deps.homedir,
        findTokenBySelector: deps.findTokenBySelector
      });
      if (!token) {
        deps.error(`✗ Token file not found or unrecognized: ${authfile}`);
        deps.error('  Expected name: <provider>-oauth-<seq>-<alias>.json (e.g. antigravity-oauth-3-antonsoltan.json)');
        deps.exit(1);
      }

      deps.log(`Launching Camoufox profile for ${token.provider}[${token.alias}] ...`);

      // This command is strictly "open browser with profile" (manual).
      // Never inherit Camoufox auto OAuth automation modes from the environment.
      const prevAutoMode = deps.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
      const prevDevMode = deps.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
      try {
        delete deps.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
        delete deps.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
        const ok = await deps.openInCamoufox({ url, provider: token.provider, alias: token.alias });
        if (!ok) {
          deps.error('✗ Failed to launch Camoufox (python3/camoufox missing or launcher failed).');
          deps.exit(1);
        }
        deps.log('Camoufox launched.');
      } finally {
        if (prevAutoMode === undefined) {
          delete deps.env.ROUTECODEX_CAMOUFOX_AUTO_MODE;
        } else {
          deps.env.ROUTECODEX_CAMOUFOX_AUTO_MODE = prevAutoMode;
        }
        if (prevDevMode === undefined) {
          delete deps.env.ROUTECODEX_CAMOUFOX_DEV_MODE;
        } else {
          deps.env.ROUTECODEX_CAMOUFOX_DEV_MODE = prevDevMode;
        }
      }
    });
}

