#!/usr/bin/env python3
import json
import platform
import sys

result = {"python": sys.version.split()[0], "platform": platform.platform(), "machine": platform.machine()}
try:
    import torch
    result.update({
        "torch": torch.__version__,
        "mps_built": bool(torch.backends.mps.is_built()),
        "mps_available": bool(torch.backends.mps.is_available()),
    })
except Exception as exc:
    result["error"] = str(exc)
print(json.dumps(result, indent=2))
if platform.machine() != "arm64":
    raise SystemExit("Apple MPS requires an arm64 host")
if not result.get("mps_available"):
    raise SystemExit("PyTorch MPS is unavailable; install the MPS environment and check macOS/PyTorch support")
