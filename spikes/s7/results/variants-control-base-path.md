# Variant results: control-base-path

Generated 2026-10-18T15:19:10.267Z. Pass 5 of 5.

| ID | Group | Variant | Entry | Expect | Status | Guard | Reached handler | Settings managed | Editable flags | Result | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| B01 | base-path | base path prefix | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| B02 | base-path | base path, encoded | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| B03 | base-path | canonical path without the prefix | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| B04 | base-path | GET under the base path, rewritten | direct | rewrite | 200 | - | no | yes | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | no write |
| B05 | base-path | upper-case base path | direct | refuse | 404 | - | no | yes | - | pass | no write |

## Omnigent access-log lines mentioning sharing during the run

```
172.17.0.1:56238 - "PUT /omni/v1/sharing HTTP/1.1" 200 OK
172.17.0.1:56252 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:56254 - "PUT /omni/v1/sharing HTTP/1.1" 200 OK
172.17.0.1:56264 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:56270 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:56278 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:56282 - "GET /omni/v1/sharing HTTP/1.1" 200 OK
172.17.0.1:56290 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:56304 - "PUT /OMNI/v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:56306 - "GET /v1/sharing HTTP/1.1" 200 OK
```
