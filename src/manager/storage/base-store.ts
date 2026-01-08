export interface StateStore<TSnapshot, TEvent = unknown> {
  load(): Promise<TSnapshot | null>;
  save(snapshot: TSnapshot): Promise<void>;
  append?(event: TEvent): Promise<void>;
  compact?(): Promise<void>;
}

