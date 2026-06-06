import {
  readServertoolCliTicket,
  type ServertoolCliTicket
} from './cli-ticket.js';

export interface ServertoolCliExecutionResult {
  ok: boolean;
  kind: string;
  tool: string;
  summary: string;
  result?: unknown;
}

export async function executeServertoolCliTicket(ticketId: string): Promise<ServertoolCliExecutionResult> {
  const ticket = readServertoolCliTicket(ticketId);
  return executeServertoolCliTicketObject(ticket);
}

export async function executeServertoolCliTicketObject(ticket: ServertoolCliTicket): Promise<ServertoolCliExecutionResult> {
  if (ticket.executor.kind === 'stop_message_auto') {
    return {
      ok: true,
      kind: 'stop_message_auto',
      tool: ticket.executor.toolName,
      summary: ticket.presentation.stdoutPreview || 'servertool continuation ready'
    };
  }
  if (ticket.executor.kind === 'fixture') {
    return {
      ok: true,
      kind: 'fixture',
      tool: ticket.executor.toolName,
      summary: ticket.presentation.stdoutPreview || 'fixture servertool executed',
      result: ticket.executor.arguments
    };
  }
  throw new Error(`[servertool.cli] unsupported executor: ${ticket.executor.kind}`);
}
