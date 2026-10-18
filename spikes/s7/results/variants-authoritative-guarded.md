# Variant results: authoritative-guarded

Generated 2026-10-18T15:19:49.153Z. Pass 174 of 174.

| ID | Group | Variant | Entry | Expect | Status | Guard | Reached handler | Settings managed | Editable flags | Result | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P01 | path | canonical path | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P01 | path | canonical path | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P02 | path | trailing slash | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P02 | path | trailing slash | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P03 | path | two trailing slashes | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P03 | path | two trailing slashes | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P04 | path | leading double slash | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P04 | path | leading double slash | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P05 | path | inner double slash | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P05 | path | inner double slash | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P06 | path | slashes everywhere | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P06 | path | slashes everywhere | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P07 | path | upper case | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P07 | path | upper case | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P08 | path | mixed case | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P08 | path | mixed case | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P09 | path | one encoded letter | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P09 | path | one encoded letter | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P10 | path | fully encoded segment | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P10 | path | fully encoded segment | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P11 | path | encoded upper case | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P11 | path | encoded upper case | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P12 | path | encoded slash | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P12 | path | encoded slash | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P13 | path | encoded slash, lower-case hex | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P13 | path | encoded slash, lower-case hex | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P14 | path | every slash encoded after the first | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P14 | path | every slash encoded after the first | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P15 | path | double-encoded letter | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P15 | path | double-encoded letter | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P16 | path | double-encoded slash | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P16 | path | double-encoded slash | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
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
| P22 | path | dot-dot with encoded slash | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P22 | path | dot-dot with encoded slash | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P23 | path | encoded slash dot-dot encoded slash | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P23 | path | encoded slash dot-dot encoded slash | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P24 | path | query string | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P24 | path | query string | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P25 | path | matrix parameter | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P25 | path | matrix parameter | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P26 | path | encoded semicolon | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P26 | path | encoded semicolon | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P27 | path | encoded NUL | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P27 | path | encoded NUL | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P28 | path | encoded trailing space | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P28 | path | encoded trailing space | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P29 | path | encoded trailing slash | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P29 | path | encoded trailing slash | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P30 | path | encoded backslash | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P30 | path | encoded backslash | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P31 | path | raw backslash | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P31 | path | raw backslash | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P32 | path | fragment in request line | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P32 | path | fragment in request line | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P33 | path | absolute-form request target | browser | refuse | 500 | - | no | yes | - | pass | rejected before the Worker (status 500) |
| P33 | path | absolute-form request target | computer | refuse | 500 | - | no | yes | - | pass | rejected before the Worker (status 500) |
| P34 | path | absolute-form target naming the private host | browser | refuse | 500 | - | no | yes | - | pass | rejected before the Worker (status 500) |
| P34 | path | absolute-form target naming the private host | computer | refuse | 500 | - | no | yes | - | pass | rejected before the Worker (status 500) |
| P35 | path | trailing dot | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P35 | path | trailing dot | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P36 | path | HTTP/1.0 request | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| P36 | path | HTTP/1.0 request | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| M01 | method | POST | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| M01 | method | POST | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| M02 | method | PATCH | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| M02 | method | PATCH | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| M03 | method | DELETE | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| M03 | method | DELETE | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| M04 | method | OPTIONS | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| M04 | method | OPTIONS | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| M05 | method | lower-case put | browser | refuse | 501 | - | no | yes | - | pass | rejected before the Worker (status 501) |
| M05 | method | lower-case put | computer | refuse | 501 | - | no | yes | - | pass | rejected before the Worker (status 501) |
| M06 | method | mixed-case Put | browser | refuse | 501 | - | no | yes | - | pass | rejected before the Worker (status 501) |
| M06 | method | mixed-case Put | computer | refuse | 501 | - | no | yes | - | pass | rejected before the Worker (status 501) |
| M07 | method | WebDAV PROPPATCH | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| M07 | method | WebDAV PROPPATCH | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| M08 | method | unknown method | browser | refuse | 501 | - | no | yes | - | pass | rejected before the Worker (status 501) |
| M08 | method | unknown method | computer | refuse | 501 | - | no | yes | - | pass | rejected before the Worker (status 501) |
| M09 | method | TRACE | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| M09 | method | TRACE | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| O01 | override | GET with X-HTTP-Method-Override: PUT | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| O01 | override | GET with X-HTTP-Method-Override: PUT | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| O02 | override | GET with X-HTTP-Method: PUT | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| O02 | override | GET with X-HTTP-Method: PUT | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| O03 | override | GET with X-Method-Override: PUT | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| O03 | override | GET with X-Method-Override: PUT | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| O04 | override | POST with X-HTTP-Method-Override: PUT | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| O04 | override | POST with X-HTTP-Method-Override: PUT | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| O05 | override | GET with ?_method=PUT | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| O05 | override | GET with ?_method=PUT | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| O06 | override | WebSocket upgrade | browser | refuse | 403 | refused | no | yes | - | pass | refused by guard |
| O06 | override | WebSocket upgrade | computer | refuse | 403 | refused | no | yes | - | pass | refused by guard |
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
| G02 | get | HEAD, headers only | browser | rewrite | 404 | managed-passthrough | no | yes | unparseable | pass | not rewritable, passed through: upstream 404 |
| G02 | get | HEAD, headers only | computer | rewrite | 404 | managed-passthrough | no | yes | unparseable | pass | not rewritable, passed through: upstream 404 |
| G03 | get | GET with encoded letter | browser | rewrite | 200 | rewritten | no | yes | editable=false public_sharing_editable=false public_sharing_max_level_editable=false default_public_sessions_editable=false | pass | rewritten as managed |
| G03 | get | GET with encoded letter | computer | rewrite | 200 | rewritten | no | yes | editable=false public_sharing_editable=false public_sharing_max_level_editable=false default_public_sessions_editable=false | pass | rewritten as managed |
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
172.17.0.1:34848 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34850 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34866 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34882 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34886 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34896 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34912 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34922 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34936 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34940 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34944 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34956 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34962 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34974 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34980 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34992 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:35006 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:35020 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:35026 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:35042 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:35048 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:35060 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:41922 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:41928 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:41932 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:41940 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:41952 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:41956 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:41966 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:41972 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:41976 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:41986 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:41996 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42002 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42016 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42018 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42024 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42030 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42046 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42052 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42064 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42080 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42084 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42096 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42110 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42120 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42124 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42132 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42148 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42156 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42160 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42166 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42178 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42186 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42192 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42196 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42212 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42224 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42238 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42240 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42248 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42264 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42272 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42282 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42294 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42298 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42302 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42316 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42318 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42334 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42344 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42354 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42360 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42366 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42378 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42382 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42398 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42400 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42416 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42426 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42432 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42446 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42454 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42468 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42472 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42484 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42490 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42500 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42506 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42514 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42528 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42538 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42542 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42548 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42562 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42564 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42572 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42574 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42576 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42584 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42600 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42616 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42624 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42626 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42628 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42640 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42656 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42672 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42686 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42696 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42704 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42712 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42718 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42726 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42728 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42738 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42744 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42750 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42764 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42778 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42790 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42796 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42808 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42814 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:42820 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40060 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40074 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40086 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40098 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40102 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40104 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40112 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40116 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40120 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40134 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40146 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40160 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40168 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40174 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40176 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40192 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40204 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40216 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40230 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40236 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40240 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40256 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40266 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40270 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40280 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40292 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40300 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40312 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40326 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40334 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40348 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40354 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40326 - "HEAD /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:40358 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40348 - "HEAD /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:40362 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40326 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40376 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40348 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40386 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40326 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40398 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40348 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40406 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40326 - "GET /v1/sharing HTTP/1.1" 401 Unauthorized
172.17.0.1:40420 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40348 - "GET /v1/sharing HTTP/1.1" 401 Unauthorized
172.17.0.1:40436 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40446 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40458 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40326 - "PUT /v1/sharingx HTTP/1.1" 404 Not Found
172.17.0.1:40468 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40348 - "PUT /v1/sharingx HTTP/1.1" 404 Not Found
172.17.0.1:40472 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40326 - "PUT /v1/sharing-x HTTP/1.1" 404 Not Found
172.17.0.1:40488 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40348 - "PUT /v1/sharing-x HTTP/1.1" 404 Not Found
172.17.0.1:40502 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40326 - "PUT /x/v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:40510 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40348 - "PUT /x/v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:40512 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40514 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40528 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40326 - "PUT /v1/sessions/abc/sharing HTTP/1.1" 404 Not Found
172.17.0.1:40540 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:40348 - "PUT /v1/sessions/abc/sharing HTTP/1.1" 404 Not Found
172.17.0.1:40544 - "GET /v1/sharing HTTP/1.1" 200 OK
```
