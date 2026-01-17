export type Spinner = {
  start(text?: string): Spinner;
  succeed(text?: string): void;
  fail(text?: string): void;
  warn(text?: string): void;
  info(text?: string): void;
  stop(): void;
  text: string;
};

type OraModule = {
  default?: (text?: string) => Spinner;
};

async function dynamicImport<T>(specifier: string): Promise<T | undefined> {
  try {
    return (await import(specifier)) as T;
  } catch {
    return undefined;
  }
}

export async function createSpinner(text: string): Promise<Spinner> {
  const mod = await dynamicImport<OraModule>('ora');
  const oraFactory = typeof mod?.default === 'function' ? mod.default : undefined;
  if (oraFactory) {
    const instance = oraFactory(text);
    if (typeof instance.start === 'function') {
      instance.start(text);
      return instance;
    }
  }

  let currentText = text;
  const log = (prefix: string, msg?: string) => {
    const message = msg ?? currentText;
    if (!message) {
      return;
    }
    console.log(`${prefix} ${message}`);
  };

  const stub: Spinner = {
    start(msg?: string) {
      if (msg) {
        currentText = msg;
      }
      log('...', msg);
      return stub;
    },
    succeed(msg?: string) {
      log('✓', msg);
    },
    fail(msg?: string) {
      log('✗', msg);
    },
    warn(msg?: string) {
      log('⚠', msg);
    },
    info(msg?: string) {
      log('ℹ', msg);
    },
    stop() {
      /* no-op */
    },
    get text() {
      return currentText;
    },
    set text(value: string) {
      currentText = value;
    }
  };

  return stub;
}

