"""Computer primitives run locally without an image or Cloudflare access."""

import sys
from pathlib import Path

COMPUTER = Path(__file__).resolve().parents[3] / "images" / "computer"
sys.path.insert(0, str(COMPUTER))
