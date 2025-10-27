import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const modPath = path.resolve(__dirname, '../dist/modules/pipeline/modules/llmswitch/conversion/codecs/openai-openai-codec.js');
const { OpenAIOpenAIConversionCodec } = await import(pathToFileURL(modPath).href).catch(async () => {
  // fallback to relative import if needed
  return await import('../dist/modules/pipeline/modules/llmswitch/conversion/codecs/openai-openai-codec.js');
});

function pathToFileURL(p) {
  const u = new URL('file://');
  const abs = path.resolve(p);
  u.pathname = abs.split(path.sep).map(encodeURIComponent).join('/');
  return u;
}

const deps = { logger: { logModule(){}, logTransformation(){} }, errorHandlingCenter: {}, debugCenter: {} };
const codec = new OpenAIOpenAIConversionCodec(deps);
await codec.initialize?.();

const payload = {
  model: 'glm-4.6',
  tools: [
    {
      type: 'function',
      function: {
        name: 'shell',
        description: 'Runs a shell command',
        strict: false,
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'array', items: { type: 'string' } },
            workdir: { type: 'string' },
            timeout_ms: { type: 'number' }
          },
          required: ['command'],
          additionalProperties: true
        }
      }
    }
  ],
  messages: [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call1',
          type: 'function',
          function: {
            name: 'shell',
            arguments: JSON.stringify({
              'dist/*': 'not -path',
              command: ['find', '.', '-name'],
              'README.md': 'not -path',
              'node_modules/*': 'not -path'
            })
          }
        }
      ]
    }
  ]
};

const profile = { id: 'p1', incomingProtocol: 'openai', outgoingProtocol: 'openai' };
const context = { requestId: 'req_test', endpoint: '/v1/chat/completions', entryEndpoint: '/v1/chat/completions', metadata: {} };

const out = await codec.convertRequest(payload, profile, context);

const calls = out?.messages?.find(m => m?.role === 'assistant')?.tool_calls || [];
const fnArgs = calls[0]?.function?.arguments || '{}';
let parsed;
try { parsed = JSON.parse(fnArgs); } catch { parsed = {}; }

console.log(JSON.stringify({
  argv: parsed?.command,
  hasDist: parsed?.command?.includes('dist/*'),
  hasNodeModules: parsed?.command?.includes('node_modules/*'),
  hasReadme: parsed?.command?.includes('README.md'),
  raw: parsed
}, null, 2));

