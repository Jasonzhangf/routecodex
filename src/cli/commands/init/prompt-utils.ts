import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';

import type {
  DuplicateMigrationStrategy,
  DuplicateProviderResolution,
  InitCommandContext,
  PromptLike
} from './shared.js';

export function buildInteractivePrompt(
  ctx: InitCommandContext
): { prompt: PromptLike; close: () => void } | null {
  if (typeof ctx.prompt === 'function') {
    return { prompt: ctx.prompt, close: () => {} };
  }
  if (process.env.CI === '1' || process.env.JEST_WORKER_ID || process.env.NODE_ENV === 'test') {
    return null;
  }
  if (!input.isTTY || !output.isTTY) {
    return null;
  }
  const rl = readline.createInterface({ input, output, terminal: true });
  return {
    prompt: (question: string) =>
      new Promise((resolve) => {
        let settled = false;
        const onClose = () => {
          if (settled) {
            return;
          }
          settled = true;
          rl.off('close', onClose);
          resolve('');
        };

        try {
          input.resume();
        } catch {
          // ignore
        }

        rl.once('close', onClose);
        rl.question(question, (answer) => {
          if (settled) {
            return;
          }
          settled = true;
          rl.off('close', onClose);
          resolve(answer);
        });
      }),
    close: () => rl.close()
  };
}

export async function promptDuplicateProviderResolution(
  prompt: PromptLike,
  providerId: string
): Promise<DuplicateProviderResolution> {
  while (true) {
    const answerRaw = await prompt(
      `Provider "${providerId}" already exists in v2 provider root. Choose: (k)eep / (o)verwrite / (m)erge (default=k)\n> `
    );
    const answer = String(answerRaw ?? '')
      .trim()
      .toLowerCase();

    if (!answer || answer === 'k' || answer === 'keep') {
      return 'keep';
    }
    if (answer === 'o' || answer === 'overwrite') {
      return 'overwrite';
    }
    if (answer === 'm' || answer === 'merge') {
      return 'merge';
    }
  }
}

export async function promptDuplicateMigrationStrategy(
  prompt: PromptLike,
  duplicateProviderIds: string[]
): Promise<DuplicateMigrationStrategy> {
  const providersPreview = duplicateProviderIds.join(', ');
  while (true) {
    const answerRaw = await prompt(
      `Detected existing provider configs in provider dir: ${providersPreview}\n` +
      `Choose migration strategy: (a) overwrite all / (s) decide per-provider / (k) keep all (default=s)\n> `
    );
    const answer = String(answerRaw ?? '')
      .trim()
      .toLowerCase();

    if (!answer || answer === 's' || answer === 'split' || answer === 'per-provider' || answer === 'per_provider') {
      return 'per_provider';
    }
    if (answer === 'a' || answer === 'all' || answer === 'overwrite_all' || answer === 'overwrite-all') {
      return 'overwrite_all';
    }
    if (answer === 'k' || answer === 'keep' || answer === 'keep_all' || answer === 'keep-all') {
      return 'keep_all';
    }
  }
}
