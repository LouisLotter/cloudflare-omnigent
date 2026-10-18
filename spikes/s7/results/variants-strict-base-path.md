# Variant results: strict-base-path

Generated 2026-10-18T15:19:11.426Z. Pass 10 of 10.

| ID | Group | Variant | Entry | Expect | Status | Guard | Reached handler | Settings managed | Editable flags | Result | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| B01 | base-path | base path prefix | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| B01 | base-path | base path prefix | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| B02 | base-path | base path, encoded | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| B02 | base-path | base path, encoded | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| B03 | base-path | canonical path without the prefix | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| B03 | base-path | canonical path without the prefix | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| B04 | base-path | GET under the base path, rewritten | browser | rewrite | 200 | rewritten | no | yes | editable=false public_sharing_editable=false public_sharing_max_level_editable=false default_public_sessions_editable=false | pass | rewritten as managed |
| B04 | base-path | GET under the base path, rewritten | computer | rewrite | 200 | rewritten | no | yes | editable=false public_sharing_editable=false public_sharing_max_level_editable=false default_public_sessions_editable=false | pass | rewritten as managed |
| B05 | base-path | upper-case base path | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| B05 | base-path | upper-case base path | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |

## Omnigent access-log lines mentioning sharing during the run

```
172.17.0.1:56322 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:56334 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:56344 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:56360 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:56366 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:56376 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:56392 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:56214 - "GET /omni/v1/sharing HTTP/1.1" 200 OK
172.17.0.1:56402 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:56228 - "GET /omni/v1/sharing HTTP/1.1" 200 OK
172.17.0.1:56412 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:56426 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:56428 - "GET /v1/sharing HTTP/1.1" 200 OK
```
