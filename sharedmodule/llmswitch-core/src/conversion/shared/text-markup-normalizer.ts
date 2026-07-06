export type {
  JsonToolRepairConfig,
  TextMarkupNormalizeOptions,
  ToolCallLite
} from './text-markup-normalizer/normalize.js';

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
} from '../../native/router-hotpath/native-shared-conversion-semantics.js';

export { normalizeAssistantTextToToolCalls } from './text-markup-normalizer/normalize.js';

export {
  extractToolCallsFromReasoningTextWithNative,
  parseLenientJsonishWithNative,
  repairArgumentsToStringWithNative
} from '../../native/router-hotpath/native-shared-conversion-semantics.js';
