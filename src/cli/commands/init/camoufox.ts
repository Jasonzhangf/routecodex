import type { InitProviderTemplate } from '../../config/init-provider-catalog.js';
import { ensureCamoufoxInstalledForInit } from '../../../providers/core/config/camoufox-launcher.js';
import { asRecord } from './basic.js';
import type { InitCommandContext, LoggerLike, ProviderV2Payload, UnknownRecord } from './shared.js';

function providerAuthNeedsCamoufox(authNode: UnknownRecord): boolean {
  const authType = typeof authNode.type === 'string' ? authNode.type.trim().toLowerCase() : '';
  if (authType.includes('oauth') || authType.includes('deepseek-account')) {
    return true;
  }
  if (typeof authNode.tokenFile === 'string' && authNode.tokenFile.trim()) {
    return true;
  }
  const entries = Array.isArray(authNode.entries) ? authNode.entries : [];
  for (const entry of entries) {
    const node = asRecord(entry);
    const entryType = typeof node.type === 'string' ? node.type.trim().toLowerCase() : '';
    if (entryType.includes('oauth') || entryType.includes('deepseek-account')) {
      return true;
    }
    if (typeof node.tokenFile === 'string' && node.tokenFile.trim()) {
      return true;
    }
  }
  return false;
}

function providerNeedsCamoufox(providerNode: UnknownRecord): boolean {
  return providerAuthNeedsCamoufox(asRecord(providerNode.auth));
}

export function shouldPrepareCamoufoxForTemplates(selectedTemplates: InitProviderTemplate[]): boolean {
  return selectedTemplates.some((template) => providerNeedsCamoufox(asRecord(template.provider)));
}

export function shouldPrepareCamoufoxForProviderMap(providerMap: Record<string, ProviderV2Payload>): boolean {
  return Object.values(providerMap).some((payload) => providerNeedsCamoufox(asRecord(payload.provider)));
}

function isInitCamoufoxPrepEnabled(): boolean {
  const raw = String(
    process.env.ROUTECODEX_INIT_CAMOUFOX_PREP ||
      process.env.RCC_INIT_CAMOUFOX_PREP ||
      '1'
  )
    .trim()
    .toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'no';
}

export function maybePrepareCamoufoxEnvironment(
  ctx: InitCommandContext,
  logger: LoggerLike,
  needsCamoufox: boolean,
  options?: { force?: boolean }
): void {
  if (!needsCamoufox) {
    return;
  }
  if (!options?.force && !isInitCamoufoxPrepEnabled()) {
    logger.info('Camoufox environment prep skipped (ROUTECODEX_INIT_CAMOUFOX_PREP=0).');
    return;
  }
  logger.info('Preparing Camoufox environment for OAuth/DeepSeek providers...');
  const prepare = ctx.prepareCamoufoxEnvironment ?? ensureCamoufoxInstalledForInit;
  const ready = prepare();
  if (ready) {
    logger.info('Camoufox environment ready.');
  } else {
    logger.warning(
      'Camoufox is unavailable. Install Python + camoufox, or run OAuth/DeepSeek auth once dependencies are ready.'
    );
  }
}
