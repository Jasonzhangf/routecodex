import type { CliRuntime } from './runtime.js';
import { createCliProgram } from './program.js';

type CommanderErrorLike = {
  exitCode?: number;
};

export async function runCli(
  argv: string[],
  ctx: { pkgName: string; cliVersion: string; runtime: CliRuntime }
): Promise<number> {
  const program = createCliProgram(ctx);

  program.exitOverride((err) => {
    throw err;
  });

  try {
    await program.parseAsync(argv, { from: 'node' });
    return 0;
  } catch (err) {
    const e = err as CommanderErrorLike;
    return typeof e?.exitCode === 'number' ? e.exitCode : 1;
  }
}

