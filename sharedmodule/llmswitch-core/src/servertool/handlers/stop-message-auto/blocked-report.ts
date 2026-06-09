import {
  extractStopMessageBlockedReportFromMessagesWithNative,
  type StopMessageBlockedReport
} from '../../../native/router-hotpath/native-servertool-core-semantics.js';

export type { StopMessageBlockedReport };

export function extractBlockedReportFromMessages(messages: unknown[]): StopMessageBlockedReport | null {
  return extractStopMessageBlockedReportFromMessagesWithNative(messages);
}

export function extractBlockedReportFromMessagesForTests(messages: unknown[]): StopMessageBlockedReport | null {
  return extractBlockedReportFromMessages(messages);
}
