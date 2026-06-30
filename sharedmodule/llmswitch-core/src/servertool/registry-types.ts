import type { ServerToolHandlerRegistrationSpec } from '../native/router-hotpath/native-followup-mainline-semantics.js';

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

export type ServerToolExecutionDescriptor = ServerToolBuiltinExecutionDescriptor;

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
