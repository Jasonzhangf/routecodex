import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import type { JsonObject } from '../conversion/hub/types/json.js';

export const SERVERTOOL_CLI_RESULT_CAPTURE_BUILDER = 'capture_servertool_cli_result_02_from_submit_tool_outputs';
export const SERVERTOOL_CLI_RESULT_RESTORE_BUILDER = 'restore_servertool_cli_result_03_to_model_tool_result';

export interface ServertoolCliTicket {
  ticketVersion: 1;
  ticketId: string;
  mode: 'client_cli_projection';
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  entryEndpoint: string;
  requestId: string;
  responseId?: string;
  sessionId?: string;
  conversationId?: string;
  clientTool: {
    name: 'exec_command';
    callId: string;
  };
  modelTool: {
    name: string;
    callId: string;
    synthetic?: boolean;
  };
  executor: {
    kind: 'stop_message_auto' | 'fixture' | string;
    toolName: string;
    arguments: JsonObject;
    capabilities?: string[];
  };
  presentation: {
    reasoningText: string;
    stdoutPreview: string;
  };
}

export interface ServertoolCliTicketScope {
  requestId?: string;
  entryEndpoint?: string;
  sessionId?: string;
  conversationId?: string;
}

const TICKET_TTL_MS = 10 * 60 * 1000;

export function createServertoolCliTicketId(prefix = 'stcli'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

export function createServertoolCliCallId(ticketId: string): string {
  return `rcc_cli_${ticketId}`;
}

export function resolveServertoolCliTicketDir(): string {
  const root = process.env.RCC_HOME || process.env.ROUTECODEX_HOME || path.join(homedir(), '.rcc');
  return path.join(root, 'servertool', 'tickets');
}

export function buildServertoolCliTicket(args: {
  entryEndpoint: string;
  requestId: string;
  responseId?: string;
  sessionId?: string;
  conversationId?: string;
  modelTool: { name: string; callId: string; synthetic?: boolean };
  executor: ServertoolCliTicket['executor'];
  presentation: ServertoolCliTicket['presentation'];
  now?: Date;
}): ServertoolCliTicket {
  const now = args.now ?? new Date();
  const ticketId = createServertoolCliTicketId();
  return {
    ticketVersion: 1,
    ticketId,
    mode: 'client_cli_projection',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TICKET_TTL_MS).toISOString(),
    entryEndpoint: args.entryEndpoint,
    requestId: args.requestId,
    ...(args.responseId ? { responseId: args.responseId } : {}),
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.conversationId ? { conversationId: args.conversationId } : {}),
    clientTool: {
      name: 'exec_command',
      callId: createServertoolCliCallId(ticketId)
    },
    modelTool: args.modelTool,
    executor: args.executor,
    presentation: args.presentation
  };
}

