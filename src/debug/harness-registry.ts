import type { ExecutionHarness } from './types.js';

export class HarnessRegistry {
  private readonly harnesses = new Map<string, ExecutionHarness<any, any>>();

  register<TInput, TResult>(harness: ExecutionHarness<TInput, TResult>): void {
    this.harnesses.set(harness.id, harness);
  }

  get<TInput, TResult>(id: string): ExecutionHarness<TInput, TResult> | undefined {
    return this.harnesses.get(id) as ExecutionHarness<TInput, TResult> | undefined;
  }

  require<TInput, TResult>(id: string): ExecutionHarness<TInput, TResult> {
    const harness = this.get<TInput, TResult>(id);
    if (!harness) {
      throw new Error(`[debug-harness] harness "${id}" not registered`);
    }
    return harness;
  }

  list(): string[] {
    return Array.from(this.harnesses.keys());
  }
}
