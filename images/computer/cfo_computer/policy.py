"""The checkpoint policy: one classification for capture, prune and restore.

Loads the contract's policy file (``contracts/fixtures/CheckpointPolicy/v1.json``, which the
TypeScript tests hold equal to ``CHECKPOINT_POLICY_V1``) and decides paths exactly as
``classifyPath`` in contracts/src/checkpoint-policy.ts does: patterns relative to the home
directory (or to $TMPDIR for ``root: "tmp"`` rules); ``**`` matches anything, slashes
included; ``*`` anything within one segment; ``?`` one character within a segment; the first
matching rule wins. The vectors in ``contracts/vectors/checkpoint-policy-v1.json`` hold both
sides to the same decisions.

For speed, each rule is compiled once, and the rules a path can match are pre-selected by the
path's first segment; the order of the remaining rules is kept, so the first match is the same.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

POLICY_FORMAT = "cfo.checkpoint-policy"
SAVED_ACTIONS = frozenset({"save", "save-link"})
_GLOB_CHARS = frozenset("*?")


def glob_to_regex(pattern: str) -> str:
    out: list[str] = []
    i = 0
    while i < len(pattern):
        c = pattern[i]
        if c == "*" and pattern[i + 1 : i + 2] == "*":
            out.append(".*")
            i += 2
            continue
        if c == "*":
            out.append("[^/]*")
        elif c == "?":
            out.append("[^/]")
        else:
            out.append(re.escape(c))
        i += 1
    return "".join(out)


@dataclass(frozen=True)
class Decision:
    action: str
    rule: str

    @property
    def saved(self) -> bool:
        return self.action in SAVED_ACTIONS


@dataclass(frozen=True)
class _Rule:
    order: int
    rule_id: str
    action: str
    root: str
    regex: re.Pattern[str]
    # First segments a matching path can have; None when any first segment can match.
    heads: frozenset[str] | None


def _heads(patterns: list[str]) -> frozenset[str] | None:
    heads: set[str] = set()
    for pattern in patterns:
        head = pattern.split("/", 1)[0]
        if any(c in _GLOB_CHARS for c in head):
            return None
        heads.add(head)
    return frozenset(heads)


class Policy:
    """One checkpoint policy version, ready to classify paths."""

    def __init__(self, data: dict[str, Any]) -> None:
        if data.get("format") != POLICY_FORMAT:
            raise ValueError("not a checkpoint policy")
        self.version: int = int(data["version"])
        self.roots: tuple[str, ...] = tuple(data["roots"])
        self.data = data
        rules = []
        for order, raw in enumerate(data["rules"]):
            regex = re.compile("|".join(f"(?:{glob_to_regex(p)})" for p in raw["patterns"]), re.S)
            rules.append(
                _Rule(order, raw["id"], raw["action"], raw["root"], regex, _heads(raw["patterns"]))
            )
        self._home_rules = [r for r in rules if r.root == "home"]
        self._tmp_rules = [r for r in rules if r.root == "tmp"]
        self._all_rules = rules
        self._by_head: dict[str, list[_Rule]] = {}

    @classmethod
    def load(cls, path: Path) -> Policy:
        return cls(json.loads(Path(path).read_text()))

    def _candidates(self, head: str) -> list[_Rule]:
        rules = self._by_head.get(head)
        if rules is None:
            rules = [r for r in self._home_rules if r.heads is None or head in r.heads]
            self._by_head[head] = rules
        return rules

    def classify(self, path: str, *, tmp_rel: str | None = None) -> Decision:
        """The decision for ``path``, relative to the home directory."""
        if tmp_rel is not None and (path == tmp_rel or path.startswith(tmp_rel + "/")):
            # With $TMPDIR inside a root, rule order across both kinds matters: walk them all.
            for rule in self._all_rules:
                target = path
                if rule.root == "tmp":
                    target = path[len(tmp_rel) + 1 :]
                if rule.regex.fullmatch(target):
                    return Decision(rule.action, rule.rule_id)
            return Decision("unclassified", "none")
        for rule in self._candidates(path.split("/", 1)[0]):
            if rule.regex.fullmatch(path):
                return Decision(rule.action, rule.rule_id)
        return Decision("unclassified", "none")

    def in_roots(self, path: str) -> bool:
        """Whether ``path`` is one of the roots or lies below one."""
        return any(path == root or path.startswith(root + "/") for root in self.roots)
