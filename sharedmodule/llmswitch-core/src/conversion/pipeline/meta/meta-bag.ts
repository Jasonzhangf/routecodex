import { jsonClone, type JsonValue } from '../../hub/types/json.js';

export type ConversionMetaValue = JsonValue;
export type ConversionMetaRecord = Record<string, ConversionMetaValue>;
export type ConversionMetaEntries = Iterable<[string, ConversionMetaValue]>;

export type ConversionMetaInput =
  | ConversionMetaBag
  | ConversionMetaRecord
  | ConversionMetaEntries
  | undefined;

function cloneValue<T extends ConversionMetaValue>(value: T): T {
  return jsonClone(value);
}

function entriesFromInput(input?: ConversionMetaInput): ConversionMetaEntries | undefined {
  if (!input) {
    return undefined;
  }
  if (input instanceof ConversionMetaBag) {
    return input.entries();
  }
  if (typeof (input as ConversionMetaEntries)[Symbol.iterator] === 'function') {
    return input as ConversionMetaEntries;
  }
  return Object.entries(input as ConversionMetaRecord);
}

export class ConversionMetaBag {
  private readonly store: Map<string, ConversionMetaValue> = new Map();

  constructor(initial?: ConversionMetaInput) {
    if (initial) {
      this.ingest(initial);
    }
  }

  static from(input?: ConversionMetaInput): ConversionMetaBag {
    return new ConversionMetaBag(input);
  }

  keys(): string[] {
    return Array.from(this.store.keys());
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  get<T extends ConversionMetaValue>(key: string): T | undefined {
    const value = this.store.get(key);
    return value as T | undefined;
  }

  set(key: string, value: ConversionMetaValue | undefined): void {
    if (value === undefined) {
      this.store.delete(key);
      return;
    }
    this.store.set(key, cloneValue(value));
  }

  consume<T extends ConversionMetaValue>(key: string): T | undefined {
    const value = this.get<T>(key);
    if (value !== undefined) {
      this.store.delete(key);
    }
    return value;
  }

  ingest(input?: ConversionMetaInput): void {
    const incoming = entriesFromInput(input);
    if (!incoming) {
      return;
    }
    for (const [key, value] of incoming) {
      if (value === undefined) {
        this.store.delete(key);
      } else {
        this.store.set(key, cloneValue(value));
      }
    }
  }

  entries(): ConversionMetaEntries {
    return this.store.entries();
  }

  snapshot(): ConversionMetaRecord {
    const out: ConversionMetaRecord = {};
    for (const [key, value] of this.store.entries()) {
      out[key] = cloneValue(value);
    }
    return out;
  }

  toJSON(): ConversionMetaRecord {
    return this.snapshot();
  }

  clone(): ConversionMetaBag {
    return new ConversionMetaBag(this.entries());
  }
}
