"""IR-008: a failed archive producer or compressor must never publish.

Reviewer's scenario: tar writes part of the archive and exits 2, the
compressor succeeds, and the upload publishes a manifest and moves the
pointer. Also: compressor failure, failure after a part was uploaded, the same
status discipline on restore, and a success control.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest
from conftest import FakeS3, zstd_tar_members

from supervisor import upload as U

BUCKET = "checkpoints"
COMPUTER = "computer-t"


def make_snapshot(root: Path) -> Path:
    snap = root / "snap"
    (snap / "work").mkdir(parents=True)
    (snap / "work" / "a.txt").write_bytes(b"alpha\n" * 1000)
    (snap / "work" / "b.bin").write_bytes(os.urandom(2 << 20))
    return snap


def baseline(s3: FakeS3) -> dict[str, str]:
    ptr = {"manifest": f"manifests/{COMPUTER}/baseline.json", "capture_id": "baseline"}
    s3.put_object(Bucket=BUCKET, Key=f"pointers/{COMPUTER}.json", Body=json.dumps(ptr).encode())
    return ptr


def spec(snap: Path, cid: str) -> dict:
    return {"bucket": BUCKET, "computer_id": COMPUTER, "snapshot_dir": str(snap), "capture_id": cid,
            "delete_snapshot": False}


def pointer(s3: FakeS3) -> dict:
    return json.loads(s3.objects[f"pointers/{COMPUTER}.json"])


def assert_not_published(res: dict, s3: FakeS3, before: dict, cid: str) -> None:
    assert res["published"] is False, res
    assert res["outcome"] == "upload_failed", res
    assert pointer(s3) == before
    assert f"manifests/{COMPUTER}/{cid}.json" not in s3.objects
    assert f"checkpoints/{COMPUTER}/{cid}.tar.zst" not in s3.objects


def test_partial_producer_failure_does_not_publish(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The reviewer's case: the producer emits bytes, then exits 2; the compressor succeeds."""
    snap = make_snapshot(tmp_path)
    s3 = FakeS3()
    before = baseline(s3)
    monkeypatch.setattr(U, "archive_argv", lambda _snap: ["sh", "-c", "head -c 4096 /dev/urandom; exit 2"])
    monkeypatch.setattr(U, "compress_argv", lambda: ["cat"])
    res = U.upload_snapshot(spec(snap, "c-producer"), s3=s3)
    assert_not_published(res, s3, before, "c-producer")


def test_compressor_failure_does_not_publish(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    snap = make_snapshot(tmp_path)
    s3 = FakeS3()
    before = baseline(s3)
    monkeypatch.setattr(U, "compress_argv", lambda: ["sh", "-c", "head -c 1000; cat >/dev/null; exit 1"])
    res = U.upload_snapshot(spec(snap, "c-compressor"), s3=s3)
    assert_not_published(res, s3, before, "c-compressor")


def test_failure_after_a_part_was_uploaded_aborts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """20 MiB of output (one 16 MiB part uploads), then the producer fails."""
    snap = make_snapshot(tmp_path)
    s3 = FakeS3()
    before = baseline(s3)
    monkeypatch.setattr(U, "archive_argv", lambda _snap: ["sh", "-c", "head -c 20971520 /dev/zero; exit 2"])
    monkeypatch.setattr(U, "compress_argv", lambda: ["cat"])
    res = U.upload_snapshot(spec(snap, "c-late"), s3=s3)
    assert s3.parts_uploaded >= 1
    assert_not_published(res, s3, before, "c-late")
    assert s3.aborted == [f"checkpoints/{COMPUTER}/c-late.tar.zst"]
    assert not s3.uploads, "the multipart upload must be aborted"


def test_success_control_publishes_the_whole_snapshot(tmp_path: Path) -> None:
    snap = make_snapshot(tmp_path)
    s3 = FakeS3()
    baseline(s3)
    res = U.upload_snapshot(spec(snap, "c-ok"), s3=s3)
    assert res["published"] is True, res
    assert pointer(s3)["capture_id"] == "c-ok"
    members = zstd_tar_members(s3.objects[res["key"]])
    assert members["work/a.txt"] == (snap / "work" / "a.txt").read_bytes()
    assert members["work/b.bin"] == (snap / "work" / "b.bin").read_bytes()


def publish_good(tmp_path: Path, s3: FakeS3) -> None:
    snap = make_snapshot(tmp_path)
    res = U.upload_snapshot(spec(snap, "c-good"), s3=s3)
    assert res["published"], res


def test_restore_decompressor_failure_leaves_target_unchanged(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The decompressor exits 1 after writing a complete stream; the extractor succeeds."""
    s3 = FakeS3()
    publish_good(tmp_path, s3)
    target = tmp_path / "restored"
    target.mkdir()
    (target / "keep.txt").write_text("previous")
    monkeypatch.setattr(U, "decompress_argv", lambda: ["sh", "-c", "zstd -q -d; exit 1"])
    res = U.restore_latest(BUCKET, COMPUTER, str(target), s3=s3)
    assert res["outcome"] != "restored", res
    assert (target / "keep.txt").read_text() == "previous"
    assert not (target / "work").exists()


def test_restore_extractor_failure_leaves_target_unchanged(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    s3 = FakeS3()
    publish_good(tmp_path, s3)
    target = tmp_path / "restored"
    target.mkdir()
    (target / "keep.txt").write_text("previous")
    monkeypatch.setattr(U, "extract_argv", lambda t: ["sh", "-c", f"tar -C '{t}' -xf -; exit 2"])
    res = U.restore_latest(BUCKET, COMPUTER, str(target), s3=s3)
    assert res["outcome"] != "restored", res
    assert (target / "keep.txt").read_text() == "previous"


def test_restore_success_control(tmp_path: Path) -> None:
    s3 = FakeS3()
    publish_good(tmp_path, s3)
    target = tmp_path / "restored"
    res = U.restore_latest(BUCKET, COMPUTER, str(target), s3=s3)
    assert res["outcome"] == "restored", res
    assert (target / "work" / "a.txt").read_bytes() == b"alpha\n" * 1000
