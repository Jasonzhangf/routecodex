export class DebugEventBus {
  static getInstance(): DebugEventBus {
    return new DebugEventBus();
  }

  publish(): void {
    // no-op mock
  }

  subscribe(): void {
    // no-op mock
  }
}
