# Variant results: control-authoritative

Generated 2026-10-18T15:19:29.076Z. Pass 87 of 87.

| ID | Group | Variant | Entry | Expect | Status | Guard | Reached handler | Settings managed | Editable flags | Result | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P01 | path | canonical path | direct | refuse | 403 | - | no | yes | - | pass | no write |
| P02 | path | trailing slash | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P03 | path | two trailing slashes | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P04 | path | leading double slash | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P05 | path | inner double slash | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P06 | path | slashes everywhere | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P07 | path | upper case | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P08 | path | mixed case | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P09 | path | one encoded letter | direct | refuse | 403 | - | no | yes | - | pass | no write |
| P10 | path | fully encoded segment | direct | refuse | 403 | - | no | yes | - | pass | no write |
| P11 | path | encoded upper case | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P12 | path | encoded slash | direct | refuse | 403 | - | no | yes | - | pass | no write |
| P13 | path | encoded slash, lower-case hex | direct | refuse | 403 | - | no | yes | - | pass | no write |
| P14 | path | every slash encoded after the first | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P15 | path | double-encoded letter | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P16 | path | double-encoded slash | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P17 | path | dot segment | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P18 | path | dot-dot segment | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P19 | path | leading dot segment | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P20 | path | encoded dot segment | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P21 | path | encoded dot-dot segment | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P22 | path | dot-dot with encoded slash | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P23 | path | encoded slash dot-dot encoded slash | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P24 | path | query string | direct | refuse | 403 | - | no | yes | - | pass | no write |
| P25 | path | matrix parameter | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P26 | path | encoded semicolon | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P27 | path | encoded NUL | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P28 | path | encoded trailing space | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P29 | path | encoded trailing slash | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P30 | path | encoded backslash | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P31 | path | raw backslash | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P32 | path | fragment in request line | direct | refuse | 403 | - | no | yes | - | pass | no write |
| P33 | path | absolute-form request target | direct | refuse | 403 | - | no | yes | - | pass | no write |
| P34 | path | absolute-form target naming the private host | direct | refuse | 403 | - | no | yes | - | pass | no write |
| P35 | path | trailing dot | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P36 | path | HTTP/1.0 request | direct | refuse | 403 | - | no | yes | - | pass | no write |
| M01 | method | POST | direct | refuse | 404 | - | no | yes | - | pass | no write |
| M02 | method | PATCH | direct | refuse | 404 | - | no | yes | - | pass | no write |
| M03 | method | DELETE | direct | refuse | 404 | - | no | yes | - | pass | no write |
| M04 | method | OPTIONS | direct | refuse | 404 | - | no | yes | - | pass | no write |
| M05 | method | lower-case put | direct | refuse | 400 | - | no | yes | - | pass | no write |
| M06 | method | mixed-case Put | direct | refuse | 400 | - | no | yes | - | pass | no write |
| M07 | method | WebDAV PROPPATCH | direct | refuse | 404 | - | no | yes | - | pass | no write |
| M08 | method | unknown method | direct | refuse | 400 | - | no | yes | - | pass | no write |
| M09 | method | TRACE | direct | refuse | 404 | - | no | yes | - | pass | no write |
| O01 | override | GET with X-HTTP-Method-Override: PUT | direct | refuse | 200 | - | no | yes | editable=false public_sharing_editable=false public_sharing_max_level_editable=false default_public_sessions_editable=false | pass | no write |
| O02 | override | GET with X-HTTP-Method: PUT | direct | refuse | 200 | - | no | yes | editable=false public_sharing_editable=false public_sharing_max_level_editable=false default_public_sessions_editable=false | pass | no write |
| O03 | override | GET with X-Method-Override: PUT | direct | refuse | 200 | - | no | yes | editable=false public_sharing_editable=false public_sharing_max_level_editable=false default_public_sessions_editable=false | pass | no write |
| O04 | override | POST with X-HTTP-Method-Override: PUT | direct | refuse | 404 | - | no | yes | - | pass | no write |
| O05 | override | GET with ?_method=PUT | direct | refuse | 200 | - | no | yes | editable=false public_sharing_editable=false public_sharing_max_level_editable=false default_public_sessions_editable=false | pass | no write |
| O06 | override | WebSocket upgrade | direct | refuse | 200 | - | no | yes | editable=false public_sharing_editable=false public_sharing_max_level_editable=false default_public_sessions_editable=false | pass | no write |
| D01 | body | JSON boolean true | direct | refuse | 403 | - | no | yes | - | pass | no write |
| D02 | body | lax boolean "true" | direct | refuse | 403 | - | no | yes | - | pass | no write |
| D03 | body | lax boolean "yes" | direct | refuse | 403 | - | no | yes | - | pass | no write |
| D04 | body | lax boolean "on" | direct | refuse | 403 | - | no | yes | - | pass | no write |
| D05 | body | lax boolean 1 | direct | refuse | 403 | - | no | yes | - | pass | no write |
| D06 | body | lax boolean "1" | direct | refuse | 403 | - | no | yes | - | pass | no write |
| D07 | body | lax boolean "t" | direct | refuse | 403 | - | no | yes | - | pass | no write |
| D08 | body | lax boolean "YES" | direct | refuse | 403 | - | no | yes | - | pass | no write |
| D09 | body | mode in upper case | direct | refuse | 403 | - | no | yes | - | pass | no write |
| D10 | body | mode with spaces | direct | refuse | 403 | - | no | yes | - | pass | no write |
| D11 | body | default public sessions | direct | refuse | 403 | - | no | yes | - | pass | no write |
| D12 | body | public permission ceiling | direct | refuse | 403 | - | no | yes | - | pass | no write |
| D13 | body | duplicate key, last wins | direct | refuse | 403 | - | no | yes | - | pass | no write |
| D14 | body | escaped key | direct | refuse | 403 | - | no | yes | - | pass | no write |
| D15 | body | unknown extra field | direct | refuse | 403 | - | no | yes | - | pass | no write |
| D16 | body | no Content-Type | direct | refuse | 422 | - | no | yes | - | pass | no write |
| D17 | body | text/plain Content-Type | direct | refuse | 422 | - | no | yes | - | pass | no write |
| D18 | body | form-encoded body | direct | refuse | 422 | - | no | yes | - | pass | no write |
| D19 | body | chunked transfer encoding | direct | refuse | 403 | - | no | yes | - | pass | no write |
| D20 | body | gzip Content-Encoding | direct | refuse | 400 | - | no | yes | - | pass | no write |
| D21 | body | no body | direct | refuse | 422 | - | no | yes | - | pass | no write |
| D22 | body | empty object | direct | refuse | 400 | - | no | yes | - | pass | no write |
| D23 | body | UTF-8 byte order mark | direct | refuse | 403 | - | no | yes | - | pass | no write |
| D24 | body | the managed value itself (a no-op that still writes a file) | direct | refuse | 403 | - | no | yes | - | pass | no write |
| D25 | body | +json media type | direct | refuse | 403 | - | no | yes | - | pass | no write |
| G01 | get | GET, rewritten as managed | direct | rewrite | 200 | - | no | yes | editable=false public_sharing_editable=false public_sharing_max_level_editable=false default_public_sessions_editable=false | pass | no write |
| G02 | get | HEAD, headers only | direct | rewrite | 404 | - | no | yes | unparseable | pass | no write |
| G03 | get | GET with encoded letter | direct | rewrite | 200 | - | no | yes | editable=false public_sharing_editable=false public_sharing_max_level_editable=false default_public_sessions_editable=false | pass | no write |
| G04 | get | GET with gzip accepted | direct | rewrite | 200 | - | no | yes | editable=false public_sharing_editable=false public_sharing_max_level_editable=false default_public_sessions_editable=false | pass | no write |
| G05 | get | GET without credentials (401 passes through) | direct | rewrite | 401 | - | no | yes | - | pass | no write |
| G06 | get | GET /v1/info (not a managed path) | direct | forward | 200 | - | no | yes | editable=undefined public_sharing_editable=undefined public_sharing_max_level_editable=undefined default_public_sessions_editable=undefined | pass | no write |
| N01 | near-miss | longer last segment | direct | forward | 404 | - | no | yes | - | pass | no write |
| N02 | near-miss | suffixed last segment | direct | forward | 404 | - | no | yes | - | pass | no write |
| N03 | near-miss | unknown prefix (no base path configured) | direct | forward | 404 | - | no | yes | - | pass | no write |
| N04 | near-miss | full-width letter | direct | forward | 404 | - | no | yes | - | pass | no write |
| N05 | near-miss | sub-resource of a session | direct | forward | 404 | - | no | yes | - | pass | no write |

