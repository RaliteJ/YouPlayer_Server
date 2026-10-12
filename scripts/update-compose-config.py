#!/usr/bin/env python3
"""Read Compose's resolved configuration; never create or start containers."""
import json
import subprocess
import sys
from pathlib import Path

import yaml

try:
    root = Path(sys.argv[1]).resolve()
    result = subprocess.run(
        ["podman-compose", "--env-file", str(root / ".env"), "-p", sys.argv[2],
         "-f", str(root / "docker-compose.yml"), "config"],
        cwd=root, check=True, capture_output=True, text=True, timeout=30,
    )
    print(json.dumps(yaml.safe_load(result.stdout)))
except Exception:
    # Parser and Compose errors may quote credentials. The caller only gets a code.
    print("Configuration Compose illisible", file=sys.stderr)
    sys.exit(1)
