/**
 * Port Registry — Multi-port lifecycle management
 *
 * Each port gets its own Express app + HTTP Server instance.
 * Router-mode ports get full HubPipeline; Provider-mode ports get direct pipeline.
 * Hot-add/remove/update ports without restarting other ports.
 */

import type { Application } from 'express';
import type { Server } from 'http';
import type { Socket } from 'node:net';
import type { PortConfig, PortRuntimeState, PortStatus } from './port-config-types.js';

export interface PortInstance {
  config: PortConfig;
  app: Application;
  server?: Server;
  sockets: Set<Socket>;
  status: PortStatus;
  activeConnections: number;
  error?: string;
}

export class PortRegistry {
  private readonly instances = new Map<number, PortInstance>();

  get ports(): number[] {
    return [...this.instances.keys()];
  }

  get(port: number): PortInstance | undefined {
    return this.instances.get(port);
  }

  getActiveConnections(port: number): number {
    return this.instances.get(port)?.activeConnections ?? 0;
  }

  attachServer(port: number, config: PortConfig, server: Server, app: Application): PortInstance {
    const sockets = new Set<Socket>();
    const inst: PortInstance = {
      config,
      app,
      server,
      sockets,
      status: 'running',
      activeConnections: 0,
    };
    this.instances.set(port, inst);

    server.on('connection', (socket: Socket) => {
      sockets.add(socket);
      inst.activeConnections = sockets.size;
      socket.on('close', () => {
        sockets.delete(socket);
        inst.activeConnections = sockets.size;
      });
    });

    server.on('error', (error: Error) => {
      inst.status = 'error';
      inst.error = error.message;
      console.error(`[PortRegistry] Port ${port} error: ${error.message}`);
    });

    console.log(`[PortRegistry] Port ${port} (${config.mode}) registered`);
    return inst;
  }

  markRunning(port: number): void {
    const inst = this.instances.get(port);
    if (inst) {
      inst.status = 'running';
      inst.error = undefined;
    }
  }

  async removePort(port: number): Promise<void> {
    const inst = this.instances.get(port);
    if (!inst) return;
    for (const socket of inst.sockets) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    inst.sockets.clear();
    inst.activeConnections = 0;
    if (inst.server) {
      await new Promise<void>((resolve) => {
        inst.server!.close(() => {
          inst.status = 'stopped';
          inst.server = undefined;
          console.log(`[PortRegistry] Port ${port} stopped`);
          resolve();
        });
      });
    }
    this.instances.delete(port);
  }

  async stopAll(): Promise<void> {
    const ports = [...this.instances.keys()];
    await Promise.allSettled(ports.map((p) => this.removePort(p)));
  }

  has(port: number): boolean {
    return this.instances.has(port);
  }

  get size(): number {
    return this.instances.size;
  }

  snapshot(): PortRuntimeState[] {
    const result: PortRuntimeState[] = [];
    for (const inst of this.instances.values()) {
      result.push({
        port: inst.config.port,
        host: inst.config.host,
        mode: inst.config.mode,
        protocolBehavior: inst.config.protocolBehavior,
        providerBinding: inst.config.providerBinding,
        sameProtocolBehavior: inst.config.sameProtocolBehavior,
        stopMessage: inst.config.stopMessage,
        status: inst.status,
        activeConnections: inst.activeConnections,
        error: inst.error,
      });
    }
    return result;
  }
}
