export type Unknown = unknown;
export type UnknownObject = Record<string, unknown>;
export type UnknownArray = unknown[];

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonArray;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonArray = JsonValue[];

export type LogData = Record<string, unknown> | unknown[] | string | number | boolean;

