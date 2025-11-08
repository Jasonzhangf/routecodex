import crypto from 'crypto';
import net from 'net';
import path from 'path';
import { homedir } from 'os';

import { LOCAL_HOSTS } from "../../../constants/index.js";export function generateCodeVerifier(): string {
  const bytes = crypto.randomBytes(32);
  return bytes.toString('base64url');
}

export function generateCodeChallenge(codeVerifier: string): string {
  const hash = crypto.createHash('sha256').update(codeVerifier).digest();
  return hash.toString('base64url');
}

export function generatePKCEPair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  return { codeVerifier, codeChallenge };
}

export function normalizePath(p: string): string {
  try {
    let out = p;
    if (typeof out === 'string' && out.startsWith('~')) {
      out = path.join(homedir(), out.slice(1));
    }
    if (!path.isAbsolute(out)) {
      out = path.resolve(process.cwd(), out);
    }
    return out;
  } catch {
    return p;
  }
}

export async function findOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, LOCAL_HOSTS.IPV4, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

