#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${PYTHON:-python3.12}"
ENV_DIR="${PERF_SWARM_PYTHON_ENV:-$ROOT/.perf-swarm/python}"

command -v "$PYTHON" >/dev/null || { echo "Missing $PYTHON. Install Python 3.12 first (brew install python@3.12)." >&2; exit 1; }
"$PYTHON" -m venv "$ENV_DIR"
"$ENV_DIR/bin/python" -m pip install --upgrade pip
"$ENV_DIR/bin/python" -m pip install -r "$ROOT/requirements-mps.txt"
"$ENV_DIR/bin/python" "$ROOT/scripts/check-mps-env.py"
echo "Environment ready. Use: export PATH=\"$ENV_DIR/bin:\$PATH\""
