"""RC-53's layer scan from a checkout (the code is ``cfo_computer.rc53``, which the image runs).

python3 -I images/computer/tools/rc53_scan.py --values <file> [--controls <file>] PATH...
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cfo_computer.rc53 import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
