import type { Application, Request, Response } from 'express';
import type { DaemonAdminRouteOptions } from '../daemon-admin-routes.js';

import { rejectNonLocalOrUnauthorizedAdmin } from '../daemon-admin-routes.js';
import type { HistoricalStatsSnapshot, StatsSnapshot, ProviderStatsView } from '../stats-manager.js';

type TokenTotals = {
  requestCount: number;
  errorCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalOutputTokens: number;
};

function sumTotals(rows: ProviderStatsView[] | undefined): TokenTotals {
  const totals: TokenTotals = {
    requestCount: 0,
    errorCount: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalOutputTokens: 0
  };
  if (!Array.isArray(rows)) {
    return totals;
  }
  for (const row of rows) {
    if (!row) {continue;}
    totals.requestCount += row.requestCount ?? 0;
    totals.errorCount += row.errorCount ?? 0;
    totals.totalPromptTokens += row.totalPromptTokens ?? 0;
    totals.totalCompletionTokens += row.totalCompletionTokens ?? 0;
    totals.totalOutputTokens += row.totalOutputTokens ?? 0;
  }
  return totals;
}

export function registerStatsRoutes(app: Application, options: DaemonAdminRouteOptions): void {
  app.get('/daemon/stats', (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res, options.getExpectedApiKey?.())) {return;}

    if (typeof options.getStatsSnapshot !== 'function') {
      res.status(503).json({ error: { message: 'stats module not available', code: 'not_ready' } });
      return;
    }

    try {
      const snapshot = options.getStatsSnapshot() as {
        session: StatsSnapshot;
        historical: HistoricalStatsSnapshot;
      };

      const sessionTotals = sumTotals(snapshot.session?.totals);
      const historicalTotals = sumTotals(snapshot.historical?.totals);

      res.status(200).json({
        ok: true,
        serverId: options.getServerId(),
        uptimeSec: process.uptime(),
        session: snapshot.session,
        historical: snapshot.historical,
        totals: {
          session: sessionTotals,
          historical: historicalTotals
        }
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message, code: 'stats_failed' } });
    }
  });
}

