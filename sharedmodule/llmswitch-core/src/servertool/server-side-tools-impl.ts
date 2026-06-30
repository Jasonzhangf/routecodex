import type {
  ServerSideToolEngineOptions,
  ServerSideToolEngineResult
} from './types.js';
import { orchestrateServertoolEngine } from './run-server-side-tool-engine-shell.js';

export const runServerSideToolEngine = orchestrateServertoolEngine as (
  options: ServerSideToolEngineOptions
) => Promise<ServerSideToolEngineResult>;
