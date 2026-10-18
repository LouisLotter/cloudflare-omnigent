"""Record how Omnigent's request models validate input, as fixtures for the fake Omnigent API.

The fake (worker/test/support/fake-omnigent.ts) must not become its own authority on what the
real server accepts. This script runs the real `SetSharingRequest` model, taken from Omnigent's
source by AST so nothing is retyped, and the `limit` query parameter of the runs route, through
FastAPI, and prints what each input produces. worker/test/unit/fake-omnigent.test.ts replays every
case against the fake.

    python -I record_validation.py /path/to/omnigent > validation.json

Run it with the FastAPI, Pydantic and pydantic-core versions Omnigent locks (uv.lock) where
possible; the versions used are recorded in the output.
"""

import ast
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import fastapi
import pydantic
import pydantic_core
from fastapi import FastAPI, Query
from fastapi.testclient import TestClient
from pydantic import BaseModel


def load_set_sharing_request(omnigent: Path) -> tuple[type[BaseModel], str]:
    """Compile the SetSharingRequest class exactly as written in Omnigent's sharing route."""
    source_path = omnigent / "omnigent" / "server" / "routes" / "sharing.py"
    source = source_path.read_text()
    tree = ast.parse(source)
    node = next(
        item
        for item in tree.body
        if isinstance(item, ast.ClassDef) and item.name == "SetSharingRequest"
    )
    namespace: dict[str, Any] = {"BaseModel": BaseModel}
    module = ast.Module(body=[node], type_ignores=[])
    exec(compile(module, str(source_path), "exec"), namespace)
    digest = hashlib.sha256(source.encode()).hexdigest()
    return namespace["SetSharingRequest"], digest


def main() -> None:
    omnigent = Path(sys.argv[1])
    set_sharing_request, sharing_digest = load_set_sharing_request(omnigent)
    scheduled_digest = hashlib.sha256(
        (omnigent / "omnigent" / "server" / "routes" / "scheduled_tasks.py").read_bytes()
    ).hexdigest()

    app = FastAPI()

    @app.put("/v1/sharing")
    async def put_sharing(body: set_sharing_request) -> dict[str, Any]:  # type: ignore[valid-type]
        # The validated model; the route's own rules (sharing.py:139-222) come after this.
        return body.model_dump()

    # The runs route's query parameters: omnigent/server/routes/scheduled_tasks.py:476-477.
    @app.get("/runs")
    async def runs(
        limit: int = Query(default=100, ge=1, le=1000),
        after: str | None = Query(default=None),
    ) -> dict[str, Any]:
        return {"limit": limit, "after": after}

    client = TestClient(app)
    json_type = {"content-type": "application/json"}

    sharing_cases: list[dict[str, Any]] = []
    public_sharing_values: list[Any] = [
        True, False, None, 0, 1, 2, -1, 0.0, 1.0, 1.5, "true", "True", "TRUE", "false",
        "False", "yes", "YeS", "no", "y", "n", "on", "off", "oFF", "t", "f", "1", "0",
        " true", "true ", "", "maybe", "2", "1.0", [], {}, [True],
    ]
    bodies = [json.dumps({"public_sharing": value}) for value in public_sharing_values]
    bodies += [
        json.dumps({"sharing_mode": 3}),
        json.dumps({"sharing_mode": True}),
        json.dumps({"sharing_mode": None}),
        json.dumps({"sharing_mode": "off", "public_sharing": "yes", "unknown": 1}),
        json.dumps({"sharing_mode": 1, "public_sharing": "maybe"}),
        "",
        "null",
        "[]",
        "3",
        "{not json",
    ]
    for body in bodies:
        response = client.put("/v1/sharing", content=body, headers=json_type)
        sharing_cases.append(
            {
                "body": body,
                "contentType": "application/json",
                "status": response.status_code,
                "response": response.json(),
            }
        )
    for content_type in [None, "text/plain", "application/merge-patch+json"]:
        body = json.dumps({"public_sharing": True})
        headers = {} if content_type is None else {"content-type": content_type}
        response = client.put("/v1/sharing", content=body, headers=headers)
        sharing_cases.append(
            {
                "body": body,
                "contentType": content_type,
                "status": response.status_code,
                "response": response.json(),
            }
        )

    limit_cases: list[dict[str, Any]] = []
    for raw in ["5", " 5", "+5", "05", "5_0", "5.0", "1000", "-5", "0", "1001", "5.5", "1e2",
                "ten", ""]:
        response = client.get("/runs", params={"limit": raw})
        limit_cases.append(
            {"limit": raw, "status": response.status_code, "response": response.json()}
        )

    json.dump(
        {
            "recordedWith": {
                "fastapi": fastapi.__version__,
                "pydantic": pydantic.VERSION,
                "pydantic_core": pydantic_core.__version__,
            },
            "sources": {
                "omnigent/server/routes/sharing.py": sharing_digest,
                "omnigent/server/routes/scheduled_tasks.py": scheduled_digest,
            },
            "putSharing": sharing_cases,
            "runsLimit": limit_cases,
        },
        sys.stdout,
        indent=2,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
