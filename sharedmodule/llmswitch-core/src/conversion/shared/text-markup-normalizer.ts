export type {
  JsonToolRepairConfig,
  TextMarkupNormalizeOptions,
  ToolCallLite
} from '../types/text-markup-normalizer.js';

export {
  extractApplyPatchCallsFromTextWithNative as extractApplyPatchCallsFromText,
  extractBareExecCommandFromTextWithNative as extractBareExecCommandFromText,
  extractExecuteBlocksFromTextWithNative as extractExecuteBlocksFromText,
  extractExploredListDirectoryCallsFromTextWithNative as extractExploredListDirectoryCallsFromText,
  extractInvokeToolsFromTextWithNative as extractInvokeToolsFromText,
  extractJsonToolCallsFromTextWithNative as extractJsonToolCallsFromText,
  extractParameterXmlToolsFromTextWithNative as extractParameterXmlToolsFromText,
  extractQwenToolCallTokensFromTextWithNative as extractQwenToolCallTokensFromText,
  extractSimpleXmlToolsFromTextWithNative as extractSimpleXmlToolsFromText,
  extractToolNamespaceXmlBlocksFromTextWithNative as extractToolNamespaceXmlBlocksFromText,
  extractXMLToolCallsFromTextWithNative as extractXMLToolCallsFromText
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';

export { normalizeAssistantTextToToolCalls } from './text-markup-normalizer/normalize.js';

export {
  extractToolCallsFromReasoningTextWithNative,
  parseLenientJsonishWithNative,
  repairArgumentsToStringWithNative
} from '../../router/virtual-router/engine-selection/native-shared-conversion-semantics.js';
