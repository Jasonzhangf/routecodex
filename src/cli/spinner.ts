import { dynamicImport } from './dynamic-import.js';

export type Spinner = {
  start(text?: string): Spinner;
  succeed(text?: string): void;
  fail(text?: string): void;
  warn(text?: string): void;
  info(text?: string): void;
  stop(): void;
  text: string;
};

export async function createSpinner(text: string): Promise<Spinner> {
  try {
    const mod: any = await dynamicImport('ora');
    const oraFn: any = mod?.default || mod;
    if (typeof oraFn === 'function') {
      const s = oraFn(text);
      return s.start();
    }
  } catch {
    // fall through to stub
  }
  let currentText = text;
  const log = (prefix: string, msg?: string) => {
    const m = msg ?? currentText;
    if (!m) return;
    // eslint-disable-next-line no-console
    console.log(`${prefix} ${m}`);
  };
  const stub: any = {
    start(msg?: string) { if (msg) currentText = msg; log('...', msg); return stub; },
    succeed(msg?: string) { log('✓', msg); },
    fail(msg?: string) { log('✗', msg); },
    warn(msg?: string) { log('⚠', msg); },
    info(msg?: string) { log('ℹ', msg); },
    stop() { /* no-op */ },
    get text() { return currentText; },
    set text(v: string) { currentText = v; }
  };
  return stub as Spinner;
}

