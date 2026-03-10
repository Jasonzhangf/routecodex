export type JsonToolArgumentAliasMap = Record<string, string[]>;

export type JsonToolRepairConfig = {
  toolNameAliases?: Record<string, string>;
  argumentAliases?: Record<string, JsonToolArgumentAliasMap>;
};

export type TextMarkupNormalizeOptions = {
  jsonToolRepair?: JsonToolRepairConfig;
};

export type ToolCallLite = { id?: string; name: string; args: string };
