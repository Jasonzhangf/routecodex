import express from 'express';

const app = express();
app.use(express.json());

const PORT = Number(process.env.API_PORT || 5600);

function checkAuth(req: any, res: any, next: any) {
  const auth = req.headers['authorization'] || '';
  if (!auth) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/v1/models', checkAuth, (_req, res) => {
  res.json({
    data: [
      { id: 'qwen3-coder', object: 'model', created: Date.now(), owned_by: 'mock-iflow' },
    ]
  });
});

app.post('/v1/chat/completions', checkAuth, (req, res) => {
  const model = req.body?.model || 'qwen3-coder';
  const content = 'Hello from mock iFlow';
  res.json({
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }
    ],
    usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }
  });
});

app.listen(PORT, () => {
  console.log(`[mock-iflow-api] listening on http://localhost:${PORT}`);
});

