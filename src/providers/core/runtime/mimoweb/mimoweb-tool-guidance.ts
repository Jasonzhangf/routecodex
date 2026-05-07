/**
 * MiMo Web Provider — Request-side tool guidance
 *
 * Injects Anthropic-format tool definitions into a system prompt as
 * text-based tool-call instructions.  Ported from mimo2api prompt.ts.
 *
 * ONLY used inside mimoweb compat layer; never leaks into Hub Pipeline.
 */

export interface AnthropicToolDef {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

type OpenAIToolLike = {
  type?: string;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export function normalizeAnthropicToolDef(raw: AnthropicToolDef | OpenAIToolLike): AnthropicToolDef | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const row = raw as Record<string, unknown>;
  const fnRaw = row.function;
  const fn =
    fnRaw && typeof fnRaw === 'object' && !Array.isArray(fnRaw)
      ? (fnRaw as { name?: string; description?: string; parameters?: Record<string, unknown> })
      : undefined;
  const name =
    (typeof row.name === 'string' && row.name.trim())
    || (typeof fn?.name === 'string' && fn.name.trim())
    || '';
  if (!name) {
    return null;
  }
  const description =
    (typeof row.description === 'string' && row.description.trim())
    || (typeof fn?.description === 'string' && fn.description.trim())
    || '';
  const inputSchemaRaw = row.input_schema;
  const parametersRaw = row.parameters;
  const inputSchema =
    (inputSchemaRaw && typeof inputSchemaRaw === 'object' && !Array.isArray(inputSchemaRaw) ? inputSchemaRaw : undefined)
    ?? (parametersRaw && typeof parametersRaw === 'object' && !Array.isArray(parametersRaw) ? parametersRaw : undefined)
    ?? (fn?.parameters && typeof fn.parameters === 'object' ? fn.parameters : undefined)
    ?? { type: 'object', properties: {}, additionalProperties: true };
  return {
    name,
    description,
    input_schema: inputSchema as Record<string, unknown>
  };
}

interface NormalizedTool {
  name: string;
  description: string;
  paramLine: string;
}

function normalizeTool(t: AnthropicToolDef): NormalizedTool {
  const props = (t.input_schema?.properties ?? {}) as Record<
    string,
    { type?: string; description?: string }
  >;
  const required = new Set((t.input_schema?.required ?? []) as string[]);
  const paramLine = Object.entries(props)
    .map(([k, v]) => k + (required.has(k) ? '*' : '') + ':' + (v.type ?? 'any'))
    .join(', ');
  return { name: t.name, description: t.description ?? '', paramLine };
}

const TC_OPEN = String.fromCharCode(60) + 'tool_call' + String.fromCharCode(62);
const TC_CLOSE = String.fromCharCode(60) + '/tool_call' + String.fromCharCode(62);

export function buildToolSystemPrompt(tools: AnthropicToolDef[]): string {
  const normalizedTools = tools
    .map((tool) => normalizeAnthropicToolDef(tool))
    .filter((tool): tool is AnthropicToolDef => tool !== null);
  if (!normalizedTools.length) return '';
  const toolDescs = normalizedTools
    .map((t) => {
      const n = normalizeTool(t);
      return n.name + '(' + n.paramLine + ')';
    })
    .join(', ');
  return [
    '[\u5DE5\u5177\u8C03\u7528\u683C\u5F0F - \u5FC5\u987B\u4E25\u683C\u9075\u5B88]',
    '',
    TC_OPEN,
    '{"name": "\u5DE5\u5177\u540D", "arguments": {"\u53C2\u6570": "\u503C"}}',
    TC_CLOSE,
    '',
    '\u8981\u6C42\uFF1A',
    '\u2022 \u5FC5\u987B\u7528 ' + TC_OPEN + ' \u6807\u7B7E\u5305\u88F9 JSON',
    '\u2022 JSON \u5FC5\u987B\u6709 "name" \u548C "arguments" \u5B57\u6BB5',
    '\u2022 \u7981\u6B62\u8F93\u51FA bash \u547D\u4EE4\u6216 markdown \u4EE3\u7801\u5757',
    '\u2022 \u7981\u6B62\u8F93\u51FA <toolcall_status>\u3001<toolcall_result> \u7B49\u7CFB\u7EDF\u6807\u7B7E',
    '\u2022 \u7981\u6B62\u4F7F\u7528\u4E2D\u6587\u6807\u7B7E\uFF08\u5982 <\u51FD\u6570\u8C03\u7528>\u3001<\u51FD\u6570\u540D> \u7B49\uFF09',
    '',
    '\u53EF\u7528\u5DE5\u5177\uFF1A' + toolDescs,
  ].join('\n');
}
