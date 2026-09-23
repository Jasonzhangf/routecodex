#!/bin/sh
# Remote-side installer for the claw RouteCodex V3 deployment.
#
# Executed ON the managed host by scripts/deploy/deploy-claw.sh, which streams
# this file to `bash -s -- <args>`. It owns only this host's layout:
#
#   /opt/rcc/releases/<source-sha>/rccv3   immutable per-commit binary
#   /usr/local/bin/rccv3                   active binary + deployed-sha marker
#   /etc/rcc/{config.toml,provider,secrets,certs}
#   <nginx_conf>                           edge vhost (path from the deploy env)
#   /etc/systemd/system/rccv3.service
#
# It is idempotent and fail-closed: every artifact it overwrites is first
# checked to be either absent or marked as managed by this deployer. An
# unmanaged path aborts the run before any mutation. Every replaced file is
# backed up with a UTC stamp. A config that fails validation, a listener that
# never becomes healthy, or a listener serving a different build_version all
# abort the run.
#
# POSIX sh only: scripts/verify-fast.mjs runs `sh -n` over changed shell files
# and /bin/sh is dash on the Linux CI runner.
#
# Usage: sh remote-install-claw.sh <source_sha> <version> <stage_dir> <domain> <port> \
#          <nginx_conf> <host_symlinks>
#
# <nginx_conf> is the edge vhost path and <host_symlinks> is a space-separated
# list of host paths that must point at the runtime config dir. Both are host
# facts and are supplied by the caller so this file stays host-neutral.

set -eu

source_sha="$1"
version="$2"
stage="$3"
domain="$4"
upstream_port="$5"
nginx_conf="$6"
host_symlinks="$7"

root=/opt/rcc
release="$root/releases/$source_sha"
config_dir=/etc/rcc
unit_path=/etc/systemd/system/rccv3.service
stamp=$(date -u +%Y%m%dT%H%M%SZ)
managed_marker='# Managed by deploy-claw.sh'
# The predecessor deployer (deploy-rcc-claw.sh) marked the same paths with its
# own name. Those paths are still this deployer's responsibility, so its marker
# is accepted as proof of management while this deployer writes its own.
legacy_marker='# Managed by deploy-rcc-claw.sh'
dir_marker='.managed-by-deploy-claw'
legacy_dir_marker='.managed-by-deploy-rcc-claw'

die() {
  printf 'remote-install: FAIL %s\n' "$*" >&2
  exit 1
}
log() {
  printf 'remote-install: %s\n' "$*"
}

# A path is managed when it carries this deployer's marker or the predecessor's.
unit_is_managed() {
  grep -qF "$managed_marker" "$1" || grep -qF "$legacy_marker" "$1"
}

[ -f "$stage/.created-by-deploy-claw" ] || die "refusing unowned stage: $stage"
[ -x "$stage/bin/rccv3" ] || die "staged binary missing: $stage/bin/rccv3"
[ -f "$stage/runtime/config.toml" ] || die "staged config missing"
[ -f "$stage/runtime/secrets/v3/provider-auth.conf" ] || die "staged provider secrets missing"
[ -f "$stage/runtime/edge-api-key" ] || die "staged edge key missing"

