export type Unknown = Record<string, unknown>;

const defaultObjectSchema = () => ({ type: 'object', properties: {}, additionalProperties: true });

function isObject(v: unknown): v is Unknown {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function tryParseJson(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return s; }
}

export function normalizeSingleTool(input: any): Unknown | null {
  if (!input || typeof input !== 'object') return null;
  const fn = (input as any).function || {};
  const topName = typeof (input as any).name === 'string' ? (input as any).name : undefined;
  const topDesc = typeof (input as any).description === 'string' ? (input as any).description : undefined;
  const topParams = (input as any).parameters;
  const name = typeof fn?.name === 'string' ? fn.name : topName;
  const desc = typeof fn?.description === 'string' ? fn.description : topDesc;
  let params = (fn?.parameters !== undefined ? fn.parameters : topParams);
  params = tryParseJson(params);
  if (!isObject(params)) params = defaultObjectSchema();
  const out: Unknown = {
    type: 'function',
    function: {
      name,
      ...(desc ? { description: desc } : {}),
      parameters: params as Unknown
    }
  };
  return out;
}

export function normalizeTools(tools: any[]): Unknown[] {
  if (!Array.isArray(tools)) return [];
  const out: Unknown[] = [];
  for (const t of tools) {
    const norm = normalizeSingleTool(t);
    if (norm && typeof (norm as any).function?.name === 'string' && ((norm as any).function as any).name) out.push(norm);
  }
  return out;
}

