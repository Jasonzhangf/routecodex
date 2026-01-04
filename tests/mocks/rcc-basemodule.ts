export class BaseModule {
  constructor(public readonly id: string = 'mock-module') {}

  async initialize(): Promise<void> {
    // noop
  }

  async cleanup(): Promise<void> {
    // noop
  }
}
