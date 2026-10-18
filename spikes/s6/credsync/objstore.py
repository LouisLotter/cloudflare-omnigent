"""Object stores for the spike: a local directory, and S3 (MinIO standing in for R2).

The S3 client is a minimal AWS Signature V4 implementation over urllib, so the spike needs no
third-party packages inside the computer image. Path-style addressing only.
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import hmac
import os
import secrets
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path


class ObjectStore:
    def put(self, key: str, data: bytes) -> None:
        raise NotImplementedError

    def get(self, key: str) -> bytes:
        raise NotImplementedError

    def delete(self, key: str) -> None:
        raise NotImplementedError

    def list(self, prefix: str = "") -> list[str]:
        raise NotImplementedError


class LocalStore(ObjectStore):
    def __init__(self, root: Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)

    def _path(self, key: str) -> Path:
        if key.startswith("/") or ".." in key.split("/"):
            raise ValueError(f"bad key {key!r}")
        return self.root / key

    def put(self, key: str, data: bytes) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        tmp = p.with_name(f".{p.name}.{secrets.token_hex(4)}.part")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, p)

    def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def delete(self, key: str) -> None:
        self._path(key).unlink(missing_ok=True)

    def list(self, prefix: str = "") -> list[str]:
        out = []
        for p in self.root.rglob("*"):
            if p.is_file() and not p.name.endswith(".part"):
                k = str(p.relative_to(self.root))
                if k.startswith(prefix):
                    out.append(k)
        return sorted(out)


def _sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode(), hashlib.sha256).digest()


class S3Store(ObjectStore):
    """Minimal S3 client: PUT, GET, DELETE, ListObjectsV2, CreateBucket."""

    def __init__(self, endpoint: str, bucket: str, access_key: str, secret_key: str, region: str = "us-east-1", timeout: float = 30.0):
        self.endpoint = endpoint.rstrip("/")
        self.bucket = bucket
        self.access_key = access_key
        self.secret_key = secret_key
        self.region = region
        self.timeout = timeout
        u = urllib.parse.urlsplit(self.endpoint)
        self.host = u.netloc
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    @classmethod
    def from_env(cls) -> S3Store:
        return cls(
            endpoint=os.environ["S6_S3_ENDPOINT"],
            bucket=os.environ["S6_S3_BUCKET"],
            access_key=os.environ["S6_S3_ACCESS_KEY"],
            secret_key=os.environ["S6_S3_SECRET_KEY"],
        )

    def _request(self, method: str, key: str = "", query: dict[str, str] | None = None, body: bytes = b"", bucket_level: bool = False) -> bytes:
        now = _dt.datetime.now(_dt.UTC)
        amz_date = now.strftime("%Y%m%dT%H%M%SZ")
        datestamp = now.strftime("%Y%m%d")
        path = f"/{self.bucket}" if bucket_level else f"/{self.bucket}/{urllib.parse.quote(key, safe='/-_.~')}"
        query = query or {}
        canonical_query = "&".join(
            f"{urllib.parse.quote(k, safe='-_.~')}={urllib.parse.quote(v, safe='-_.~')}" for k, v in sorted(query.items())
        )
        payload_hash = hashlib.sha256(body).hexdigest()
        headers = {"host": self.host, "x-amz-content-sha256": payload_hash, "x-amz-date": amz_date}
        signed_headers = ";".join(sorted(headers))
        canonical_headers = "".join(f"{k}:{headers[k]}\n" for k in sorted(headers))
        canonical_request = "\n".join([method, path, canonical_query, canonical_headers, signed_headers, payload_hash])
        scope = f"{datestamp}/{self.region}/s3/aws4_request"
        string_to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical_request.encode()).hexdigest()])
        k = _sign(("AWS4" + self.secret_key).encode(), datestamp)
        k = _sign(k, self.region)
        k = _sign(k, "s3")
        k = _sign(k, "aws4_request")
        signature = hmac.new(k, string_to_sign.encode(), hashlib.sha256).hexdigest()
        headers["authorization"] = (
            f"AWS4-HMAC-SHA256 Credential={self.access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
        )
        url = f"{self.endpoint}{path}" + (f"?{canonical_query}" if canonical_query else "")
        req = urllib.request.Request(url, data=body if method in ("PUT", "POST") else None, method=method)
        for hk, hv in headers.items():
            if hk != "host":
                req.add_header(hk, hv)
        try:
            with self._opener.open(req, timeout=self.timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            detail = e.read()[:300].decode("utf-8", "replace")
            raise OSError(f"S3 {method} {path} failed: HTTP {e.code} {detail}") from None

    def create_bucket(self) -> None:
        try:
            self._request("PUT", bucket_level=True)
        except OSError as e:
            if "BucketAlreadyOwnedByYou" not in str(e) and "BucketAlreadyExists" not in str(e):
                raise

    def put(self, key: str, data: bytes) -> None:
        self._request("PUT", key, body=data)

    def get(self, key: str) -> bytes:
        return self._request("GET", key)

    def delete(self, key: str) -> None:
        self._request("DELETE", key)

    def list(self, prefix: str = "") -> list[str]:
        keys: list[str] = []
        token = None
        while True:
            q = {"list-type": "2", "prefix": prefix}
            if token:
                q["continuation-token"] = token
            root = ET.fromstring(self._request("GET", query=q, bucket_level=True))
            ns = {"s": root.tag.split("}")[0].strip("{")} if root.tag.startswith("{") else {}
            find = (lambda el, t: el.findall(f"s:{t}", ns)) if ns else (lambda el, t: el.findall(t))
            for c in find(root, "Contents"):
                keys.extend(x.text or "" for x in (find(c, "Key")))
            trunc = find(root, "IsTruncated")
            if trunc and (trunc[0].text or "").lower() == "true":
                nt = find(root, "NextContinuationToken")
                token = nt[0].text if nt else None
                if not token:
                    break
            else:
                break
        return sorted(keys)


def store_from_spec(spec: str) -> ObjectStore:
    """'dir:/path' or 's3' (endpoint and keys from S6_S3_* environment variables)."""
    if spec.startswith("dir:"):
        return LocalStore(Path(spec[4:]))
    if spec == "s3":
        return S3Store.from_env()
    raise ValueError(f"unknown store spec {spec!r}")
