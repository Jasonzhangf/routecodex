import type { AdapterContext } from "../../hub/types/chat-envelope.js";
import type { JsonObject } from "../../hub/types/json.js";
import { buildNativeReqOutboundCompatAdapterContext } from "../../hub/pipeline/compat/native-adapter-context.js";
import {
  applyUniversalShapeRequestFilterWithNative,
  applyUniversalShapeResponseFilterWithNative,
} from "../../../router/virtual-router/engine-selection/native-compat-action-semantics.js";

type RequestMessagesRule = {
  when?: {
    role?: "system" | "user" | "assistant" | "tool";
    hasToolCalls?: boolean;
  };
  action: "drop" | "keep" | "set";
  set?: Record<string, unknown>;
};

export interface FilterConfig {
  request: {
    allowTopLevel: string[];
    messages: {
      allowedRoles: string[];
      assistantWithToolCallsContentNull?: boolean;
      toolContentStringify?: boolean;
      suppressAssistantToolCalls?: boolean;
    };
    tools?: {
      normalize?: boolean;
      forceToolChoiceAuto?: boolean;
    };
    assistantToolCalls?: {
      functionArgumentsType?: "object" | "string";
    };
    messagesRules?: RequestMessagesRule[];
  };
  response: {
    allowTopLevel: string[];
    choices: {
      required?: boolean;
      message: {
        allow: string[];
        roleDefault?: string;
        contentNullWhenToolCalls?: boolean;
        tool_calls?: {
          function?: {
            nameRequired?: boolean;
            argumentsType?: "object" | "string";
          };
        };
      };
      finish_reason?: string[];
    };
    usage?: { allow: string[] };
  };
}

export class UniversalShapeFilter {
  private readonly cfg: FilterConfig;

  constructor(config: FilterConfig) {
    this.cfg = config;
  }

  applyRequestFilter(payload: JsonObject): JsonObject {
    return applyUniversalShapeRequestFilterWithNative(
      payload as unknown as Record<string, unknown>,
      this.cfg as unknown as Record<string, unknown>,
    ) as unknown as JsonObject;
  }

  applyResponseFilter(payload: JsonObject, ctx?: AdapterContext): JsonObject {
    return applyUniversalShapeResponseFilterWithNative(
      payload as unknown as Record<string, unknown>,
      this.cfg as unknown as Record<string, unknown>,
      buildNativeReqOutboundCompatAdapterContext(ctx) as unknown as Record<
        string,
        unknown
      >,
    ) as unknown as JsonObject;
  }
}
