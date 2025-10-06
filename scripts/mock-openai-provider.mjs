#!/usr/bin/env node
import express from 'express';

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.MOCK_OPENAI_PORT ? Number(process.env.MOCK_OPENAI_PORT) : 7788;

function nowSec() { return Math.floor(Date.now() / 1000); }

app.post('/v1/chat/completions', (req, res) => {
  try {
    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const last = messages[messages.length - 1] || {};

    // If the client sent tool result (OpenAI tool role), return final text
    if (last.role === 'tool') {
      const text = 'Final answer after tool: done.';
      return res.status(200).json({
        id: `chatcmpl_${Date.now()}`,
        object: 'chat.completion',
        created: nowSec(),
        model: body.model || 'mock-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }
        ],
        usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 }
      });
    }

    // Otherwise, return a tool_calls request
    const tc = {
      id: `call_${Math.random().toString(36).slice(2)}`,
      type: 'function',
      function: { name: 'get_current_time', arguments: JSON.stringify({ timezone: 'UTC' }) }
    };
    return res.status(200).json({
      id: `chatcmpl_${Date.now()}`,
      object: 'chat.completion',
      created: nowSec(),
      model: body.model || 'mock-model',
      choices: [
        { index: 0, message: { role: 'assistant', content: '', tool_calls: [tc] }, finish_reason: 'tool_calls' }
      ],
      usage: { prompt_tokens: 40, completion_tokens: 1, total_tokens: 41 }
    });
  } catch (e) {
    res.status(500).json({ error: { message: e?.message || String(e) } });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock OpenAI provider listening on http://127.0.0.1:${PORT}`);
});

