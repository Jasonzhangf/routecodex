interface TokenPortalPageProps {
  provider: string;
  alias: string;
  tokenFile: string;
  sessionId: string;
  oauthUrl: string;
  displayName?: string;
  fingerprint?: {
    profileId: string;
    os?: string;
    arch?: string;
    suffix?: string;
    navigatorPlatform?: string;
    navigatorOscpu?: string;
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderTokenPortalPage(props: TokenPortalPageProps): string {
  const { provider, alias, tokenFile, sessionId, oauthUrl, displayName, fingerprint } = props;
  const providerLabel = displayName ? `${displayName} (${provider})` : provider;

  const fingerprintHtml = (() => {
    if (!fingerprint || !fingerprint.profileId) {
      return '';
    }
    const suffix = fingerprint.suffix || (fingerprint.os && fingerprint.arch ? `${fingerprint.os}/${fingerprint.arch}` : '');
    const parts: string[] = [];
    parts.push(`<div><span>Camoufox profile:</span> ${escapeHtml(fingerprint.profileId)}</div>`);
    if (suffix) {
      parts.push(`<div><span>Fingerprint OS/Arch:</span> ${escapeHtml(suffix)}</div>`);
    }
    if (fingerprint.navigatorPlatform) {
      parts.push(`<div><span>navigator.platform:</span> ${escapeHtml(fingerprint.navigatorPlatform)}</div>`);
    }
    if (fingerprint.navigatorOscpu) {
      parts.push(`<div><span>navigator.oscpu:</span> ${escapeHtml(fingerprint.navigatorOscpu)}</div>`);
    }
    return parts.length
      ? `<div class="meta" style="margin-top:10px">${parts.join('')}</div>`
      : '';
  })();

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>RouteCodex Token Auth</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 40px; color: #1f2933; background:#f8fafc; }
      .card { border: 1px solid #e2e8f0; border-radius: 16px; padding: 28px; max-width: 640px; background:#fff; box-shadow: 0 25px 50px -12px rgba(15,23,42,0.25); }
      .title { font-size: 26px; margin-bottom: 16px; font-weight: 600; color:#0f172a; }
      .meta { margin-bottom: 18px; line-height: 1.7; }
      .meta div { margin-bottom:4px; }
      .meta span { font-weight: 600; color:#475569; margin-right:6px; }
      button { background: linear-gradient(135deg,#2563eb,#4f46e5); color: white; border: none; border-radius: 10px; padding: 14px 26px; font-size: 16px; font-weight:600; cursor: pointer; transition: transform .1s ease; }
      button:hover { transform: translateY(-1px); }
      button:disabled { opacity: 0.6; cursor: not-allowed; }
      .hint { color: #475569; margin-top: 18px; font-size: 14px; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="title">Authorize Token</div>
      <div class="meta">
        <div><span>Provider:</span> ${escapeHtml(providerLabel)}</div>
        <div><span>Alias:</span> ${escapeHtml(alias || 'default')}</div>
        <div><span>Token file:</span> ${escapeHtml(tokenFile)}</div>
        <div><span>Session ID:</span> ${escapeHtml(sessionId)}</div>
      </div>
      ${fingerprintHtml}
      <button id="continue-btn">Continue to OAuth</button>
      <div class="hint">
        RouteCodex shows this page before contacting the upstream OAuth portal so you know exactly which credential is being refreshed.
      </div>
    </div>
    <script>
      const btn = document.getElementById('continue-btn');
      const oauthUrl = ${JSON.stringify(oauthUrl)};
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        btn.disabled = true;
        btn.innerText = 'Opening OAuth…';
        window.location.href = oauthUrl;
      });
    </script>
  </body>
</html>`;
}
