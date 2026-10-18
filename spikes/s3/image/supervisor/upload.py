"""Upload a local snapshot and publish its manifest (design steps 5-7).

Stands in for the Sandbox SDK's DirectoryBackup: one ``tar+zstd/1`` object per
snapshot, uploaded in 16 MiB multipart parts, verified by size and SHA-256,
then one manifest, then the pointer switch. MinIO stands in for R2. A failed
or timed-out upload never writes the manifest or moves the pointer.

Runs after the processes have resumed, so a slow or blocked store costs only
upload time, never pause time.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import time
from typing import Any

import boto3
from botocore.config import Config

PART = 16 * 1024 * 1024
FORMAT_VERSION = 1


def client(timeout_s: float, attempts: int) -> Any:
    return boto3.client(
        "s3",
        endpoint_url=os.environ["S3_ENDPOINT"],
        aws_access_key_id=os.environ["S3_ACCESS_KEY"],
        aws_secret_access_key=os.environ["S3_SECRET_KEY"],
        region_name="us-east-1",
        config=Config(
            connect_timeout=min(5.0, timeout_s),
            read_timeout=timeout_s,
            retries={"max_attempts": attempts, "mode": "standard"},
            s3={"addressing_style": "path"},
        ),
    )


def upload_snapshot(spec: dict[str, Any]) -> dict[str, Any]:
    t0 = time.monotonic()
    bucket = spec["bucket"]
    computer = spec["computer_id"]
    generation = int(spec.get("generation", 1))
    snap = spec["snapshot_dir"]
    capture_id = spec["capture_id"]
    deadline = t0 + float(spec.get("deadline_s", 600))
    s3 = client(float(spec.get("request_timeout_s", 20)), int(spec.get("attempts", 3)))
    key = f"checkpoints/{computer}/{capture_id}.tar.zst"
    res: dict[str, Any] = {"capture_id": capture_id, "key": key, "published": False}

    proc = subprocess.Popen(
        ["bash", "-c", f"tar -C '{snap}' -cf - . | zstd -q -3 -T0"],
        stdout=subprocess.PIPE,
    )
    assert proc.stdout is not None
    h = hashlib.sha256()
    size = 0
    parts: list[dict[str, Any]] = []
    upload_id = None
    try:
        upload_id = s3.create_multipart_upload(Bucket=bucket, Key=key)["UploadId"]
        n = 1
        while True:
            chunk = proc.stdout.read(PART)
            if not chunk:
                break
            if time.monotonic() > deadline:
                raise TimeoutError("upload deadline passed")
            h.update(chunk)
            size += len(chunk)
            etag = s3.upload_part(Bucket=bucket, Key=key, UploadId=upload_id, PartNumber=n, Body=chunk)["ETag"]
            parts.append({"PartNumber": n, "ETag": etag})
            n += 1
        if proc.wait() != 0:
            raise RuntimeError("archive failed")
        s3.complete_multipart_upload(
            Bucket=bucket, Key=key, UploadId=upload_id, MultipartUpload={"Parts": parts}
        )
        upload_id = None
        res["upload_s"] = round(time.monotonic() - t0, 3)
        # Verify: the stored object must have the size we sent.
        head = s3.head_object(Bucket=bucket, Key=key)
        if head["ContentLength"] != size:
            raise RuntimeError(f"size mismatch: stored {head['ContentLength']}, sent {size}")
        digest = h.hexdigest()
        manifest = {
            "format_version": FORMAT_VERSION,
            "computer_id": computer,
            "generation": generation,
            "capture_id": capture_id,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "objects": [{"key": key, "size": size, "sha256": digest, "format": "tar+zstd/1"}],
        }
        mkey = f"manifests/{computer}/{capture_id}.json"
        s3.put_object(Bucket=bucket, Key=mkey, Body=json.dumps(manifest).encode())
        # The pointer switch is the publish. In production WorkspaceDO does this
        # atomically in its own storage after the verify step.
        s3.put_object(
            Bucket=bucket,
            Key=f"pointers/{computer}.json",
            Body=json.dumps({"manifest": mkey, "capture_id": capture_id}).encode(),
        )
        res.update(published=True, manifest=mkey, size=size, sha256=digest, outcome="published")
    except Exception as exc:  # noqa: BLE001 - spike: report every failure as a failed save
        res.update(outcome="upload_failed", error=f"{type(exc).__name__}: {exc}"[:500])
        proc.kill()
        if upload_id is not None:
            try:
                client(3, 1).abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
            except Exception as exc2:  # noqa: BLE001
                res["abort_error"] = f"{type(exc2).__name__}"
    finally:
        proc.wait()
    res["total_s"] = round(time.monotonic() - t0, 3)
    if spec.get("delete_snapshot", True):
        shutil.rmtree(snap, ignore_errors=True)
    return res


def current_pointer(bucket: str, computer: str) -> dict[str, Any] | None:
    s3 = client(10, 2)
    try:
        body = s3.get_object(Bucket=bucket, Key=f"pointers/{computer}.json")["Body"].read()
    except s3.exceptions.NoSuchKey:
        return None
    return json.loads(body)


def restore_latest(bucket: str, computer: str, target_root: str) -> dict[str, Any]:
    """Download the published checkpoint, verify it, and extract it.

    Extracts into ``<target_root>.restore`` and renames into place, so a failed
    restore leaves the target unchanged.
    """
    t0 = time.monotonic()
    s3 = client(30, 3)
    ptr = current_pointer(bucket, computer)
    if ptr is None:
        return {"outcome": "no_checkpoint"}
    manifest = json.loads(s3.get_object(Bucket=bucket, Key=ptr["manifest"])["Body"].read())
    if manifest.get("format_version") != FORMAT_VERSION:
        return {"outcome": "unknown_format", "format_version": manifest.get("format_version")}
    obj = manifest["objects"][0]
    staging = target_root.rstrip("/") + ".restore"
    shutil.rmtree(staging, ignore_errors=True)
    os.makedirs(staging)
    body = s3.get_object(Bucket=bucket, Key=obj["key"])["Body"]
    h = hashlib.sha256()
    size = 0
    proc = subprocess.Popen(["bash", "-c", f"zstd -q -d | tar -C '{staging}' -xf -"], stdin=subprocess.PIPE)
    assert proc.stdin is not None
    for chunk in iter(lambda: body.read(1 << 20), b""):
        h.update(chunk)
        size += len(chunk)
        proc.stdin.write(chunk)
    proc.stdin.close()
    rc = proc.wait()
    if rc != 0 or size != obj["size"] or h.hexdigest() != obj["sha256"]:
        shutil.rmtree(staging, ignore_errors=True)
        return {"outcome": "integrity_failed", "rc": rc}
    if os.path.exists(target_root):
        shutil.rmtree(target_root)
    os.rename(staging, target_root)
    return {
        "outcome": "restored",
        "capture_id": manifest["capture_id"],
        "size": size,
        "restore_s": round(time.monotonic() - t0, 3),
    }
