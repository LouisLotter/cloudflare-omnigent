"""Optional cache corruption must never replace actual file hashing or break capture."""

import hashlib
import json
import os
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from cfo_computer import tree


@pytest.mark.parametrize("raw", [b"{", b"\xff", b"null", b"[1]", b"1", b'"bad"'])
def test_invalid_cache_file_rehashes(tmp_path, raw):
    source = tmp_path / "file"
    source.write_bytes(b"actual bytes")
    saved = tmp_path / "cache.json"
    saved.write_bytes(raw)
    cache = tree.HashCache.load(saved)
    assert (
        cache.digest("file", source, source.stat()) == hashlib.sha256(b"actual bytes").hexdigest()
    )
    assert cache.hashed_files == 1
    assert cache.load_errors == 1


@pytest.mark.parametrize(
    "entry",
    [None, [], [1], [[], "a" * 64], [None, "a" * 64], "bad", 2, {"key": []}],
)
def test_malformed_entry_is_a_miss(tmp_path, entry):
    source = tmp_path / "file"
    source.write_bytes(b"data")
    saved = tmp_path / "cache.json"
    saved.write_text(json.dumps({"file": entry}))
    cache = tree.HashCache.load(saved)
    assert cache.digest("file", source, source.stat()) == hashlib.sha256(b"data").hexdigest()
    assert cache.invalid_entries == 1
    assert cache.hashed_files == 1


@pytest.mark.parametrize(
    "digest", [None, 1, [], "", "a" * 63, "a" * 65, "G" * 64, "A" * 64, "a" * 64 + "\n"]
)
def test_invalid_digest_is_never_returned(tmp_path, digest):
    source = tmp_path / "file"
    source.write_bytes(b"data")
    cache = tree.HashCache({"file": [tree.cache_key(source.stat()), digest]})
    assert cache.digest("file", source, source.stat()) == hashlib.sha256(b"data").hexdigest()
    assert cache.invalid_entries == 1


@pytest.mark.parametrize("field", range(4))
def test_numeric_lookalikes_in_cache_key_are_not_trusted(tmp_path, field):
    source = tmp_path / "file"
    source.write_bytes(b"data")
    key = tree.cache_key(source.stat())
    key[field] = float(key[field])
    cache = tree.HashCache({"file": [key, "0" * 64]})
    assert cache.digest("file", source, source.stat()) == hashlib.sha256(b"data").hexdigest()
    assert cache.invalid_entries == 1


def test_valid_hit_roundtrip_and_corrupt_neighbor(tmp_path):
    source = tmp_path / "file"
    source.write_bytes(b"data")
    expected = hashlib.sha256(b"data").hexdigest()
    saved = tmp_path / "cache.json"
    cache = tree.HashCache({"file": [tree.cache_key(source.stat()), expected], "bad": []})
    assert cache.invalid_entries == 1
    cache.save(saved)
    loaded = tree.HashCache.load(saved)
    with patch.object(tree, "sha256_file", side_effect=AssertionError("valid hit rehashed")):
        assert loaded.digest("file", source, source.stat()) == expected
    assert loaded.hashed_files == 0
    assert "bad" not in loaded.entries


def test_post_load_corruption_is_also_a_miss(tmp_path):
    source = tmp_path / "file"
    source.write_bytes(b"data")
    cache = tree.HashCache()
    cache.entries["file"] = []
    assert cache.digest("file", source, source.stat()) == hashlib.sha256(b"data").hexdigest()
    assert cache.invalid_entries == 1


def test_restored_mtime_does_not_hide_content_change(tmp_path):
    source = tmp_path / "file"
    source.write_bytes(b"AAAA")
    old = source.stat()
    cache = tree.HashCache()
    assert cache.digest("file", source, old) == hashlib.sha256(b"AAAA").hexdigest()
    source.write_bytes(b"BBBB")
    os.utime(source, ns=(old.st_atime_ns, old.st_mtime_ns))
    assert cache.digest("file", source, source.stat()) == hashlib.sha256(b"BBBB").hexdigest()
    assert cache.hashed_files == 2


def test_changed_during_read_is_not_cached(tmp_path):
    source = tmp_path / "file"
    source.write_bytes(b"old")
    before = source.stat()
    cache = tree.HashCache()

    def read_then_change(path):
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        path.write_bytes(b"changed")
        return digest

    with patch.object(tree, "sha256_file", side_effect=read_then_change):
        cache.digest("file", source, before)
    assert "file" not in cache.entries


def test_remember_rejects_invalid_digest(tmp_path):
    source = tmp_path / "file"
    source.touch()
    cache = tree.HashCache()
    with pytest.raises(ValueError):
        cache.remember("file", source.stat(), "invalid")
    assert cache.entries == {}


@pytest.mark.parametrize("field", range(4))
def test_boolean_metadata_cannot_impersonate_integer_key(tmp_path, field):
    source = tmp_path / "file"
    source.write_bytes(b"x")
    observed = SimpleNamespace(st_ino=1, st_size=1, st_mtime_ns=1, st_ctime_ns=1)
    key = [1, 1, 1, 1]
    key[field] = True
    cache = tree.HashCache({"file": [key, "0" * 64]})
    assert cache.digest("file", source, observed) == hashlib.sha256(b"x").hexdigest()
    assert cache.hashed_files == 1


def test_unreadable_or_missing_cache_does_not_prevent_hashing(tmp_path):
    cache = tree.HashCache.load(tmp_path / "missing")
    assert cache.load_errors == 1
    with patch.object(tree.Path, "read_text", side_effect=PermissionError):
        cache = tree.HashCache.load(tmp_path / "unreadable")
    source = tmp_path / "file"
    source.write_bytes(b"data")
    assert cache.digest("file", source, source.stat()) == hashlib.sha256(b"data").hexdigest()
    assert cache.load_errors == 1


def test_valid_hit_metadata_is_not_aliased_to_input(tmp_path):
    source = tmp_path / "file"
    source.write_bytes(b"data")
    expected = hashlib.sha256(b"data").hexdigest()
    entries = {"file": [tree.cache_key(source.stat()), expected]}
    cache = tree.HashCache(entries)
    entries["file"][0][0] += 1
    entries["file"][1] = "0" * 64
    with patch.object(tree, "sha256_file", side_effect=AssertionError("cache input aliased")):
        assert cache.digest("file", source, source.stat()) == expected
