"""One-off: make the "script" field of results files repository-relative.

The first runs stored the absolute path of the bench script. Only that field
changes; the measurements are untouched.
"""

from __future__ import annotations

import json
from pathlib import Path

RESULTS = Path(__file__).resolve().parents[1] / "results"

for f in sorted(RESULTS.glob("*.json")):
    doc = json.loads(f.read_text())
    script = doc.get("script", "")
    if "/spikes/s3/" in script:
        doc["script"] = "spikes/s3/" + script.split("/spikes/s3/", 1)[1]
        f.write_text(json.dumps(doc, indent=1))
        print(f"{f.name}: {doc['script']}")
