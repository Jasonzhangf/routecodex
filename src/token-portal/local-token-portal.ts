import http from 'http';
import { URL } from 'url';
import { HTTP_PROTOCOLS, LOCAL_HOSTS } from '../constants/index.js';
import { renderTokenPortalPage } from './render.js';

interface AddressInfo {
  port: number;
}

class LocalTokenPortalServer {
  private server: http.Server | null = null;
  private port: number | null = null;
  private baseUrl: string | null = null;

  get currentPort(): number | null {
    return this.port;
  }

  async ensureRunning(): Promise<string> {
    if (this.server && this.port && this.baseUrl) {
      return this.baseUrl;
    }
    await this.startServer();
    if (!this.baseUrl) {
      throw new Error('Failed to initialize local token portal');
    }
    return this.baseUrl;
  }

  async shutdown(): Promise<void> {
    if (!this.server) {
      return;
    }
    const srv = this.server;
    await new Promise<void>((resolve) => {
      srv.close(() => resolve());
    });
    this.server = null;
    this.port = null;
    this.baseUrl = null;
  }

  private async startServer(): Promise<void> {
    if (this.server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((error) => {
          res.statusCode = 500;
          res.end(`Token portal error: ${error instanceof Error ? error.message : String(error)}`);
        });
      });
      srv.on('error', (error) => {
        reject(error);
      });
      srv.listen(0, '127.0.0.1', () => {
        const address = srv.address() as AddressInfo | null;
        if (!address?.port) {
          reject(new Error('Failed to obtain token portal port'));
          return;
        }
        this.server = srv;
        this.port = address.port;
        this.baseUrl = `${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.IPV4}:${address.port}/token-auth/demo`;
        resolve();
      });
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!req.url) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    const url = new URL(req.url, `${HTTP_PROTOCOLS.HTTP}${LOCAL_HOSTS.IPV4}`);
    if (url.pathname !== '/token-auth/demo') {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    const provider = url.searchParams.get('provider') || 'unknown-provider';
    const alias = url.searchParams.get('alias') || 'default';
    const tokenFile = url.searchParams.get('tokenFile') || '~/.routecodex/auth/unknown-token.json';
    const oauthUrl =
      url.searchParams.get('oauthUrl') || 'https://accounts.google.com/o/oauth2/v2/auth';
    const sessionId = url.searchParams.get('sessionId') || 'local-session';
    const displayName = url.searchParams.get('displayName') || undefined;

    const html = renderTokenPortalPage({
      provider,
      alias,
      tokenFile,
      oauthUrl,
      sessionId,
      displayName
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(html);
  }
}

const localPortal = new LocalTokenPortalServer();

export async function ensureLocalTokenPortalEnv(): Promise<string> {
  const baseUrl = await localPortal.ensureRunning();
  process.env.ROUTECODEX_TOKEN_PORTAL_BASE = baseUrl;
  process.env.ROUTECODEX_HTTP_HOST = LOCAL_HOSTS.IPV4;
  if (localPortal.currentPort) {
    process.env.ROUTECODEX_HTTP_PORT = String(localPortal.currentPort);
  }
  return baseUrl;
}

export async function shutdownLocalTokenPortalEnv(): Promise<void> {
  await localPortal.shutdown();
  delete process.env.ROUTECODEX_TOKEN_PORTAL_BASE;
  delete process.env.ROUTECODEX_HTTP_HOST;
  delete process.env.ROUTECODEX_HTTP_PORT;
}
