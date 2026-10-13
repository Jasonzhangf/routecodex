export const HARNESS_ID = 'v3.protocol_live_mock_matrix';
export const SCHEMA_VERSION = 1;
export const SOURCE_REPO = 'https://github.com/yetone/magpie';
export const SOURCE_SHA = 'bfaedf18301d02a423bd5422d22e41432d231ab8';
export const SOURCE_LICENSE = 'MIT';

export const PROTOCOLS = Object.freeze(['openai_chat', 'responses', 'anthropic', 'gemini']);
export const CELL_TRANSPORTS = Object.freeze(['json', 'sse']);
export const CELL_MODES = Object.freeze(['direct', 'relay']);
export const SCRIPT_MODES = Object.freeze(['json', 'sse', 'fault']);
export const CLIENT_TRANSPORTS = Object.freeze(['complete', 'closed']);

export class CorpusError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CorpusError';
  }
}
