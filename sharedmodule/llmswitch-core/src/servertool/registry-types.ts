import type { ServerToolHandler } from './types.js';
import type { ServerToolHandlerRegistrationSpec } from './skeleton-config.js';

type TriggerMode = 'tool_call' | 'auto';
type AutoHookPhase = 'pre' | 'default' | 'post';

interface ServerToolAutoHookSpec {
  id: string;
  phase: AutoHookPhase;
  priority: number;
  order: number;
}

type ServerToolBuiltinExecutionDescriptor = {
  kind: 'builtin';
  builtinName: string;
};

type ServerToolAdHocExecutionDescriptor = {
  kind: 'adhoc';
  handler: ServerToolHandler;
};

export type ServerToolExecutionDescriptor =
  | ServerToolBuiltinExecutionDescriptor
  | ServerToolAdHocExecutionDescriptor;

export interface ServerToolHandlerEntry {
  name: string;
  trigger: TriggerMode;
  execution: ServerToolExecutionDescriptor;
  registration: ServerToolHandlerRegistrationSpec;
  autoHook?: ServerToolAutoHookSpec;
}

export interface ServerToolAutoHookDescriptor {
  id: string;
  phase: AutoHookPhase;
  priority: number;
  order: number;
  registration: ServerToolHandlerRegistrationSpec;
  execution: ServerToolExecutionDescriptor;
}
