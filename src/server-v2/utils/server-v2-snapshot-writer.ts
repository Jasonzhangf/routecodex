/**
 * Server V2 Snapshot Writer
 *
 * 按照现有provider和llmswitch-core的snapshot规范实现
 * 支持端点映射和敏感数据遮蔽
 */

import { promises as fs } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import type { UnknownObject } from '../../types/common-types.js';
import { writeSnapshotViaHooks } from '../../modules/llmswitch/bridge.js';

/**
 * Server V2 Snapshot阶段定义
 */
export type ServerV2SnapshotPhase =
  | 'server-entry'           // 请求进入服务器
  | 'server-pre-process'     // 服务器预处理前
  | 'server-post-process'    // 服务器处理后
  | 'server-response'        // 服务器响应前
  | 'server-error'           // 服务器错误
  | 'server-final';          // 最终响应

/**
 * Snapshot写入选项
 */
export interface ServerV2SnapshotOptions {
  phase: ServerV2SnapshotPhase;
  requestId: string;
  data: UnknownObject;
  entryEndpoint?: string;
  error?: Error;
  metadata?: {
    [key: string]: unknown;
  };
}

/**
 * 根据端点映射到文件夹
 */
function mapEndpointToFolder(entryEndpoint?: string): string {
  const ep = String(entryEndpoint || '').toLowerCase();
  if (ep.includes('/v1/responses')) {return 'openai-responses';}
  if (ep.includes('/v1/messages') || ep.includes('/anthropic')) {return 'anthropic-messages';}
  if (ep.includes('/v2/chat/completions')) {return 'server-v2-chat';}
  return 'openai-chat'; // 默认
}

/**
 * 敏感数据遮蔽
 */
function maskSensitiveData(data: UnknownObject): UnknownObject {
  if (typeof data !== 'object' || data === null) {
    return data;
  }

  const result = { ...data };

  // 遮蔽常见的敏感字段
  const sensitiveFields = ['authorization', 'x-api-key', 'api-key', 'password', 'token'];

  if (result.headers && typeof result.headers === 'object') {
    const headers = { ...result.headers } as Record<string, unknown>;
    for (const [key, value] of Object.entries(headers)) {
      const lowerKey = key.toLowerCase();
      if (sensitiveFields.some(field => lowerKey.includes(field))) {
        const str = String(value ?? '');
        const masked = str.length > 12 ? `${str.slice(0, 6)}****${str.slice(-6)}` : '****';
        headers[key] = masked;
      }
    }
    result.headers = headers;
  }

  return result;
}

/**
 * 生成快照文件路径
 */
function generateSnapshotPath(
  phase: ServerV2SnapshotPhase,
  requestId: string,
  entryEndpoint?: string
): string {
  const baseDir = join(homedir(), '.routecodex', 'codex-samples');
  const endpointFolder = mapEndpointToFolder(entryEndpoint);
  const fileName = `${requestId}_server-v2-${phase}.json`;

  return join(baseDir, endpointFolder, fileName);
}

/**
 * 写入Server V2快照
 */
export async function writeServerV2Snapshot(options: ServerV2SnapshotOptions): Promise<void> {
  try {
    const { phase, requestId, data, entryEndpoint, error, metadata } = options;
    // 优先通过 llmswitch-core 的 hooks 快照通道写入，保证与 core 一致
    try {
      const stage = phase === 'server-final' ? 'finalize-post' : (phase === 'server-entry' ? 'request_1_validation_pre' : phase);
      await writeSnapshotViaHooks('server-v2', {
        endpoint: entryEndpoint || '/v1/chat/completions',
        stage,
        requestId,
        data: maskSensitiveData({ ...data, metadata: { ...(metadata||{}), error: error ? { name: error.name, message: error.message } : undefined } }),
        verbosity: 'verbose'
      });
      return;
    } catch {
      // 回退到本地写盘（非首选）
      const snapshotData = {
        timestamp: new Date().toISOString(),
        phase,
        requestId,
        endpoint: entryEndpoint || 'unknown',
        serverVersion: 'v2',
        data: maskSensitiveData(data),
        metadata: {
          ...metadata,
          phase,
          writtenAt: Date.now(),
          ...(error && {
            error: {
              name: error.name,
              message: error.message,
              stack: error.stack
            }
          })
        }
      };
      const filePath = generateSnapshotPath(phase, requestId, entryEndpoint);
      await fs.mkdir(dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(snapshotData, null, 2), 'utf-8');
      console.log(`[ServerV2Snapshot] Snapshot written (fallback): ${filePath}`);
    }
  } catch (writeError) {
    console.error('[ServerV2Snapshot] Failed to write snapshot:', writeError);
    // 快照写入失败不应影响主流程
  }
}

/**
 * 批量写入快照（用于多个阶段的快照）
 */
export async function writeBatchServerV2Snapshots(
  requestId: string,
  snapshots: Array<Omit<ServerV2SnapshotOptions, 'requestId'>>
): Promise<void> {
  const writePromises = snapshots.map(snapshot =>
    writeServerV2Snapshot({
      ...snapshot,
      requestId
    })
  );

  await Promise.allSettled(writePromises);
}

/**
 * 清理过期快照文件
 */
export async function cleanupExpiredSnapshots(
  maxAge: number = 24 * 60 * 60 * 1000, // 默认24小时
  baseDir?: string
): Promise<void> {
  try {
    const snapshotDir = baseDir || join(homedir(), '.routecodex', 'codex-samples');
    const files = await fs.readdir(snapshotDir, { recursive: true });

    const now = Date.now();
    const expiredFiles: string[] = [];

    for (const file of files) {
      const filePath = join(snapshotDir, file);
      try {
        const stats = await fs.stat(filePath);
        if (now - stats.mtime.getTime() > maxAge) {
          expiredFiles.push(filePath);
        }
      } catch {
        // 忽略无法访问的文件
      }
    }

    // 删除过期文件
    for (const expiredFile of expiredFiles) {
      try {
        await fs.unlink(expiredFile);
        console.log(`[ServerV2Snapshot] Cleaned up expired snapshot: ${expiredFile}`);
      } catch {
        // 忽略删除失败
      }
    }

    if (expiredFiles.length > 0) {
      console.log(`[ServerV2Snapshot] Cleaned up ${expiredFiles.length} expired snapshot files`);
    }

  } catch (error) {
    console.error('[ServerV2Snapshot] Failed to cleanup snapshots:', error);
  }
}
