"""Filter stdin to stdout, replacing the staging account ID, zone and owner email.

Usage: python3 -I redact.py <staging config.json>. The values come from the staging tool's
own config, outside the repository, and are never printed.
"""

import json
import os
import sys

config = json.load(open(sys.argv[1]))  # noqa: SIM115
pairs = [
    (config.get("accountId"), "<account>"),
    (config.get("ownerEmail"), "<owner-email>"),
    (config.get("identityProviderId"), "<idp>"),
    (config.get("zone"), "<zone>"),
]
pairs = [(value, mask) for value, mask in pairs if value]
pairs.append((os.path.expanduser("~"), "~"))

for line in sys.stdin:
    for value, mask in pairs:
        line = line.replace(value, mask)
    sys.stdout.write(line)
    sys.stdout.flush()
