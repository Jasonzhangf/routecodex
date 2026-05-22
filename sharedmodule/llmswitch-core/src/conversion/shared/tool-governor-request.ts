import { augmentOpenAITools } from '../../guidance/index.js';
import { validateToolCall } from '../../tools/tool-registry.js';
import { normalizeExecCommandArgs } from '../../tools/exec-command/normalize.js';
import {
  buildBlockedExecCommandArgs,
  repairCommandNameAsExecToolCall,
  resolveExecCommandGuardValidationOptions
} from './tool-governor-guards.js';
import { normalizeApplyPatchArgumentsWithNative } from '../../router/virtual-router/engine-selection/native-chat-process-governance-semantics.js';
import {
  parseLenientJsonishWithNative as parseLenient,
  repairArgumentsToStringWithNative as repairArgumentsToString
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';
import { isObject } from '../../shared/common-utils.js';
import {
  logToolGovernorNonBlocking,
  type ToolGovernanceOptions,
  type Unknown
} from './tool-governor-shared.js';

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function ensureChatProcessApplyPatchToolContract(tool: Record<string, unknown>): void {
  const fn = isSchemaObject(tool.function) ? (tool.function as Record<string, unknown>) : null;
  if (!fn) return;
  const name = typeof fn.name === 'string' ? fn.name.trim().toLowerCase() : '';
  if (name !== 'apply_patch') return;

  const parameters = isSchemaObject(fn.parameters) ? { ...(fn.parameters as Record<string, unknown>) } : {};
  const properties = isSchemaObject(parameters.properties) ? { ...(parameters.properties as Record<string, unknown>) } : {};
  const hasHashlineFilePath = isSchemaObject(properties.filePath) || isSchemaObject(properties.file_path);

  if (!hasHashlineFilePath) {
    delete properties.filePath;
    delete properties.file_path;
    delete properties.fileContent;
    delete properties.file_content;
  } else {
    const filePathSchema = isSchemaObject(properties.filePath)
      ? properties.filePath
      : isSchemaObject(properties.file_path)
        ? properties.file_path
        : { type: 'string', description: 'Required for hashline patch syntax. Provide the target file path when `patch` uses hashline op headers.' };
    const fileContentSchema = isSchemaObject(properties.fileContent)
      ? properties.fileContent
      : isSchemaObject(properties.file_content)
        ? properties.file_content
        : { type: 'string', description: 'Required for hashline patch syntax current file content.' };
    properties.filePath = filePathSchema;
    properties.file_path = filePathSchema;
    properties.fileContent = fileContentSchema;
    properties.file_content = fileContentSchema;
  }

  properties.patch = {
    type: 'string',
    description: hasHashlineFilePath
      ? 'Hashline patch text only. In this schema, upstream authoring mode is hashline-first: provide `filePath`/`file_path`, provide current file content in `fileContent`/`file_content`, and write the edit in hashline syntax. Do not author canonical apply_patch blocks in this mode. Rust will transparently bridge hashline back into canonical apply_patch for the client.'
      : 'Raw patch text only. Author exactly one canonical patch body in `patch`. Use only the internal `*** Begin Patch` / `*** End Patch` grammar with `*** Add File:`, `*** Update File:`, or `*** Delete File:` headers. `*** Update File:` hunks must use `@@`, `*** Add File:` content lines must start with `+`, and GNU diff headers (`---`, `+++`, `diff --git`) are not valid. Do not add `filePath`/`file_path` unless the schema explicitly declares it.'
  };
  properties.input = {
    type: 'string',
    description: 'Compatibility alias of patch. Prefer patch. Do not use input to switch syntax families.'
  };

  const required = Array.isArray(parameters.required) ? [...parameters.required] : [];
  if (!required.includes('patch')) {
    required.push('patch');
  }

  fn.parameters = {
    ...parameters,
    type: 'object',
    properties,
    required,
    additionalProperties: false
  };
  fn.strict = false;
}

export function processChatRequestTools(request: Unknown, opts?: ToolGovernanceOptions): Unknown {
  const options: ToolGovernanceOptions = { ...(opts || {}) };
  void options;
  if (!isObject(request)) return request;
  const out: Unknown = JSON.parse(JSON.stringify(request));

  try {
    const tools = Array.isArray((out as any)?.tools) ? ((out as any).tools as any[]) : [];
    if (tools.length > 0) {
      for (const tool of tools) {
        if (!tool || typeof tool !== 'object') continue;
        const fn = (tool as any).function;
        if (!fn || typeof fn !== 'object') continue;
        const typeStr = String((tool as any).type || '').toLowerCase();
        const nameStr = typeof (fn as any).name === 'string' ? String((fn as any).name).toLowerCase() : '';
        const shouldPatch = typeStr === 'function' || nameStr === 'apply_patch';
        if (!shouldPatch) continue;
        if (!Object.prototype.hasOwnProperty.call(fn, 'parameters')) {
          (tool as any).function = { ...(fn as any), parameters: {} };
        }
        ensureChatProcessApplyPatchToolContract(tool as Record<string, unknown>);
      }
      (out as any).tools = augmentOpenAITools(tools);
    }
  } catch (error) {
    logToolGovernorNonBlocking('request_minimal_tool_shape_repair', error);
  }

  const canonical = out as any;
  try {
    const modelId = typeof canonical?.model === 'string' ? String(canonical.model) : 'unknown';
    const raw = String((process as any)?.env?.RCC_TOOL_CHOICE_REQUIRED || '').trim();
    const wanted = raw ? raw.split(',').map((value: string) => value.trim()).filter(Boolean) : [];
    if (Array.isArray(canonical?.tools) && (canonical.tools as any[]).length > 0) {
      if (!canonical.tool_choice) canonical.tool_choice = 'auto';
      if (wanted.length > 0 && wanted.some((pattern: string) => modelId.includes(pattern))) {
        canonical.tool_choice = 'required';
      }
    }
  } catch (error) {
    logToolGovernorNonBlocking('request_tool_choice_policy', error);
  }
  return normalizeSpecialToolCallsOnRequest(canonical);
}

export function normalizeApplyPatchToolCallsOnRequest(request: Unknown): Unknown {
  return normalizeSpecialToolCallsOnRequest(request);
}

export function normalizeRequestToolCalls(request: Unknown): Unknown {
  return normalizeSpecialToolCallsOnRequest(request);
}

function normalizeSpecialToolCallsOnRequest(request: Unknown): Unknown {
  const out = JSON.parse(JSON.stringify(request)) as Unknown;
  const messages = Array.isArray((out as any)?.messages) ? ((out as any).messages as any[]) : [];
  let lastAssistantIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (!candidate || typeof candidate !== 'object') continue;
    if ((candidate as any).role === 'assistant') {
      lastAssistantIndex = index;
      break;
    }
  }
  if (lastAssistantIndex === -1) {
    return out;
  }
  const validationOptions = resolveExecCommandGuardValidationOptions(out);
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || index !== lastAssistantIndex) continue;
    const toolCalls = Array.isArray((message as any).tool_calls) ? ((message as any).tool_calls as any[]) : [];
    if (!toolCalls.length) continue;
    for (const toolCall of toolCalls) {
      const fn = toolCall && toolCall.function ? toolCall.function : undefined;
      repairCommandNameAsExecToolCall(fn as Record<string, unknown> | undefined, validationOptions);
      const name = typeof fn?.name === 'string' ? String(fn.name).trim().toLowerCase() : '';
      const rawArgs = (fn as any)?.arguments;

      if (name === 'apply_patch') {
        const normalized = normalizeApplyPatchArgumentsWithNative(rawArgs);
        (fn as any).arguments = normalized.normalizedArguments;
        continue;
      }

      try {
        if (name === 'exec_command') {
          const argsStr = repairArgumentsToString(rawArgs);
          const validation = validateToolCall('exec_command', argsStr, validationOptions);
          if (validation?.ok && typeof validation.normalizedArgs === 'string') {
            (fn as any).arguments = validation.normalizedArgs;
          } else if (validation && !validation.ok) {
            (fn as any).arguments = buildBlockedExecCommandArgs(rawArgs, validation.reason, validation.message);
          } else {
            let parsed: any;
            try {
              parsed = JSON.parse(argsStr);
            } catch (error) {
              logToolGovernorNonBlocking('request_exec_command_parse_json', error);
              parsed = parseLenient(argsStr);
            }
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              const normalized = normalizeExecCommandArgs(parsed as Record<string, unknown>);
              try {
                (fn as any).arguments = JSON.stringify(normalized.ok ? normalized.normalized : parsed);
              } catch (error) {
                logToolGovernorNonBlocking('request_exec_command_json_stringify', error);
                (fn as any).arguments = '{}';
              }
            }
          }
        }
      } catch (error) {
        logToolGovernorNonBlocking('request_tool_call_normalize_item', error);
      }
    }
  }
  return out;
}
