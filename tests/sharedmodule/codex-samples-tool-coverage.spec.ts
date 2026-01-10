import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
interface MockRequest {
  body?: {
    tools?: Array<{ function: { name?: string } }>;
    tool_calls?: Array<{ function: { name?: string } }>;
    tool_outputs?: Array<{ tool_call_id: string; output?: any }>;
  };
}
interface MockResponse {
  json?: any;
  status?: number;
}
interface LoadedSamples {