export function writeServertoolCliTicket(ticket: ServertoolCliTicket): void {
  assertValidTicket(ticket);
  const dir = resolveServertoolCliTicketDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = resolveTicketPath(ticket.ticketId);
  if (fs.existsSync(filePath) || fs.existsSync(resolveConsumedTicketPath(ticket.ticketId))) {
    throw new Error(`[servertool.cli] ticket already exists: ${ticket.ticketId}`);
  }
  fs.writeFileSync(filePath, `${JSON.stringify(ticket, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

export function readServertoolCliTicket(ticketId: string): ServertoolCliTicket {
  const ticket = readTicketFile(resolveTicketPath(ticketId));
  assertTicketFresh(ticket);
  return ticket;
}

export function consumeServertoolCliTicket(args: {
  ticketId: string;
  clientCallId: string;
  scope?: ServertoolCliTicketScope;
}): ServertoolCliTicket {
  const filePath = resolveTicketPath(args.ticketId);
  const ticket = readTicketFile(filePath);
  assertTicketFresh(ticket);
  if (ticket.clientTool.callId !== args.clientCallId) {
    throw new Error(`[servertool.cli] ticket client call mismatch: ${args.ticketId}`);
  }
  assertTicketScope(ticket, args.scope);
  const consumed: ServertoolCliTicket = {
    ...ticket,
    consumedAt: new Date().toISOString()
  };
  const consumedPath = resolveConsumedTicketPath(args.ticketId);
  fs.writeFileSync(consumedPath, `${JSON.stringify(consumed, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  fs.unlinkSync(filePath);
  return consumed;
}

export function tryRestoreServertoolCliToolOutputs(
  payload: JsonObject,
  scope?: ServertoolCliTicketScope
): { restored: boolean; payload: JsonObject } {
  const toolOutputs = Array.isArray((payload as Record<string, unknown>).tool_outputs)
    ? ((payload as Record<string, unknown>).tool_outputs as unknown[])
    : [];
  if (!toolOutputs.some((entry) => isRccCliToolOutput(entry))) {
    return { restored: false, payload };
  }
  const next = JSON.parse(JSON.stringify(payload)) as JsonObject;
  const nextOutputs = ((next as Record<string, unknown>).tool_outputs as unknown[]).map((entry) => {
    if (!isRccCliToolOutput(entry)) {
      return entry;
    }
    const row = entry as Record<string, unknown>;
    const clientCallId = String(row.call_id);
    const ticketId = clientCallId.slice('rcc_cli_'.length);
    const ticket = consumeServertoolCliTicket({ ticketId, clientCallId, scope });
    return {
      ...row,
      call_id: ticket.modelTool.callId,
      tool_call_id: ticket.modelTool.callId,
      name: ticket.modelTool.name
    };
  });
  (next as Record<string, unknown>).tool_outputs = nextOutputs;
  return { restored: true, payload: next };
}

function isRccCliToolOutput(entry: unknown): boolean {
  return Boolean(
    entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      typeof (entry as Record<string, unknown>).call_id === 'string' &&
      ((entry as Record<string, unknown>).call_id as string).startsWith('rcc_cli_stcli_')
  );
}

function resolveTicketPath(ticketId: string): string {
  assertSafeTicketId(ticketId);
  return path.join(resolveServertoolCliTicketDir(), `${ticketId}.json`);
}

function resolveConsumedTicketPath(ticketId: string): string {
  assertSafeTicketId(ticketId);
  return path.join(resolveServertoolCliTicketDir(), `${ticketId}.consumed.json`);
}

function readTicketFile(filePath: string): ServertoolCliTicket {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'unknown');
    throw new Error(`[servertool.cli] ticket read failed: ${message}`);
  }
  assertValidTicket(parsed);
  return parsed;
}

function assertSafeTicketId(ticketId: string): void {
  if (!/^stcli_[a-f0-9]{32}$/.test(ticketId)) {
    throw new Error(`[servertool.cli] invalid ticket id: ${ticketId}`);
  }
}

function assertValidTicket(value: unknown): asserts value is ServertoolCliTicket {
  const ticket = value && typeof value === 'object' && !Array.isArray(value) ? value as ServertoolCliTicket : null;
  if (!ticket || ticket.ticketVersion !== 1 || ticket.mode !== 'client_cli_projection') {
    throw new Error('[servertool.cli] invalid ticket schema');
  }
  assertSafeTicketId(ticket.ticketId);
  if (ticket.clientTool?.name !== 'exec_command' || ticket.clientTool.callId !== createServertoolCliCallId(ticket.ticketId)) {
    throw new Error('[servertool.cli] invalid client tool identity');
  }
  if (!ticket.modelTool?.name || !ticket.modelTool.callId) {
    throw new Error('[servertool.cli] missing model tool identity');
  }
  if (!ticket.executor?.kind || !ticket.executor.toolName || !ticket.executor.arguments || typeof ticket.executor.arguments !== 'object') {
    throw new Error('[servertool.cli] missing executor');
  }
}

function assertTicketFresh(ticket: ServertoolCliTicket): void {
  const expiresAt = Date.parse(ticket.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error(`[servertool.cli] ticket expired: ${ticket.ticketId}`);
  }
}

function assertTicketScope(ticket: ServertoolCliTicket, scope: ServertoolCliTicketScope | undefined): void {
  if (!scope) {
    return;
  }
  for (const key of ['entryEndpoint', 'sessionId', 'conversationId'] as const) {
    const expected = scope[key];
    if (expected && ticket[key] && expected !== ticket[key]) {
      throw new Error(`[servertool.cli] ticket scope mismatch: ${key}`);
    }
  }
}
