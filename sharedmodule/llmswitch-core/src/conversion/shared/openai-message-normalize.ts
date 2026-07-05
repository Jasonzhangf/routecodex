import {
  normalizeOpenaiChatRequestWithNative
} from '../../native/router-hotpath/native-shared-conversion-semantics.js';

export function normalizeChatRequest(request: any): any {
  const disableShellCoerce = String(process?.env?.RCC_DISABLE_SHELL_COERCE ?? process?.env?.ROUTECODEX_DISABLE_SHELL_COERCE ?? '').toLowerCase();
  const isDisabled = disableShellCoerce === '1' || disableShellCoerce === 'true';
  return normalizeOpenaiChatRequestWithNative(request, isDisabled);
}
