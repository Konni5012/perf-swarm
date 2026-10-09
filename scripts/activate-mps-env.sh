#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_DIR="${PERF_SWARM_PYTHON_ENV:-$ROOT/.perf-swarm/python}"
if [[ ! -x "$ENV_DIR/bin/python" ]]; then
  echo "MPS environment is not installed. Run: npm run env:mps:setup" >&2
  return 1 2>/dev/null || exit 1
fi
export PERF_SWARM_PYTHON_ENV="$ENV_DIR"
export PATH="$ENV_DIR/bin:$PATH"
export PYTORCH_ENABLE_MPS_FALLBACK=1
echo "perf-SWARM MPS environment active: $ENV_DIR"
