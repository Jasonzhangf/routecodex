import readline from 'readline';
import path from 'path';
import { homedir } from 'os';
import chalk from 'chalk';
import { ensureValidOAuthToken } from '../providers/auth/oauth-lifecycle.js';
import { TokenDaemon } from './token-daemon.js';
import { collectTokenSnapshot } from './token-utils.js';
import {
  formatTokenLabel,
  type TokenDescriptor,
  type TokenUsage
} from './token-types.js';
import {
  buildServerAuthSnapshot,
  detectLocalServerInstance,
  type ServerAuthSnapshot
} from './server-utils.js';

export { TokenDaemon };

// --- shared helpers ---

function normalizeTokenFilePath(p: string): string {
  const expanded = p.startsWith('~/') ? p.replace(/^~\//, `${homedir()}/`) : p;
  return path.resolve(expanded);
}

function computeTokenUsageForServer(
  token: TokenDescriptor,
  serverSnapshot: ServerAuthSnapshot | null
): TokenUsage[] {
  if (!serverSnapshot) {
    return [];
  }
  const normalizedTokenPath = normalizeTokenFilePath(token.filePath);
  const usages: TokenUsage[] = [];
  for (const p of serverSnapshot.providers) {
    if (p.auth.kind !== 'oauth' || !p.auth.tokenFile) {
      continue;
    }
    const authPath = normalizeTokenFilePath(p.auth.tokenFile);
    if (authPath === normalizedTokenPath) {
      usages.push({
        serverId: serverSnapshot.server.id,
        providerId: p.id,
        protocol: p.protocol
      });
    }
  }
  return usages;
}

// --- combined status (legacy) ---

export async function printStatus(json = false): Promise<void> {
  const snapshot = await collectTokenSnapshot();
  const serverSnapshot = await buildServerAuthSnapshot();

  if (json) {
    console.log(
      JSON.stringify(
        {
          tokens: snapshot,
          servers: serverSnapshot
        },
        null,
        2
      )
    );
    return;
  }

  const rows: string[] = [];
  rows.push('🌙 Token Refresh Daemon - Snapshot');
  rows.push(`Timestamp: ${new Date(snapshot.timestamp).toISOString()}`);
  rows.push('');
  rows.push('== Tokens ==');
  rows.push('| Provider       | File / Alias                        | Status    | Expires At                | Remaining |');
  rows.push('|----------------|--------------------------------------|-----------|---------------------------|-----------|');

  for (const providerSnapshot of snapshot.providers) {
    for (const token of providerSnapshot.tokens) {
      const label = formatTokenLabel(token);
      const expires = token.state.expiresAt ? new Date(token.state.expiresAt).toISOString() : '-';
      let remaining = '-';
      if (token.state.msUntilExpiry !== null) {
        const minutes = Math.round(token.state.msUntilExpiry / 60_000);
        remaining = `${minutes} min`;
      }
      const status = token.state.status;
      rows.push(
        `| ${providerSnapshot.provider.padEnd(14)} | ${label.padEnd(36)} | ${status.padEnd(
          9
        )} | ${expires.padEnd(25)} | ${remaining.padEnd(9)} |`
      );
    }
  }

  rows.push('');
  rows.push('== Servers ==');
  if (!serverSnapshot) {
    rows.push('(no local server config detected)');
  } else {
    const s = serverSnapshot.server;
    rows.push(`Server: ${s.baseUrl} (${s.status})`);
    rows.push(`Config: ${s.configPath}`);
    rows.push('');
    rows.push('| Provider       | Protocol  | Auth Kind | Details                           |');
    rows.push('|----------------|-----------|-----------|-----------------------------------|');
    for (const p of serverSnapshot.providers) {
      const authKind = p.auth.kind;
      let details = '';
      if (authKind === 'apikey') {
        const src = p.auth.apiKeySource ?? '-';
        details = `source=${src}` + (p.auth.apiKeyPreview ? ` value=${p.auth.apiKeyPreview}` : '');
      } else if (authKind === 'oauth') {
        details = `tokenFile=${p.auth.tokenFile ?? '-'}`;
      } else {
        details = '-';
      }
      rows.push(
        `| ${p.id.padEnd(14)} | ${p.protocol.padEnd(9)} | ${authKind.padEnd(9)} | ${details.padEnd(33)} |`
      );
    }
  }

  console.log(rows.join('\n'));
}

// --- servers view ---

export async function printServers(json = false): Promise<void> {
  const info = await detectLocalServerInstance();
  if (json) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  if (!info) {
    console.log('No local RouteCodex server configuration detected');
    return;
  }
  console.log('== Servers ==');
  console.log(`Server: ${info.baseUrl} (${info.status})`);
  console.log(`Config: ${info.configPath}`);
}

// --- providers view ---

export async function printProviders(json = false): Promise<void> {
  const serverSnapshot = await buildServerAuthSnapshot();
  if (json) {
    console.log(JSON.stringify(serverSnapshot, null, 2));
    return;
  }
  if (!serverSnapshot) {
    console.log('No local RouteCodex server configuration detected');
    return;
  }

  const s = serverSnapshot.server;
  const rows: string[] = [];
  rows.push('== Servers ==');
  rows.push(`Server: ${s.baseUrl} (${s.status})`);
  rows.push(`Config: ${s.configPath}`);
  rows.push('');
  rows.push('| Provider       | Protocol  | Auth Kind | Details                           |');
  rows.push('|----------------|-----------|-----------|-----------------------------------|');
  for (const p of serverSnapshot.providers) {
    const authKind = p.auth.kind;
    let details = '';
    if (authKind === 'apikey') {
      const src = p.auth.apiKeySource ?? '-';
      details = `source=${src}` + (p.auth.apiKeyPreview ? ` value=${p.auth.apiKeyPreview}` : '');
    } else if (authKind === 'oauth') {
      details = `tokenFile=${p.auth.tokenFile ?? '-'}`;
    } else {
      details = '-';
    }
    rows.push(
      `| ${p.id.padEnd(14)} | ${p.protocol.padEnd(9)} | ${authKind.padEnd(9)} | ${details.padEnd(33)} |`
    );
  }
  console.log(rows.join('\n'));
}

// --- tokens view ---

export async function printTokens(json = false): Promise<void> {
  const snapshot = await collectTokenSnapshot();
  const serverSnapshot = await buildServerAuthSnapshot();

  if (json) {
    const enrichedProviders = snapshot.providers.map((providerSnapshot) => ({
      provider: providerSnapshot.provider,
      tokens: providerSnapshot.tokens.map((token) => ({
        ...token,
        usedBy: computeTokenUsageForServer(token, serverSnapshot)
      }))
    }));
    console.log(
      JSON.stringify(
        {
          timestamp: snapshot.timestamp,
          providers: enrichedProviders
        },
        null,
        2
      )
    );
    return;
  }

  const rows: string[] = [];
  rows.push('== Tokens ==');
  rows.push('| Provider       | File / Alias                        | Status    | Expires At                | Remaining | Used By              |');
  rows.push('|----------------|--------------------------------------|-----------|---------------------------|-----------|----------------------|');

  for (const providerSnapshot of snapshot.providers) {
    for (const token of providerSnapshot.tokens) {
      const label = formatTokenLabel(token);
      const expires = token.state.expiresAt ? new Date(token.state.expiresAt).toISOString() : '-';
      let remaining = '-';
      if (token.state.msUntilExpiry !== null) {
        const minutes = Math.round(token.state.msUntilExpiry / 60_000);
        remaining = `${minutes} min`;
      }
      const status = token.state.status;
      const usages = computeTokenUsageForServer(token, serverSnapshot);
      const usedBy =
        usages.length === 0
          ? '-'
          : usages
              .map((u) => `${u.serverId}:${u.providerId}`)
              .join(',');
      rows.push(
        `| ${providerSnapshot.provider.padEnd(14)} | ${label.padEnd(36)} | ${status.padEnd(
          9
        )} | ${expires.padEnd(25)} | ${remaining.padEnd(9)} | ${usedBy.padEnd(20)} |`
      );
    }
  }

  console.log(rows.join('\n'));
}

export async function interactiveRefresh(selector: string): Promise<void> {
  const token = await TokenDaemon.findTokenBySelector(selector);
  if (!token) {
    console.error(chalk.red('✗'), `No token found for selector: ${selector}`);
    return;
  }

  const label = formatTokenLabel(token);
  console.log('');
  console.log(chalk.yellow('⚠'), '即将为以下 Token 打开浏览器进行 OAuth 登录:');
  console.log(`  Provider : ${token.provider}`);
  console.log(`  Sequence : ${token.sequence}`);
  console.log(`  Alias    : ${token.alias || 'default'}`);
  console.log(`  File     : ${token.filePath}`);
  console.log(`  显示名称 : ${label}`);
  console.log('');

  const proceed = await askYesNo('继续并打开浏览器进行认证吗？ (y/N) ');
  if (!proceed) {
    console.log(chalk.blue('ℹ'), '已取消重新认证');
    return;
  }

  const providerType = token.provider;
  const rawType = `${providerType}-oauth`;

  console.log(chalk.blue('ℹ'), '正在启动 OAuth 流程，请在浏览器中完成登录...');

  await ensureValidOAuthToken(
    providerType,
    {
      type: rawType,
      tokenFile: token.filePath
    } as any,
    {
      openBrowser: true,
      forceReauthorize: true,
      forceReacquireIfRefreshFails: true
    }
  );

  console.log(chalk.green('✓'), '认证完成，Token 文件已更新');
}

function askYesNo(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      const normalized = String(answer || '').trim().toLowerCase();
      resolve(normalized === 'y' || normalized === 'yes');
    });
  });
}
