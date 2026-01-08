#!/usr/bin/env python3
"""
Generate and persist a Camoufox fingerprint env config for a given profile.

This script is invoked by RouteCodex to create a stable, per-profile
fingerprint configuration using Camoufox's own launch_options helper.

Behavior:
  - Uses camoufox.utils.launch_options with:
      - geoip=True  (so region / timezone come from geoip)
      - os=<policy> (windows / macos / linux / random / list)
  - Computes the delta between the current environment and the env
    returned in launch_options, and persists only that diff.
  - Writes JSON to <output_dir>/<profile_id>.json of the form:
        { "env": { "KEY": "VALUE", ... } }
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
from typing import Dict, Any, List


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(description="Generate Camoufox fingerprint env for a profile.")
  parser.add_argument(
    "--profile-id",
    required=True,
    help="Logical profile identifier (e.g. rc-gemini.geetasamodgeetasamoda).",
  )
  parser.add_argument(
    "--os",
    dest="os_name",
    default=None,
    help="Camoufox OS policy: windows | macos | linux | random | comma list.",
  )
  parser.add_argument(
    "--output-dir",
    required=True,
    help="Directory to store the generated fingerprint JSON file.",
  )
  return parser.parse_args()


def ensure_output_dir(path_str: str) -> Path:
  path = Path(os.path.expanduser(path_str)).resolve()
  path.mkdir(parents=True, exist_ok=True)
  return path


def _force_us_region(env: Dict[str, str]) -> None:
  """
  Override timezone / locale / geo fields in CAMOU_CONFIG_* to point to a US
  region while keeping all other fingerprint details (canvas, fonts, UA shape, etc.)
  intact.
  """
  parts: List[str] = []
  for key in sorted(env.keys()):
    if key.startswith("CAMOU_CONFIG_"):
      value = env.get(key)
      if isinstance(value, str):
        parts.append(value)

  if not parts:
    return

  blob = "".join(parts)
  try:
    cfg = json.loads(blob)
  except Exception:
    return

  # Force US timezone / locale / geo (single region for all accounts)
  cfg["timezone"] = "America/Los_Angeles"
  cfg["locale:language"] = cfg.get("locale:language", "en")
  cfg["locale:region"] = "US"
  cfg.setdefault("locale:script", "Latn")
  cfg["geolocation:latitude"] = 37.7749
  cfg["geolocation:longitude"] = -122.4194

  payload = json.dumps(cfg, ensure_ascii=False, separators=(",", ":"))

  # Replace any existing CAMOU_CONFIG_* entries with a single updated chunk.
  for key in list(env.keys()):
    if key.startswith("CAMOU_CONFIG_"):
      env.pop(key, None)
  env["CAMOU_CONFIG_1"] = payload


def generate_env_delta(os_name: str | None) -> Dict[str, str]:
  """
  Call camoufox.utils.launch_options and compute the delta env vars.

  We only keep keys whose values differ from the original os.environ,
  so that RouteCodex can safely merge them into its own process.env.
  """
  try:
    from camoufox.utils import launch_options  # type: ignore
  except Exception as exc:
    print(f"[gen-fingerprint-env] Failed to import camoufox.utils.launch_options: {exc}", file=sys.stderr)
    sys.exit(1)

  # Snapshot original environment
  original_env = dict(os.environ)

  try:
    opts: Dict[str, Any] = launch_options(
      os=os_name,
      geoip=True,
      headless=False,
      window=(1440, 900),
    )
  except Exception as exc:
    print(f"[gen-fingerprint-env] launch_options() failed: {exc}", file=sys.stderr)
    sys.exit(1)

  env = opts.get("env") or {}
  if not isinstance(env, dict):
    print("[gen-fingerprint-env] launch_options() returned invalid env payload", file=sys.stderr)
    sys.exit(1)

  # Normalize region/timezone/geo to a fixed US profile so that all accounts
  # share the same region while still having distinct device fingerprints.
  try:
    _force_us_region(env)
  except Exception as exc:
    print(f"[gen-fingerprint-env] failed to force US region: {exc}", file=sys.stderr)

  delta: Dict[str, str] = {}
  for key, value in env.items():
    try:
      value_str = str(value)
    except Exception:
      continue
    if original_env.get(key) != value_str:
      delta[key] = value_str
  return delta


def write_fingerprint_file(profile_id: str, output_dir: Path, env_delta: Dict[str, str]) -> Path:
  output_path = output_dir / f"{profile_id}.json"
  tmp_path = output_path.with_suffix(output_path.suffix + ".tmp")
  payload = {"env": env_delta}

  with tmp_path.open("w", encoding="utf-8") as f:
    json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

  tmp_path.replace(output_path)
  return output_path


def main() -> None:
  args = parse_args()
  profile_id: str = args.profile_id.strip()
  if not profile_id:
    print("[gen-fingerprint-env] Missing profile id", file=sys.stderr)
    sys.exit(1)

  output_dir = ensure_output_dir(args.output_dir)
  env_delta = generate_env_delta(args.os_name)
  path = write_fingerprint_file(profile_id, output_dir, env_delta)
  # Print the absolute path for callers that care.
  print(str(path))


if __name__ == "__main__":
  main()
