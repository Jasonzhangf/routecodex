#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
git -C "$root" config --worktree core.hooksPath .githooks
echo "git main protection enabled: $root/.githooks"
