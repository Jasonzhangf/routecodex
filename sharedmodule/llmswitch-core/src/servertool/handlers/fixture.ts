import { registerServerToolHandler } from '../registry.js';
import type { ServerToolHandler } from '../types.js';

export const servertoolFixtureHandler: ServerToolHandler = async () => null;

registerServerToolHandler('servertool_fixture', servertoolFixtureHandler, {
  trigger: 'tool_call'
});
