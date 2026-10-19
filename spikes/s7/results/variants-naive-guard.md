# Variant results: naive-guard

Generated 2026-10-18T15:18:57.152Z. Pass 98 of 174.

| ID | Group | Variant | Entry | Expect | Status | Guard | Reached handler | Settings managed | Editable flags | Result | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P01 | path | canonical path | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P01 | path | canonical path | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P02 | path | trailing slash | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P02 | path | trailing slash | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P03 | path | two trailing slashes | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P03 | path | two trailing slashes | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P04 | path | leading double slash | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P04 | path | leading double slash | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P05 | path | inner double slash | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P05 | path | inner double slash | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P06 | path | slashes everywhere | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P06 | path | slashes everywhere | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P07 | path | upper case | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P07 | path | upper case | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P08 | path | mixed case | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P08 | path | mixed case | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P09 | path | one encoded letter | browser | refuse | 200 | forwarded | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | FAIL | WRITE REACHED OMNIGENT |
| P09 | path | one encoded letter | computer | refuse | 200 | forwarded | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | FAIL | WRITE REACHED OMNIGENT |
| P10 | path | fully encoded segment | browser | refuse | 200 | forwarded | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | FAIL | WRITE REACHED OMNIGENT |
| P10 | path | fully encoded segment | computer | refuse | 200 | forwarded | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | FAIL | WRITE REACHED OMNIGENT |
| P11 | path | encoded upper case | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P11 | path | encoded upper case | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P12 | path | encoded slash | browser | refuse | 200 | forwarded | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | FAIL | WRITE REACHED OMNIGENT |
| P12 | path | encoded slash | computer | refuse | 200 | forwarded | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | FAIL | WRITE REACHED OMNIGENT |
| P13 | path | encoded slash, lower-case hex | browser | refuse | 200 | forwarded | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | FAIL | WRITE REACHED OMNIGENT |
| P13 | path | encoded slash, lower-case hex | computer | refuse | 200 | forwarded | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | FAIL | WRITE REACHED OMNIGENT |
| P14 | path | every slash encoded after the first | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P14 | path | every slash encoded after the first | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P15 | path | double-encoded letter | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P15 | path | double-encoded letter | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P16 | path | double-encoded slash | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P16 | path | double-encoded slash | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P17 | path | dot segment | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P17 | path | dot segment | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P18 | path | dot-dot segment | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P18 | path | dot-dot segment | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P19 | path | leading dot segment | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P19 | path | leading dot segment | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P20 | path | encoded dot segment | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P20 | path | encoded dot segment | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P21 | path | encoded dot-dot segment | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P21 | path | encoded dot-dot segment | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P22 | path | dot-dot with encoded slash | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P22 | path | dot-dot with encoded slash | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P23 | path | encoded slash dot-dot encoded slash | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P23 | path | encoded slash dot-dot encoded slash | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P24 | path | query string | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P24 | path | query string | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P25 | path | matrix parameter | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P25 | path | matrix parameter | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P26 | path | encoded semicolon | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P26 | path | encoded semicolon | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P27 | path | encoded NUL | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P27 | path | encoded NUL | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P28 | path | encoded trailing space | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P28 | path | encoded trailing space | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P29 | path | encoded trailing slash | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P29 | path | encoded trailing slash | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P30 | path | encoded backslash | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P30 | path | encoded backslash | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P31 | path | raw backslash | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P31 | path | raw backslash | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P32 | path | fragment in request line | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P32 | path | fragment in request line | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P33 | path | absolute-form request target | browser | refuse | 500 | - | no | yes | - | pass | rejected before the Worker (status 500) |
| P33 | path | absolute-form request target | computer | refuse | 500 | - | no | yes | - | pass | rejected before the Worker (status 500) |
| P34 | path | absolute-form target naming the private host | browser | refuse | 500 | - | no | yes | - | pass | rejected before the Worker (status 500) |
| P34 | path | absolute-form target naming the private host | computer | refuse | 500 | - | no | yes | - | pass | rejected before the Worker (status 500) |
| P35 | path | trailing dot | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P35 | path | trailing dot | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| P36 | path | HTTP/1.0 request | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P36 | path | HTTP/1.0 request | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| M01 | method | POST | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| M01 | method | POST | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| M02 | method | PATCH | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| M02 | method | PATCH | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| M03 | method | DELETE | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| M03 | method | DELETE | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| M04 | method | OPTIONS | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| M04 | method | OPTIONS | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| M05 | method | lower-case put | browser | refuse | 501 | - | no | yes | - | pass | rejected before the Worker (status 501) |
| M05 | method | lower-case put | computer | refuse | 501 | - | no | yes | - | pass | rejected before the Worker (status 501) |
| M06 | method | mixed-case Put | browser | refuse | 501 | - | no | yes | - | pass | rejected before the Worker (status 501) |
| M06 | method | mixed-case Put | computer | refuse | 501 | - | no | yes | - | pass | rejected before the Worker (status 501) |
| M07 | method | WebDAV PROPPATCH | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| M07 | method | WebDAV PROPPATCH | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| M08 | method | unknown method | browser | refuse | 501 | - | no | yes | - | pass | rejected before the Worker (status 501) |
| M08 | method | unknown method | computer | refuse | 501 | - | no | yes | - | pass | rejected before the Worker (status 501) |
| M09 | method | TRACE | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| M09 | method | TRACE | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| O01 | override | GET with X-HTTP-Method-Override: PUT | browser | refuse | 200 | rewritten | no | yes | editable=false public_sharing_editable=false public_sharing_max_level_editable=false default_public_sessions_editable=false | FAIL | not refused (guard=rewritten) |
| O01 | override | GET with X-HTTP-Method-Override: PUT | computer | refuse | 200 | rewritten | no | yes | editable=false public_sharing_editable=false public_sharing_max_level_editable=false default_public_sessions_editable=false | FAIL | not refused (guard=rewritten) |
| O02 | override | GET with X-HTTP-Method: PUT | browser | refuse | 200 | rewritten | no | yes | editable=false public_sharing_editable=false public_sharing_max_level_editable=false default_public_sessions_editable=false | FAIL | not refused (guard=rewritten) |
| O02 | override | GET with X-HTTP-Method: PUT | computer | refuse | 200 | rewritten | no | yes | editable=false public_sharing_editable=false public_sharing_max_level_editable=false default_public_sessions_editable=false | FAIL | not refused (guard=rewritten) |
| O03 | override | GET with X-Method-Override: PUT | browser | refuse | 200 | rewritten | no | yes | editable=false public_sharing_editable=false public_sharing_max_level_editable=false default_public_sessions_editable=false | FAIL | not refused (guard=rewritten) |
| O03 | override | GET with X-Method-Override: PUT | computer | refuse | 200 | rewritten | no | yes | editable=false public_sharing_editable=false public_sharing_max_level_editable=false default_public_sessions_editable=false | FAIL | not refused (guard=rewritten) |
| O04 | override | POST with X-HTTP-Method-Override: PUT | browser | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| O04 | override | POST with X-HTTP-Method-Override: PUT | computer | refuse | 404 | forwarded | no | yes | - | FAIL | not refused (guard=forwarded) |
| O05 | override | GET with ?_method=PUT | browser | refuse | 200 | rewritten | no | yes | editable=false public_sharing_editable=false public_sharing_max_level_editable=false default_public_sessions_editable=false | FAIL | not refused (guard=rewritten) |
| O05 | override | GET with ?_method=PUT | computer | refuse | 200 | rewritten | no | yes | editable=false public_sharing_editable=false public_sharing_max_level_editable=false default_public_sessions_editable=false | FAIL | not refused (guard=rewritten) |
| O06 | override | WebSocket upgrade | browser | refuse | 403 | managed-passthrough | no | yes | - | FAIL | not refused (guard=managed-passthrough) |
| O06 | override | WebSocket upgrade | computer | refuse | 403 | managed-passthrough | no | yes | - | FAIL | not refused (guard=managed-passthrough) |
| D01 | body | JSON boolean true | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D01 | body | JSON boolean true | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D02 | body | lax boolean "true" | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D02 | body | lax boolean "true" | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D03 | body | lax boolean "yes" | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D03 | body | lax boolean "yes" | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D04 | body | lax boolean "on" | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D04 | body | lax boolean "on" | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D05 | body | lax boolean 1 | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D05 | body | lax boolean 1 | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D06 | body | lax boolean "1" | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D06 | body | lax boolean "1" | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D07 | body | lax boolean "t" | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D07 | body | lax boolean "t" | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D08 | body | lax boolean "YES" | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D08 | body | lax boolean "YES" | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D09 | body | mode in upper case | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D09 | body | mode in upper case | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D10 | body | mode with spaces | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D10 | body | mode with spaces | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D11 | body | default public sessions | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D11 | body | default public sessions | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D12 | body | public permission ceiling | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D12 | body | public permission ceiling | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D13 | body | duplicate key, last wins | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D13 | body | duplicate key, last wins | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D14 | body | escaped key | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D14 | body | escaped key | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D15 | body | unknown extra field | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D15 | body | unknown extra field | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D16 | body | no Content-Type | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D16 | body | no Content-Type | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D17 | body | text/plain Content-Type | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D17 | body | text/plain Content-Type | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D18 | body | form-encoded body | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D18 | body | form-encoded body | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D19 | body | chunked transfer encoding | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D19 | body | chunked transfer encoding | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D20 | body | gzip Content-Encoding | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D20 | body | gzip Content-Encoding | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D21 | body | no body | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D21 | body | no body | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D22 | body | empty object | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D22 | body | empty object | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D23 | body | UTF-8 byte order mark | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D23 | body | UTF-8 byte order mark | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D24 | body | the managed value itself (a no-op that still writes a file) | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D24 | body | the managed value itself (a no-op that still writes a file) | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D25 | body | +json media type | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| D25 | body | +json media type | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| G01 | get | GET, rewritten as managed | browser | rewrite | 200 | rewritten | no | yes | editable=false public_sharing_editable=false public_sharing_max_level_editable=false default_public_sessions_editable=false | pass | rewritten as managed |
| G01 | get | GET, rewritten as managed | computer | rewrite | 200 | rewritten | no | yes | editable=false public_sharing_editable=false public_sharing_max_level_editable=false default_public_sessions_editable=false | pass | rewritten as managed |
| G02 | get | HEAD, headers only | browser | rewrite | 404 | forwarded | no | yes | unparseable | FAIL | not rewritable, passed through: upstream 404 |
| G02 | get | HEAD, headers only | computer | rewrite | 404 | forwarded | no | yes | unparseable | FAIL | not rewritable, passed through: upstream 404 |
| G03 | get | GET with encoded letter | browser | rewrite | 200 | forwarded | no | yes | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | FAIL | an editable flag is not false |
| G03 | get | GET with encoded letter | computer | rewrite | 200 | forwarded | no | yes | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | FAIL | an editable flag is not false |
| G04 | get | GET with gzip accepted | browser | rewrite | 200 | rewritten | no | yes | unparseable | pass | rewritten as managed |
| G04 | get | GET with gzip accepted | computer | rewrite | 200 | rewritten | no | yes | unparseable | pass | rewritten as managed |
| G05 | get | GET without credentials (401 passes through) | browser | rewrite | 401 | managed-passthrough | no | yes | - | pass | not rewritable, passed through: upstream 401 |
| G05 | get | GET without credentials (401 passes through) | computer | rewrite | 401 | managed-passthrough | no | yes | - | pass | not rewritable, passed through: upstream 401 |
| G06 | get | GET /v1/info (not a managed path) | browser | forward | 200 | forwarded | no | yes | editable=undefined public_sharing_editable=undefined public_sharing_max_level_editable=undefined default_public_sessions_editable=undefined | pass | forwarded, upstream 200 |
| G06 | get | GET /v1/info (not a managed path) | computer | forward | 200 | forwarded | no | yes | editable=undefined public_sharing_editable=undefined public_sharing_max_level_editable=undefined default_public_sessions_editable=undefined | pass | forwarded, upstream 200 |
| N01 | near-miss | longer last segment | browser | forward | 404 | forwarded | no | yes | - | pass | forwarded, upstream 404 |
| N01 | near-miss | longer last segment | computer | forward | 404 | forwarded | no | yes | - | pass | forwarded, upstream 404 |
| N02 | near-miss | suffixed last segment | browser | forward | 404 | forwarded | no | yes | - | pass | forwarded, upstream 404 |
| N02 | near-miss | suffixed last segment | computer | forward | 404 | forwarded | no | yes | - | pass | forwarded, upstream 404 |
| N03 | near-miss | unknown prefix (no base path configured) | browser | forward | 404 | forwarded | no | yes | - | pass | forwarded, upstream 404 |
| N03 | near-miss | unknown prefix (no base path configured) | computer | forward | 404 | forwarded | no | yes | - | pass | forwarded, upstream 404 |
| N04 | near-miss | full-width letter | browser | forward | 404 | forwarded | no | yes | - | pass | forwarded, upstream 404 |
| N04 | near-miss | full-width letter | computer | forward | 404 | forwarded | no | yes | - | pass | forwarded, upstream 404 |
| N05 | near-miss | sub-resource of a session | browser | forward | 404 | forwarded | no | yes | - | pass | forwarded, upstream 404 |
| N05 | near-miss | sub-resource of a session | computer | forward | 404 | forwarded | no | yes | - | pass | forwarded, upstream 404 |

