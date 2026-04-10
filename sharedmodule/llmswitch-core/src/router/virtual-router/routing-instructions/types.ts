export const ROUTING_INSTRUCTION_MARKER_PATTERN = /<\*\*[\s\S]*?\*\*>/;
export const ROUTING_INSTRUCTION_MARKER_GLOBAL_PATTERN = /<\*\*[\s\S]*?\*\*>/g;

export interface RoutingInstruction {
  type:
    | 'force'
    | 'sticky'
    | 'prefer'
    | 'disable'
    | 'enable'
    | 'clear'
    | 'allow'
    | 'stopMessageSet'
    | 'stopMessageMode'
    | 'stopMessageClear'
    | 'preCommandSet'
    | 'preCommandClear';
  provider?: string;
  keyAlias?: string;
  keyIndex?: number;
  model?: string;
  pathLength?: number;
  processMode?: 'chat' | 'passthrough';
  stopMessageText?: string;
  stopMessageMaxRepeats?: number;
  stopMessageStageMode?: 'on' | 'off' | 'auto';
  stopMessageAiMode?: 'on' | 'off';
  stopMessageSource?: string;
  /**
   * True when the instruction is parsed from an older user message
   * (not the latest user turn in current request).
   */
  fromHistoricalUserMessage?: boolean;
  preCommandScriptPath?: string;
}

export interface RoutingInstructionState {
  forcedTarget?: {
    provider?: string;
    keyAlias?: string;
    keyIndex?: number;
    model?: string;
    pathLength?: number;
    processMode?: 'chat' | 'passthrough';
  };
  stickyTarget?: {
    provider?: string;
    keyAlias?: string;
    keyIndex?: number;
    model?: string;
    pathLength?: number;
    processMode?: 'chat' | 'passthrough';
  };
  preferTarget?: {
    provider?: string;
    keyAlias?: string;
    keyIndex?: number;
    model?: string;
    pathLength?: number;
    processMode?: 'chat' | 'passthrough';
  };
  allowedProviders: Set<string>;
  disabledProviders: Set<string>;
  disabledKeys: Map<string, Set<string | number>>;
  disabledModels: Map<string, Set<string>>;
  /**
   * Source of the current stopMessage configuration.
   * - 'explicit'：由用户通过 <** stopMessage:"..." **> 指令显式设置
   * - 'auto'：由系统基于空响应/错误自动推导（例如 Gemini 空回复）
   */
  stopMessageSource?: string;
  stopMessageText?: string;
  stopMessageMaxRepeats?: number;
  stopMessageUsed?: number;
  stopMessageUpdatedAt?: number;
  stopMessageLastUsedAt?: number;
  stopMessageStageMode?: 'on' | 'off' | 'auto';
  stopMessageAiMode?: 'on' | 'off';
  stopMessageAiSeedPrompt?: string;
  stopMessageAiHistory?: Array<Record<string, unknown>>;
 reasoningStopMode?: 'on' | 'off' | 'endless';
 reasoningStopArmed?: boolean;
 reasoningStopSummary?: string;
 reasoningStopUpdatedAt?: number;
  reasoningStopFailCount?: number;
 preCommandSource?: string;
  preCommandScriptPath?: string;
  preCommandUpdatedAt?: number;
  chatProcessLastTotalTokens?: number;
  chatProcessLastInputTokens?: number;
  chatProcessLastMessageCount?: number;
  chatProcessLastUpdatedAt?: number;
}
