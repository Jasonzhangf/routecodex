import crypto from 'node:crypto';
import type { Request, Response } from 'express';

const COOKIE_NAME = 'routecodex_daemon_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24; // 24h

type Session = { expiresAt: number };

const sessions = new Map<string, Session>();

function cleanupExpiredSessions(now: number): void {
  for (const [key, value] of sessions.entries()) {
    if (!value || value.expiresAt <= now) {
      sessions.delete(key);
    }
  }
}

function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = typeof cookieHeader === 'string' ? cookieHeader : '';
  if (!raw) {
    return out;
  }
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) {
      continue;
    }
    out[name] = value;
  }
  return out;
}

export function getDaemonSessionCookieName(): string {
  return COOKIE_NAME;
}

export function isDaemonSessionAuthenticated(req: Request): boolean {
  const now = Date.now();
  cleanupExpiredSessions(now);
  const cookies = parseCookieHeader(req.headers?.cookie);
  const sessionId = cookies[COOKIE_NAME];
  if (!sessionId) {
    return false;
  }
  const entry = sessions.get(sessionId);
  if (!entry) {
    return false;
  }
  if (entry.expiresAt <= now) {
    sessions.delete(sessionId);
    return false;
  }
  return true;
}

export function establishDaemonSession(res: Response): void {
  const now = Date.now();
  cleanupExpiredSessions(now);
  const sessionId = crypto.randomBytes(24).toString('base64url');
  sessions.set(sessionId, { expiresAt: now + SESSION_TTL_MS });

  const attrs = [
    `${COOKIE_NAME}=${sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + String(Math.floor(SESSION_TTL_MS / 1000))
  ];
  res.setHeader('Set-Cookie', attrs.join('; '));
}

export function clearDaemonSession(res: Response): void {
  const attrs = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ];
  res.setHeader('Set-Cookie', attrs.join('; '));
}
