import { WindsurfChatProvider } from '../src/providers/core/runtime/windsurf-chat-provider.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const deps: any = {
  logger: { logModule: () => {}, logProviderRequest: () => {} },
  errorHandlingCenter: { handleError: async () => {} },
};

function resolveProbeApiKey(): string {
  if (process.env.WINDSURF_API_KEY) return process.env.WINDSURF_API_KEY;
  const authFile = process.env.WINDSURF_AUTH_FILE || path.join(os.homedir(), '.rcc/auth/windsurf-ws-pro-1.json');
  const raw = fs.readFileSync(authFile, 'utf8');
  const parsed = JSON.parse(raw) as { apiKey?: unknown; sessionToken?: unknown };
  const key = typeof parsed.apiKey === 'string' && parsed.apiKey.trim()
    ? parsed.apiKey.trim()
    : typeof parsed.sessionToken === 'string' && parsed.sessionToken.trim()
      ? parsed.sessionToken.trim()
      : '';
  if (!key) throw new Error(`windsurf probe auth file missing apiKey/sessionToken: ${authFile}`);
  return key;
}

const apiKey = resolveProbeApiKey();
const lsPort = Number(process.env.WINDSURF_LS_PORT || 42101);
const csrfToken = process.env.WINDSURF_CSRF_TOKEN || 'windsurf-api-csrf-fixed-token';
const workspacePath = process.env.WINDSURF_WORKSPACE_PATH || process.cwd();
const workspaceUri = 'file://' + workspacePath;

function createProvider(): any {
  return new WindsurfChatProvider({
    type: 'openai-standard',
    config: {
      providerType: 'openai',
      baseUrl: '',
      model: 'gpt-5.3-codex',
      auth: { type: 'apikey', apiKey, rawType: 'windsurf-devin-token' },
      extensions: { windsurf: { lsPort, csrfToken, workspacePath, workspaceUri, sessionId: 'probe-root' } },
    },
  } as any, deps) as any;
}

async function main() {
  if (!apiKey) throw new Error('WINDSURF_API_KEY required');
  const provider = createProvider();
  provider.setPinnedGrpcRuntime({ lsPort, csrfToken, workspacePath, workspaceUri });
  const sid = 'probe-' + Date.now();

  const cascadeId: string = await provider['sendStartCascade']({ apiKey, sessionId: sid });
  console.log('cascadeId=' + cascadeId);

  await provider['sendCascadeMessage']({ apiKey, cascadeId, text: 'say hello', sessionId: sid, modelEnum: 80, modelUid: 'gpt-5-4-medium', nativeMode: false, nativeAllowlist: [], additionalSteps: [], mcpMode: false })
    .then(() => console.log('send1=ok'))
    .catch((e: any) => console.log('send1=error:' + (e?.code || e?.message)));

  for (let i = 0; i < 30; i++) {
    try {
      const raw: Buffer = await provider['grpcUnaryLocal']('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps', provider['buildGetTrajectoryStepsRequest'](cascadeId, 0), 10_000);
      const steps = provider['parseTrajectorySteps'](raw);
      const statusRaw: Buffer = await provider['grpcUnaryLocal']('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory', provider['buildGetTrajectoryRequest'](cascadeId), 10_000);
      const status = provider['parseTrajectoryStatus'](statusRaw);
      console.log('poll ' + i + ': status=' + status + ' steps=' + steps.length + ' last=' + JSON.stringify(steps[steps.length - 1]).slice(0, 200));
      if (status === 2) break;
    } catch (e: any) { console.log('poll-error: ' + (e?.message || String(e))); break; }
    await new Promise(r => setTimeout(r, 1500));
  }

  // Post-idle: wait for executor to truly settle
  for (let j = 0; j < 20; j++) {
    try {
      const raw: Buffer = await provider['grpcUnaryLocal']('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory', provider['buildGetTrajectoryRequest'](cascadeId), 10_000);
      const st = provider['parseTrajectoryStatus'](raw);
      console.log('post-idle ' + j + ': status=' + st);
      if (st === 0) { console.log('executor settled'); break; }
    } catch (e: any) { console.log('post-idle-error: ' + (e?.message || String(e))); break; }
    await new Promise(r => setTimeout(r, 2000));
  }

  await provider['sendCascadeMessage']({ apiKey, cascadeId, text: 'say goodbye', sessionId: sid, modelEnum: 80, modelUid: 'gpt-5-4-medium', nativeMode: false, nativeAllowlist: [], additionalSteps: [], mcpMode: false })
    .then(() => console.log('send2-reentry=ok'))
    .catch((e: any) => console.log('send2-reentry=error:' + (e?.code || e?.message)));

  const sid2 = 'probe2-' + Date.now();
  const cascadeId2: string = await provider['sendStartCascade']({ apiKey, sessionId: sid2 });
  console.log('cascadeId2=' + cascadeId2);
  console.log('isolation=' + (cascadeId !== cascadeId2));
  await provider.dispose?.();
}

main().catch((e) => { console.error('fatal=' + (e?.stack || e?.message || String(e))); process.exit(1); });
