import { logOAuthDebug } from '../../../auth/oauth-logger.js';
import {
  ensureValidOAuthToken,
  handleUpstreamInvalidOAuthToken,
  shouldTriggerInteractiveOAuthRepair
} from '../../../auth/oauth-lifecycle.js';
import type { IAuthProvider } from '../../../auth/auth-interface.js';
import type { OAuthAuth } from '../../api/provider-config.js';
import { AuthModeUtils } from './auth-mode-utils.js';

type OAuthAuthExtended = OAuthAuth & { rawType?: string; oauthProviderId?: string; tokenFile?: string };
type OAuthAwareAuthProvider = IAuthProvider & {
  getOAuthClient?: () => { loadToken?: () => void };
};

export interface OAuthHeaderPreflightContext {
  auth: OAuthAuth | { type: string };
  authProvider: IAuthProvider | null;
  oauthProviderId?: string;
}

export class OAuthHeaderPreflight {
  static async ensureTokenReady(context: OAuthHeaderPreflightContext): Promise<void> {
    const auth = context.auth;
    if (AuthModeUtils.normalizeAuthMode(auth.type) !== 'oauth') {
      return;
    }

    const oauthAuth = auth as OAuthAuthExtended;
    const oauthProviderId = context.oauthProviderId || AuthModeUtils.ensureOAuthProviderId(oauthAuth);
    logOAuthDebug('[OAuth] [headers] ensureValid start (silent refresh only)');
    try {
      // 请求前仅尝试静默刷新，不主动打开浏览器；
      // 真正令牌失效由 handleUpstreamInvalidOAuthToken 触发交互式修复。
      await ensureValidOAuthToken(oauthProviderId, oauthAuth, {
        forceReacquireIfRefreshFails: false,
        openBrowser: false,
        forceReauthorize: false
      });
      logOAuthDebug('[OAuth] [headers] ensureValid OK');
    } catch (error) {
      const err = error as { message?: string };
      const msg = err?.message ? String(err.message) : String(error);
      const authErr = (error instanceof Error ? error : new Error(msg)) as Error & {
        statusCode?: number;
        status?: number;
        code?: string;
      };
      const needsInteractiveRepair = shouldTriggerInteractiveOAuthRepair(oauthProviderId, authErr);
      if (needsInteractiveRepair) {
        if (typeof authErr.statusCode !== 'number' && typeof authErr.status !== 'number') {
          authErr.statusCode = 401;
          authErr.status = 401;
        }
        if (typeof authErr.code !== 'string' || !authErr.code.trim()) {
          authErr.code = 'AUTH_INVALID_TOKEN';
        }
        // 非阻塞：后台触发修复，不等待本请求。
        void handleUpstreamInvalidOAuthToken(oauthProviderId, oauthAuth, authErr, {
          allowBlocking: false
        }).catch(() => {
          // ignore background repair errors
        });
        (authErr as Error & { __routecodexAuthPreflightFatal?: boolean }).__routecodexAuthPreflightFatal = true;
        throw authErr;
      }
      // 非认证类的 ensureValid 错误只做日志，避免影响正常流量。
      logOAuthDebug(`[OAuth] [headers] ensureValid skipped: ${msg}`);
    }

    try {
      (context.authProvider as OAuthAwareAuthProvider).getOAuthClient?.()?.loadToken?.();
    } catch {
      // ignore
    }
  }
}
