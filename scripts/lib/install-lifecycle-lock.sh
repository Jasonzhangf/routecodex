#!/bin/bash

acquire_routecodex_install_lock() {
  ROUTECODEX_INSTALL_LOCK_DIR="${ROUTECODEX_INSTALL_LOCK_DIR:-${HOME}/.rcc/locks/install-lifecycle.lock}"
  mkdir -p "$(dirname "$ROUTECODEX_INSTALL_LOCK_DIR")"
  if ! mkdir "$ROUTECODEX_INSTALL_LOCK_DIR" 2>/dev/null; then
    echo "❌ RouteCodex install already in progress: $ROUTECODEX_INSTALL_LOCK_DIR" >&2
    return 1
  fi
  printf '%s\n' "$$" > "$ROUTECODEX_INSTALL_LOCK_DIR/pid"
  ROUTECODEX_INSTALL_LOCK_HELD=1
}

release_routecodex_install_lock() {
  if [ "${ROUTECODEX_INSTALL_LOCK_HELD:-0}" = "1" ]; then
    rm -f "$ROUTECODEX_INSTALL_LOCK_DIR/pid"
    rmdir "$ROUTECODEX_INSTALL_LOCK_DIR"
    ROUTECODEX_INSTALL_LOCK_HELD=0
  fi
}