## Omnigent access-log lines mentioning sharing during the run

```
172.17.0.1:34436 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34442 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34458 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT /v1/sharing/ HTTP/1.1" 404 Not Found
172.17.0.1:34462 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT /v1/sharing/ HTTP/1.1" 404 Not Found
172.17.0.1:34466 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT /v1/sharing// HTTP/1.1" 404 Not Found
172.17.0.1:34468 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT /v1/sharing// HTTP/1.1" 404 Not Found
172.17.0.1:34474 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT //v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:34480 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT //v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:34482 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT /v1//sharing HTTP/1.1" 404 Not Found
172.17.0.1:34498 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT /v1//sharing HTTP/1.1" 404 Not Found
172.17.0.1:34500 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT ///v1///sharing/// HTTP/1.1" 404 Not Found
172.17.0.1:34508 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT ///v1///sharing/// HTTP/1.1" 404 Not Found
172.17.0.1:34516 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT /V1/SHARING HTTP/1.1" 404 Not Found
172.17.0.1:34524 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT /V1/SHARING HTTP/1.1" 404 Not Found
172.17.0.1:34530 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT /v1/Sharing HTTP/1.1" 404 Not Found
172.17.0.1:34532 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT /v1/Sharing HTTP/1.1" 404 Not Found
172.17.0.1:34542 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34548 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34558 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34572 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34576 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT /v1/SHARING HTTP/1.1" 404 Not Found
172.17.0.1:34588 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT /v1/SHARING HTTP/1.1" 404 Not Found
172.17.0.1:34604 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34610 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34614 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34618 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34632 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT //v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:34642 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT //v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:34658 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34674 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34690 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT /v1%252Fsharing HTTP/1.1" 404 Not Found
172.17.0.1:34694 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT /v1%252Fsharing HTTP/1.1" 404 Not Found
172.17.0.1:34706 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34708 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34716 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34724 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34732 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34736 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34740 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34752 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34768 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34770 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34784 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT /v1/x/../sharing HTTP/1.1" 404 Not Found
172.17.0.1:54982 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT /v1/x/../sharing HTTP/1.1" 404 Not Found
172.17.0.1:54996 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT /v1/x/../sharing HTTP/1.1" 404 Not Found
172.17.0.1:55002 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT /v1/x/../sharing HTTP/1.1" 404 Not Found
172.17.0.1:55016 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55026 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55034 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT /v1/sharing%3Bx%3D1 HTTP/1.1" 404 Not Found
172.17.0.1:55050 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT /v1/sharing%3Bx%3D1 HTTP/1.1" 404 Not Found
172.17.0.1:55054 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT /v1/sharing%3Bx%3D1 HTTP/1.1" 404 Not Found
172.17.0.1:55062 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT /v1/sharing%3Bx%3D1 HTTP/1.1" 404 Not Found
172.17.0.1:55064 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT /v1/sharing%00 HTTP/1.1" 404 Not Found
172.17.0.1:55080 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT /v1/sharing%00 HTTP/1.1" 404 Not Found
172.17.0.1:55084 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT /v1/sharing%20 HTTP/1.1" 404 Not Found
172.17.0.1:55100 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT /v1/sharing%20 HTTP/1.1" 404 Not Found
172.17.0.1:55106 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT /v1/sharing/ HTTP/1.1" 404 Not Found
172.17.0.1:55110 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT /v1/sharing/ HTTP/1.1" 404 Not Found
172.17.0.1:55114 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT /v1%5Csharing HTTP/1.1" 404 Not Found
172.17.0.1:55128 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT /v1%5Csharing HTTP/1.1" 404 Not Found
172.17.0.1:55130 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55136 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55142 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55144 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55160 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55166 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55168 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55176 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55184 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PUT /v1/sharing. HTTP/1.1" 404 Not Found
172.17.0.1:55190 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PUT /v1/sharing. HTTP/1.1" 404 Not Found
172.17.0.1:55204 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55212 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55220 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "POST /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:55226 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "POST /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:55242 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PATCH /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:55248 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PATCH /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:55258 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "DELETE /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:55266 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "DELETE /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:55272 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "OPTIONS /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:55284 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "OPTIONS /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:55294 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55300 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55306 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55316 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55332 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "PROPPATCH /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:55336 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "PROPPATCH /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:55338 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55348 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55356 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "TRACE /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:55364 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "TRACE /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:55366 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55374 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55378 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55394 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55406 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55416 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55428 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "POST /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:55434 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "POST /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:55450 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "GET /v1/sharing?_method=PUT HTTP/1.1" 200 OK
172.17.0.1:55466 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34420 - "GET /v1/sharing?_method=PUT HTTP/1.1" 200 OK
172.17.0.1:55474 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55476 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55480 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55494 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55502 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55512 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55524 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55530 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55540 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55546 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55556 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55564 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55576 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55586 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55594 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55608 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55612 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55616 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55632 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55640 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55642 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55656 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55668 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55672 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55682 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55698 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55712 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55724 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55736 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55740 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55754 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55766 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55770 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55784 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55786 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55798 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55808 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55822 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55834 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55836 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55852 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55862 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55868 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55880 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55896 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:55902 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34770 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34772 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34778 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34786 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34790 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34800 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34814 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34826 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34834 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34848 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34856 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34826 - "HEAD /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:34868 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34848 - "HEAD /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:34872 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34826 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34880 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34848 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34886 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34826 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34900 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34848 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34914 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34826 - "GET /v1/sharing HTTP/1.1" 401 Unauthorized
172.17.0.1:34922 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34848 - "GET /v1/sharing HTTP/1.1" 401 Unauthorized
172.17.0.1:34928 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34938 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34942 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34826 - "PUT /v1/sharingx HTTP/1.1" 404 Not Found
172.17.0.1:34944 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34848 - "PUT /v1/sharingx HTTP/1.1" 404 Not Found
172.17.0.1:34946 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34826 - "PUT /v1/sharing-x HTTP/1.1" 404 Not Found
172.17.0.1:34948 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34848 - "PUT /v1/sharing-x HTTP/1.1" 404 Not Found
172.17.0.1:34964 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34826 - "PUT /x/v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:34980 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34848 - "PUT /x/v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:34996 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:35006 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:35008 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34826 - "PUT /v1/sessions/abc/sharing HTTP/1.1" 404 Not Found
172.17.0.1:35010 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34848 - "PUT /v1/sessions/abc/sharing HTTP/1.1" 404 Not Found
172.17.0.1:35018 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34410 - "WebSocket /v1/sharing" 403
172.17.0.1:34420 - "WebSocket /v1/sharing" 403
```