# Host facts arrive as arguments; validate their shape before any use.
case "$nginx_conf" in
  /*) ;;
  *) die "nginx_conf must be an absolute path, got: $nginx_conf" ;;
esac

# --- managed-path guards (checked before any mutation) ----------------------
if [ -e "$config_dir" ] \
  && [ ! -f "$config_dir/$dir_marker" ] \
  && [ ! -f "$config_dir/$legacy_dir_marker" ]; then
  die "refusing to replace unmanaged config directory: $config_dir"
fi
if [ -e /usr/local/bin/rccv3 ] && [ ! -f /usr/local/lib/rccv3/deployed-source-sha ]; then
  die "refusing to replace unmanaged /usr/local/bin/rccv3"
fi
if [ -e "$unit_path" ] && ! unit_is_managed "$unit_path"; then
  die "refusing to replace unmanaged service unit: $unit_path"
fi
if [ -e "$nginx_conf" ] && ! unit_is_managed "$nginx_conf"; then
  die "refusing to replace unmanaged Nginx config: $nginx_conf"
fi
[ -x /root/.acme.sh/acme.sh ] || die "acme.sh is not installed on this host"

chmod 0600 "$stage/runtime/edge-api-key"
edge_key=$(cat "$stage/runtime/edge-api-key")
case "$edge_key" in
  *[!0-9a-f]*|'') die "edge key must be one 64-character hex key" ;;
esac
[ ${#edge_key} -eq 64 ] || die "edge key must be one 64-character hex key"

# --- binary -----------------------------------------------------------------
install -d -m 0755 "$release"
install -m 0755 "$stage/bin/rccv3" "$release/rccv3"
printf '%s\n' "$source_sha" > "$release/.routecodex-source-sha"

deployed_version=$("$release/rccv3" --version)
case "$deployed_version" in
  *"$version"*) ;;
  *) die "staged binary reports '$deployed_version' but expected version $version" ;;
esac
log "binary version verified: $deployed_version"

# --- config, providers, secrets --------------------------------------------
if [ -f "$config_dir/$dir_marker" ] || [ -f "$config_dir/$legacy_dir_marker" ]; then
  cp -a "$config_dir" "$config_dir.bak-$stamp"
fi
install -d -m 0750 "$config_dir"
touch "$config_dir/$dir_marker"
rm -f "$config_dir/$legacy_dir_marker"

if [ -e "$config_dir/config.toml" ]; then
  cp -a "$config_dir/config.toml" "$config_dir/config.toml.bak-$stamp"
fi
cp -a "$stage/runtime/config.toml" "$config_dir/config.toml"
chmod 0640 "$config_dir/config.toml"

if [ -d "$config_dir/provider" ]; then
  mv "$config_dir/provider" "$config_dir/provider.bak-$stamp"
fi
cp -a "$stage/runtime/provider" "$config_dir/provider"

install -d -m 0750 "$config_dir/secrets/v3"
if [ -f "$config_dir/secrets/v3/provider-auth.conf" ]; then
  cp -a "$config_dir/secrets/v3/provider-auth.conf" \
    "$config_dir/secrets/v3/provider-auth.conf.bak-$stamp"
fi
cp -a "$stage/runtime/secrets/v3/provider-auth.conf" "$config_dir/secrets/v3/provider-auth.conf"
chmod 0600 "$config_dir/secrets/v3/provider-auth.conf"

find "$config_dir/provider" -name 'config.v2.toml' -exec chmod 0640 {} +
chown -R root:root "$config_dir"

"$release/rccv3" config check -c "$config_dir/config.toml" \
  || die "deployed config failed validation"
log "config check passed"

# --- local paths the runtime expects ---------------------------------------
# Provider configs may reference absolute secret paths, so the host needs those
# paths to resolve to the runtime config dir. The exact list is a host fact and
# arrives as $host_symlinks.
for link in $host_symlinks; do
  case "$link" in
    /*) ;;
    *) die "host symlink target must be absolute, got: $link" ;;
  esac
  if [ -e "$link" ] && [ ! -L "$link" ]; then
    die "refusing to replace existing non-symlink path: $link"
  fi
  if [ -L "$link" ]; then
    resolved=$(readlink -f "$link")
    [ "$resolved" = "$config_dir" ] || die "refusing to replace unexpected symlink: $link -> $resolved"
  fi
  install -d "$(dirname "$link")"
  [ -L "$link" ] || ln -s "$config_dir" "$link"
done

# --- TLS --------------------------------------------------------------------
install -d -m 0750 "$config_dir/certs"
acme=/root/.acme.sh/acme.sh
if ! openssl x509 -in "$config_dir/certs/fullchain.pem" -noout -checkhost "$domain" >/dev/null 2>&1 \
  || ! openssl x509 -in "$config_dir/certs/fullchain.pem" -noout -checkend 2592000 >/dev/null 2>&1; then
  log "issuing certificate for $domain"
  "$acme" --issue --dns dns_ali -d "$domain" --keylength ec-256
fi
"$acme" --install-cert -d "$domain" --ecc \
  --fullchain-file "$config_dir/certs/fullchain.pem" \
  --key-file "$config_dir/certs/privkey.pem" \
  --reloadcmd "/usr/sbin/nginx -t && /bin/systemctl reload nginx"
chmod 0644 "$config_dir/certs/fullchain.pem"
chmod 0600 "$config_dir/certs/privkey.pem"

# --- Nginx edge -------------------------------------------------------------
nginx_tmp="$nginx_conf.new"
cat > "$nginx_tmp" <<NGINX
$managed_marker
map_hash_bucket_size 128;
map \$http_authorization \$rcc_edge_authorized {
    default 0;
    "Bearer $edge_key" 1;
}
map \$http_upgrade \$rcc_connection_upgrade {
    default upgrade;
    '' close;
}
upstream rcc_v3 {
    server 127.0.0.1:$upstream_port;
    keepalive 32;
}
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name $domain;
    ssl_certificate $config_dir/certs/fullchain.pem;
    ssl_certificate_key $config_dir/certs/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    client_max_body_size 64m;

    location ^~ /_routecodex/ { return 403; }
    location = /health {
        allow 127.0.0.1;
        deny all;
        proxy_pass http://rcc_v3;
        proxy_http_version 1.1;
    }
    location / {
        if (\$rcc_edge_authorized = 0) { return 401; }
        proxy_pass http://rcc_v3;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Authorization \$http_authorization;
        proxy_set_header X-API-Key \$http_x_api_key;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$rcc_connection_upgrade;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        add_header X-Accel-Buffering no always;
    }
}
NGINX
chmod 0600 "$nginx_tmp"
if [ -e "$nginx_conf" ]; then
  cp -a "$nginx_conf" "$nginx_conf.bak-$stamp"
fi
mv "$nginx_tmp" "$nginx_conf"
if ! nginx -t; then
  if [ -e "$nginx_conf.bak-$stamp" ]; then
    cp -a "$nginx_conf.bak-$stamp" "$nginx_conf"
  else
    rm -f "$nginx_conf"
  fi
  die "nginx -t rejected the generated config; rolled back"
fi

# --- systemd unit -----------------------------------------------------------
if [ -e "$unit_path" ]; then
  cp -a "$unit_path" "$unit_path.bak-$stamp"
fi
cat > "$unit_path" <<UNIT
[Unit]
$managed_marker
Description=RouteCodex V3 server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=HOME=/root
Restart=on-failure
RestartSec=5
ExecStartPre=/usr/local/bin/rccv3 config check -c $config_dir/config.toml
ExecStart=/usr/local/bin/rccv3 start -c $config_dir/config.toml
ExecStop=/usr/local/bin/rccv3 stop -c $config_dir/config.toml
TimeoutStartSec=180
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 "$unit_path"

# --- activate ---------------------------------------------------------------
if [ -e /usr/local/bin/rccv3 ]; then
  cp -a /usr/local/bin/rccv3 "/usr/local/bin/rccv3.bak-$stamp"
fi
install -m 0755 "$release/rccv3" /usr/local/bin/rccv3.new
mv /usr/local/bin/rccv3.new /usr/local/bin/rccv3
install -d -m 0755 /usr/local/lib/rccv3
printf '%s\n' "$source_sha" > /usr/local/lib/rccv3/deployed-source-sha

systemctl daemon-reload
systemctl enable rccv3.service >/dev/null
systemctl restart rccv3.service
systemctl reload nginx

systemctl is-active --quiet rccv3.service || die "rccv3.service is not active"
systemctl is-active --quiet nginx || die "nginx is not active"

# --- verification -----------------------------------------------------------
# Ports are digits only, so intentional word splitting is unambiguous here.
ports=$(grep -oE '^port[[:space:]]*=[[:space:]]*[0-9]+' "$config_dir/config.toml" \
  | grep -oE '[0-9]+' | tr '\n' ' ')
[ -n "$ports" ] || die "no listener ports found in deployed config"

for port in $ports; do
  healthy=0
  for _ in $(seq 1 30); do
    body=$(curl --silent --max-time 5 "http://127.0.0.1:$port/health" || true)
    case "$body" in
      *'"status":"ok"'*)
        case "$body" in
          *"\"build_version\":\"$version\""*)
            log "health OK port=$port build_version=$version"
            healthy=1
            break
            ;;
          *)
            die "port $port is healthy but reports a different build_version: $body"
            ;;
        esac
        ;;
    esac
    sleep 2
  done
  [ "$healthy" -eq 1 ] || die "port $port did not become healthy"
done

# `status` compares the published instance declaration, whose
# executable_path is the installed /usr/local/bin/rccv3. Running the
# release-path binary here would report IdentityMismatch.
/usr/local/bin/rccv3 status -c "$config_dir/config.toml" || die "rccv3 status failed"

models_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --resolve "$domain:443:127.0.0.1" -H "Authorization: Bearer $edge_key" \
  "https://$domain/v1/models")
[ "$models_status" = 200 ] || die "authenticated /v1/models returned $models_status"

unauthorized_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --resolve "$domain:443:127.0.0.1" "https://$domain/v1/models")
[ "$unauthorized_status" = 401 ] || die "unauthenticated /v1/models returned $unauthorized_status"

admin_status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
  --resolve "$domain:443:127.0.0.1" -H "Authorization: Bearer $edge_key" \
  "https://$domain/_routecodex/status")
[ "$admin_status" = 403 ] || die "admin route returned $admin_status"

log "edge verification passed"

find "$stage" -mindepth 1 -delete
rmdir "$stage"

printf 'DEPLOYED_SHA=%s\nDEPLOYED_VERSION=%s\n' "$source_sha" "$version"
