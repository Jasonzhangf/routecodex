export function normalizeChatRequest(request: any): any {
  if (!request || typeof request !== 'object') return request;
  const normalized = { ...request };

  if (Array.isArray(normalized.messages)) {
    normalized.messages = normalized.messages.map((msg: any) => normalizeMessage(msg));
  }

  if (Array.isArray(normalized.tools)) {
    normalized.tools = normalized.tools.map((tool: any) => normalizeTool(tool));
  }

  return normalized;
}

export function normalizeChatResponse(res: any): any {
  if (!res || typeof res !== 'object') return res;
  const out = { ...res };
  if (Array.isArray(out.choices)) {
    out.choices = out.choices.map((c: any) => {
      const choice = { ...c };
      const msg = choice.message && typeof choice.message === 'object' ? { ...choice.message } : choice.message;
      if (msg && typeof msg === 'object') {
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
          // Always normalize tool_calls
          msg.tool_calls = msg.tool_calls.map((tc: any) => normalizeToolCall(tc));
          // Preserve assistant textual content when present (flatten arrays), instead of forcing empty
          if (typeof msg.content === 'string') {
            // keep as-is
          } else if (Array.isArray(msg.content)) {
            const parts = (msg.content as any[])
              .map((p: any) => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : '')))
              .filter((s: string) => !!s.trim());
            msg.content = parts.join('\n');
          } else if (msg.content === undefined || msg.content === null) {
            msg.content = '';
          }
        } else if (Array.isArray(msg.content)) {
          const parts = msg.content
            .map((p: any) => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : '')))
            .filter((s: string) => !!s.trim());
          msg.content = parts.join('\n');
        } else if (msg.content === undefined || msg.content === null) {
          msg.content = '';
        }
        choice.message = msg;
      }
      return choice;
    });
  }
  return out;
}

function normalizeMessage(message: any): any {
  if (!message || typeof message !== 'object') return message;
  const normalizedMessage = { ...message };

  if (normalizedMessage.content === undefined || normalizedMessage.content === null) {
    normalizedMessage.content = '';
  } else if (typeof normalizedMessage.content === 'string') {
    // ok
  } else if (Array.isArray(normalizedMessage.content)) {
    // keep structured array
  } else if (typeof normalizedMessage.content === 'object') {
    // keep structured object
  } else {
    normalizedMessage.content = String(normalizedMessage.content);
  }

  if (normalizedMessage.role === 'assistant' && Array.isArray(normalizedMessage.tool_calls)) {
    normalizedMessage.tool_calls = normalizedMessage.tool_calls.map((toolCall: any) => normalizeToolCall(toolCall));
  }

  return normalizedMessage;
}

function normalizeTool(tool: any): any {
  if (!tool || typeof tool !== 'object') return tool;
  const normalizedTool = { ...tool };
  if (normalizedTool.type === 'function' && normalizedTool.function) {
    const fn = { ...normalizedTool.function };
    if (fn.parameters && typeof fn.parameters !== 'object') {
      try { fn.parameters = JSON.parse(String(fn.parameters)); } catch { fn.parameters = {}; }
    }
    normalizedTool.function = fn;
  }
  return normalizedTool;
}

function normalizeToolCall(tc: any): any {
  if (!tc || typeof tc !== 'object') return tc;
  const t = { ...tc };
  if (t.function && typeof t.function === 'object') {
    const fn = { ...t.function };
    if (fn.arguments !== undefined && typeof fn.arguments !== 'string') {
      try { fn.arguments = JSON.stringify(fn.arguments); } catch { fn.arguments = String(fn.arguments); }
    }
    t.function = fn;
  }
  return t;
}
