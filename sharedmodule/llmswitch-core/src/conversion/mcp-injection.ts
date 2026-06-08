import {
  injectMcpToolsForChatWithNative,
  injectMcpToolsForResponsesWithNative
} from '../native/router-hotpath/native-shared-conversion-semantics.js';

export function injectMcpToolsForChat(tools: any[] | undefined, discoveredServers: string[]): any[] {
  return injectMcpToolsForChatWithNative(tools, discoveredServers) as any[];
}

export function injectMcpToolsForResponses(tools: any[] | undefined, discoveredServers: string[]): any[] {
  return injectMcpToolsForResponsesWithNative(tools, discoveredServers) as any[];
}
