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
    if (norm && typeof (norm as any).function?.name === 'string' && ((norm as any).function as any).name) {
      try {
        const fn = (norm as any).function as Unknown;
        const name = String((fn as any).name || '').trim();
        // Adopt CCR-style guidance: do not parse unknown keys at router level.
        // Strengthen shell tool description so the model places all intent into argv tokens only.
        if (name === 'shell') {
          const params = (fn as any).parameters && typeof (fn as any).parameters === 'object'
            ? ((fn as any).parameters as Unknown)
            : ({ type: 'object', properties: {}, additionalProperties: false } as Unknown);
          // Ensure command field exists as array<string>
          if (!isObject((params as any).properties)) {
            (params as any).properties = {} as Unknown;
          }
          const props = (params as any).properties as Unknown;
          if (!isObject((props as any).command)) {
            (props as any).command = {
              type: 'array',
              items: { type: 'string' },
              description: 'The command to execute as argv tokens (do not add extra keys)'
            } as Unknown;
          }
          // Disallow extra top-level keys to nudge the model away from inventing fields
          (params as any).additionalProperties = false;
          (fn as any).parameters = params;
          const guidance = [
            'Execute shell commands. Place ALL flags, paths and patterns into the `command` array as argv tokens.',
            'Do NOT add extra keys beyond the schema. Examples:',
            '- Find TS files: ["find",".","-type","f","-name","*.ts"]',
            '- Exclude node_modules: ["find",".","-type","f","-not","-path","*/node_modules/*","-name","*.ts"]',
            '- Preview first 20 lines: ["find",".","-type","f","-name","*.ts","-exec","head","-20","{}","+"]',
            '中文提示：所有参数必须写入 command 数组，不要使用额外键名（如 md 或 node_modules/*）。',
            '示例：查找 TS 文件并排除 node_modules： ["find",".","-type","f","-not","-path","*/node_modules/*","-name","*.ts"]'
          ].join('\n');
          const desc = typeof (fn as any).description === 'string' ? String((fn as any).description) : '';
          (fn as any).description = desc && !/Place ALL flags/i.test(desc)
            ? `${desc}\n\n${guidance}`
            : (desc || guidance);
          // Enforce strict to encourage the model to comply
          (fn as any).strict = true;
        }
      } catch { /* ignore augmentation errors */ }
      out.push(norm);
    }
  }
  return out;
}
