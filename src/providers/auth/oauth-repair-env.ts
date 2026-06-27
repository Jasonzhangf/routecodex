type ScopedEnv = Record<string, string | undefined>;

function setEnvScoped(next: Record<string, string | undefined>): () => void {
  const prev: ScopedEnv = {};
  for (const [key, value] of Object.entries(next)) {
    prev[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

export async function withOAuthRepairEnv<T>(providerType: string, fn: () => Promise<T>): Promise<T> {
  return await fn();
}
