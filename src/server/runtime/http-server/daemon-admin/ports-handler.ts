/**
 * Admin API: /admin/ports
 *
 * CRUD endpoints for port configuration management.
 * All endpoints reuse existing daemon-admin auth middleware.
 */

import type { Application, Request, Response } from 'express';
import type { PortConfig, PortCreateOrUpdateRequest, PortView, PortListView } from '../port-config-types.js';
import type { PortRegistry } from '../port-registry.js';
import { validatePortConfigs } from '../port-config-validator.js';
import { rejectNonLocalOrUnauthorizedAdmin } from '../daemon-admin-routes.js';

interface PortsHandlerOptions {
  getPortRegistry: () => PortRegistry | null;
  getPortConfigs: () => PortConfig[];
  applyPortConfig: (action: 'add' | 'update' | 'remove', port: number, config?: PortConfig) => Promise<{ ok: boolean; error?: string }>;
  getAvailableProviders: () => Array<{ key: string; family?: string; protocol?: string }>;
}

export function registerPortsRoutes(app: Application, options: PortsHandlerOptions): void {
  app.get('/admin/ports', (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) return;

    const registry = options.getPortRegistry();
    const configs = options.getPortConfigs();

    const ports: PortView[] = configs.map((config) => {
      const runtimeState = registry?.get(config.port);
      return {
        port: config.port,
        host: config.host,
        mode: config.mode,
        routingPolicyGroup: config.routingPolicyGroup,
        protocolBehavior: config.protocolBehavior,
        providerBinding: config.providerBinding,
        status: runtimeState?.status ?? 'stopped',
        activeConnections: runtimeState?.activeConnections ?? 0,
        error: runtimeState?.error,
      };
    });

    res.json({ ports } satisfies PortListView);
  });

  app.put('/admin/ports/:port', async (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) return;

    const portNum = parseInt(req.params.port, 10);
    if (!Number.isInteger(portNum) || portNum < 1024 || portNum > 65535) {
      res.status(400).json({ error: { message: `Invalid port number: ${req.params.port}`, code: 'invalid_port' } });
      return;
    }

    const body = req.body as PortCreateOrUpdateRequest;
    if (!body || !body.mode) {
      res.status(400).json({ error: { message: 'Request body must include "mode" field ("router" or "provider")', code: 'invalid_body' } });
      return;
    }

    const newConfig: PortConfig = {
      port: portNum,
      host: typeof body.host === 'string' && body.host.trim() ? body.host.trim() : '0.0.0.0',
      mode: body.mode,
      protocolBehavior: body.protocolBehavior,
      providerBinding: body.providerBinding,
      apikey: body.apikey,
      timeout: body.timeout,
      bodyLimit: body.bodyLimit,
    };

    const validation = validatePortConfigs([newConfig]);
    if (!validation.valid) {
      res.status(400).json({ error: { message: 'Port config validation failed', code: 'validation_failed', details: validation.errors } });
      return;
    }

    try {
      const result = await options.applyPortConfig('update', portNum, newConfig);
      if (!result.ok) {
        res.status(500).json({ error: { message: result.error ?? 'Failed to apply port config', code: 'apply_failed' } });
        return;
      }

      const registry = options.getPortRegistry();
      const runtimeState = registry?.get(newConfig.port);
      const view: PortView = {
        port: newConfig.port,
        host: newConfig.host,
        mode: newConfig.mode,
        routingPolicyGroup: newConfig.routingPolicyGroup,
        protocolBehavior: newConfig.protocolBehavior,
        providerBinding: newConfig.providerBinding,
        status: runtimeState?.status ?? 'starting',
        activeConnections: runtimeState?.activeConnections ?? 0,
        error: runtimeState?.error,
      };
      res.json(view);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message: `Failed to apply port config: ${message}`, code: 'apply_error' } });
    }
  });

  app.delete('/admin/ports/:port', async (req: Request, res: Response) => {
    if (rejectNonLocalOrUnauthorizedAdmin(req, res)) return;

    const portNum = parseInt(req.params.port, 10);
    if (!Number.isInteger(portNum)) {
      res.status(400).json({ error: { message: `Invalid port number: ${req.params.port}`, code: 'invalid_port' } });
      return;
    }

    const registry = options.getPortRegistry();
    if (!registry?.has(portNum)) {
      res.status(404).json({ error: { message: `Port ${portNum} not found`, code: 'not_found' } });
      return;
    }

    try {
      const result = await options.applyPortConfig('remove', portNum);
      if (!result.ok) {
        res.status(500).json({ error: { message: result.error ?? 'Failed to remove port', code: 'remove_failed' } });
        return;
      }
      res.json({ ok: true, message: `Port ${portNum} removed` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: { message: `Failed to remove port: ${message}`, code: 'remove_error' } });
    }
  });
}
