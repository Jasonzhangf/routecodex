export class DebugCenter {}

export class DebugEventBus {
  static getInstance(): DebugEventBus { return new DebugEventBus(); }
  publish(_event: unknown): void {}
  subscribe(_id: string, _cb: (e: unknown)=>void): void {}
}

export default { DebugCenter, DebugEventBus };

