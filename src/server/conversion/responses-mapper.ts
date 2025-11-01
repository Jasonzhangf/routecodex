/**
 * Minimal Responses payload enrichment.
 * The goal is to preserve payloads and attach lightweight metadata when provided.
 */
export class ResponsesMapper {
  static async enrichResponsePayload(
    base: Record<string, unknown>,
    _source?: Record<string, unknown>,
    reqMeta?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = { ...(base || {}) };
    try {
      // Attach request tools metadata if present (do not mutate shapes)
      if (reqMeta && typeof reqMeta === 'object') {
        const metaIn = (out as any).metadata && typeof (out as any).metadata === 'object' ? { ...(out as any).metadata } : {};
        if ((reqMeta as any).tools !== undefined && metaIn.tools === undefined) {
          metaIn.tools = (reqMeta as any).tools;
          try {
            const crypto = await import('crypto');
            const str = JSON.stringify(metaIn.tools);
            const hash = crypto.createHash('sha256').update(str).digest('hex');
            (metaIn as any).tools_hash = hash;
            if (Array.isArray(metaIn.tools)) {(metaIn as any).tools_count = (metaIn.tools as any[]).length;}
          } catch { /* ignore */ }
        }
        if ((reqMeta as any).tool_choice !== undefined && metaIn.tool_choice === undefined) {
          metaIn.tool_choice = (reqMeta as any).tool_choice;
        }
        if ((reqMeta as any).parallel_tool_calls !== undefined && metaIn.parallel_tool_calls === undefined) {
          metaIn.parallel_tool_calls = (reqMeta as any).parallel_tool_calls;
        }
        (out as any).metadata = metaIn;
      }
    } catch { /* ignore enrichment errors */ }
    return out;
  }
}

