export function extractHttpStatus(error: any, fallback = 500): number {
  try {
    const direct = Number(error?.statusCode || error?.status || error?.response?.status || NaN);
    if (Number.isFinite(direct) && direct >= 100 && direct <= 599) return direct;
    const candidates: string[] = [];
    if (typeof error?.code === 'string') candidates.push(error.code);
    if (typeof error?.name === 'string') candidates.push(error.name);
    if (typeof error?.message === 'string') candidates.push(error.message);
    try { if (typeof error?.response?.data?.error?.code === 'string') candidates.push(String(error.response.data.error.code)); } catch {}
    try { if (typeof error?.response?.data?.error?.message === 'string') candidates.push(String(error.response.data.error.message)); } catch {}
    for (const s of candidates) {
      const m = String(s).match(/\b(\d{3})\b/);
      if (m) { const n = Number(m[1]); if (n >= 100 && n <= 599) return n; }
    }
  } catch {}
  return fallback;
}

export function normalizeHttpError(error: any): { status: number; code?: string; message: string } {
  const status = extractHttpStatus(error, 500);
  const code = (error && (error.code || error.type)) ? String(error.code || error.type) : undefined;
  const message = error?.message || String(error);
  return { status, code, message };
}