## Omnigent access-log lines mentioning sharing during the run

```
172.17.0.1:48710 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:48720 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:48724 - "PUT /v1/sharing/ HTTP/1.1" 404 Not Found
172.17.0.1:48740 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:48742 - "PUT /v1/sharing// HTTP/1.1" 404 Not Found
172.17.0.1:48748 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:48756 - "PUT //v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:48760 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:48774 - "PUT /v1//sharing HTTP/1.1" 404 Not Found
172.17.0.1:48776 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:48790 - "PUT ///v1///sharing/// HTTP/1.1" 404 Not Found
172.17.0.1:48798 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:48810 - "PUT /V1/SHARING HTTP/1.1" 404 Not Found
172.17.0.1:48824 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:48834 - "PUT /v1/Sharing HTTP/1.1" 404 Not Found
172.17.0.1:48848 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:48860 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:48874 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:48884 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:48896 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:48898 - "PUT /v1/SHARING HTTP/1.1" 404 Not Found
172.17.0.1:48912 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:48922 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:48926 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:48928 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:48944 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:48950 - "PUT //v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:48960 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:48980 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:48988 - "PUT /v1%252Fsharing HTTP/1.1" 404 Not Found
172.17.0.1:48996 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49000 - "PUT /v1/./sharing HTTP/1.1" 404 Not Found
172.17.0.1:49006 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49014 - "PUT /v1/x/../sharing HTTP/1.1" 404 Not Found
172.17.0.1:49026 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49042 - "PUT /./v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:49052 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49062 - "PUT /v1/./sharing HTTP/1.1" 404 Not Found
172.17.0.1:49076 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49084 - "PUT /v1/x/../sharing HTTP/1.1" 404 Not Found
172.17.0.1:49096 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49106 - "PUT /v1/x/../sharing HTTP/1.1" 404 Not Found
172.17.0.1:49116 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49120 - "PUT /v1/x/../sharing HTTP/1.1" 404 Not Found
172.17.0.1:49124 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49136 - "PUT /v1/sharing?x=1 HTTP/1.1" 403 Forbidden
172.17.0.1:49138 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49146 - "PUT /v1/sharing%3Bx%3D1 HTTP/1.1" 404 Not Found
172.17.0.1:49148 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49154 - "PUT /v1/sharing%3Bx%3D1 HTTP/1.1" 404 Not Found
172.17.0.1:49160 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49176 - "PUT /v1/sharing%00 HTTP/1.1" 404 Not Found
172.17.0.1:49178 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49184 - "PUT /v1/sharing%20 HTTP/1.1" 404 Not Found
172.17.0.1:49186 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49196 - "PUT /v1/sharing/ HTTP/1.1" 404 Not Found
172.17.0.1:49212 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49226 - "PUT /v1%5Csharing HTTP/1.1" 404 Not Found
172.17.0.1:49236 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49250 - "PUT /v1%5Csharing HTTP/1.1" 404 Not Found
172.17.0.1:49252 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49260 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:49264 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49270 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:49286 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49292 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:49308 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49314 - "PUT /v1/sharing. HTTP/1.1" 404 Not Found
172.17.0.1:49318 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49334 - "PUT /v1/sharing HTTP/1.0" 403 Forbidden
172.17.0.1:49340 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49352 - "POST /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:49366 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49374 - "PATCH /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:49390 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49398 - "DELETE /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:49406 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49418 - "OPTIONS /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:49426 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49446 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49464 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49478 - "PROPPATCH /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:49482 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49488 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49504 - "TRACE /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:49514 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49528 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49540 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49546 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49550 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49562 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49564 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49570 - "POST /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:49578 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:49592 - "GET /v1/sharing?_method=PUT HTTP/1.1" 200 OK
172.17.0.1:34064 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34080 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34090 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34096 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:34106 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34112 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:34120 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34132 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:34140 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34154 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:34166 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34180 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:34196 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34200 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:34204 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34212 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:34220 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34234 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:34236 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34250 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:34262 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34270 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:34272 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34280 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:34296 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34300 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:34304 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34314 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:34328 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34340 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:34342 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34356 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:34362 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34368 - "PUT /v1/sharing HTTP/1.1" 422 Unprocessable Entity
172.17.0.1:34384 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34402 - "PUT /v1/sharing HTTP/1.1" 422 Unprocessable Entity
172.17.0.1:34412 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34416 - "PUT /v1/sharing HTTP/1.1" 422 Unprocessable Entity
172.17.0.1:34424 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34436 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:34450 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34452 - "PUT /v1/sharing HTTP/1.1" 400 Bad Request
172.17.0.1:34468 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34482 - "PUT /v1/sharing HTTP/1.1" 422 Unprocessable Entity
172.17.0.1:34484 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34486 - "PUT /v1/sharing HTTP/1.1" 400 Bad Request
172.17.0.1:34502 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34506 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:34518 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34522 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:34538 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34542 - "PUT /v1/sharing HTTP/1.1" 403 Forbidden
172.17.0.1:34548 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34554 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34556 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34568 - "HEAD /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:34578 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34584 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34598 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34612 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34620 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34632 - "GET /v1/sharing HTTP/1.1" 401 Unauthorized
172.17.0.1:34642 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34668 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34682 - "PUT /v1/sharingx HTTP/1.1" 404 Not Found
172.17.0.1:34684 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34688 - "PUT /v1/sharing-x HTTP/1.1" 404 Not Found
172.17.0.1:34704 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34718 - "PUT /x/v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:34722 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34748 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:34764 - "PUT /v1/sessions/abc/sharing HTTP/1.1" 404 Not Found
172.17.0.1:34766 - "GET /v1/sharing HTTP/1.1" 200 OK
```
