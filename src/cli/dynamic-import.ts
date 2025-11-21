// Safe dynamic import helper to avoid static ESM resolution constraints
export async function dynamicImport(p: string): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = Function('p', 'return import(p)');
  return fn(p);
}

