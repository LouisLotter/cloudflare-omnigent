# Variant results: control-standard

Generated 2026-10-18T15:17:20.551Z. Pass 87 of 87.

| ID | Group | Variant | Entry | Expect | Status | Guard | Reached handler | Settings managed | Editable flags | Result | Note |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P01 | path | canonical path | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| P02 | path | trailing slash | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P03 | path | two trailing slashes | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P04 | path | leading double slash | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P05 | path | inner double slash | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P06 | path | slashes everywhere | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P07 | path | upper case | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P08 | path | mixed case | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P09 | path | one encoded letter | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| P10 | path | fully encoded segment | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| P11 | path | encoded upper case | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P12 | path | encoded slash | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| P13 | path | encoded slash, lower-case hex | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
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
| P24 | path | query string | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| P25 | path | matrix parameter | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P26 | path | encoded semicolon | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P27 | path | encoded NUL | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P28 | path | encoded trailing space | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P29 | path | encoded trailing slash | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P30 | path | encoded backslash | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P31 | path | raw backslash | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P32 | path | fragment in request line | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| P33 | path | absolute-form request target | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| P34 | path | absolute-form target naming the private host | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| P35 | path | trailing dot | direct | refuse | 404 | - | no | yes | - | pass | no write |
| P36 | path | HTTP/1.0 request | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| M01 | method | POST | direct | refuse | 404 | - | no | yes | - | pass | no write |
| M02 | method | PATCH | direct | refuse | 404 | - | no | yes | - | pass | no write |
| M03 | method | DELETE | direct | refuse | 404 | - | no | yes | - | pass | no write |
| M04 | method | OPTIONS | direct | refuse | 404 | - | no | yes | - | pass | no write |
| M05 | method | lower-case put | direct | refuse | 400 | - | no | yes | - | pass | no write |
| M06 | method | mixed-case Put | direct | refuse | 400 | - | no | yes | - | pass | no write |
| M07 | method | WebDAV PROPPATCH | direct | refuse | 404 | - | no | yes | - | pass | no write |
| M08 | method | unknown method | direct | refuse | 400 | - | no | yes | - | pass | no write |
| M09 | method | TRACE | direct | refuse | 404 | - | no | yes | - | pass | no write |
| O01 | override | GET with X-HTTP-Method-Override: PUT | direct | refuse | 200 | - | no | yes | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | no write |
| O02 | override | GET with X-HTTP-Method: PUT | direct | refuse | 200 | - | no | yes | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | no write |
| O03 | override | GET with X-Method-Override: PUT | direct | refuse | 200 | - | no | yes | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | no write |
| O04 | override | POST with X-HTTP-Method-Override: PUT | direct | refuse | 404 | - | no | yes | - | pass | no write |
| O05 | override | GET with ?_method=PUT | direct | refuse | 200 | - | no | yes | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | no write |
| O06 | override | WebSocket upgrade | direct | refuse | 200 | - | no | yes | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | no write |
| D01 | body | JSON boolean true | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| D02 | body | lax boolean "true" | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| D03 | body | lax boolean "yes" | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| D04 | body | lax boolean "on" | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| D05 | body | lax boolean 1 | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| D06 | body | lax boolean "1" | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| D07 | body | lax boolean "t" | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| D08 | body | lax boolean "YES" | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| D09 | body | mode in upper case | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| D10 | body | mode with spaces | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| D11 | body | default public sessions | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| D12 | body | public permission ceiling | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| D13 | body | duplicate key, last wins | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| D14 | body | escaped key | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| D15 | body | unknown extra field | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| D16 | body | no Content-Type | direct | refuse | 422 | - | no | yes | - | pass | no write |
| D17 | body | text/plain Content-Type | direct | refuse | 422 | - | no | yes | - | pass | no write |
| D18 | body | form-encoded body | direct | refuse | 422 | - | no | yes | - | pass | no write |
| D19 | body | chunked transfer encoding | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| D20 | body | gzip Content-Encoding | direct | refuse | 400 | - | no | yes | - | pass | no write |
| D21 | body | no body | direct | refuse | 422 | - | no | yes | - | pass | no write |
| D22 | body | empty object | direct | refuse | 400 | - | no | yes | - | pass | no write |
| D23 | body | UTF-8 byte order mark | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| D24 | body | the managed value itself (a no-op that still writes a file) | direct | refuse | 200 | - | yes | yes | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| D25 | body | +json media type | direct | refuse | 200 | - | yes | no | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | reached the write handler |
| G01 | get | GET, rewritten as managed | direct | rewrite | 200 | - | no | yes | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | no write |
| G02 | get | HEAD, headers only | direct | rewrite | 404 | - | no | yes | unparseable | pass | no write |
| G03 | get | GET with encoded letter | direct | rewrite | 200 | - | no | yes | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | no write |
| G04 | get | GET with gzip accepted | direct | rewrite | 200 | - | no | yes | editable=true public_sharing_editable=true public_sharing_max_level_editable=true default_public_sessions_editable=true | pass | no write |
| G05 | get | GET without credentials (401 passes through) | direct | rewrite | 401 | - | no | yes | - | pass | no write |
| G06 | get | GET /v1/info (not a managed path) | direct | forward | 200 | - | no | yes | editable=undefined public_sharing_editable=undefined public_sharing_max_level_editable=undefined default_public_sessions_editable=undefined | pass | no write |
| N01 | near-miss | longer last segment | direct | forward | 404 | - | no | yes | - | pass | no write |
| N02 | near-miss | suffixed last segment | direct | forward | 404 | - | no | yes | - | pass | no write |
| N03 | near-miss | unknown prefix (no base path configured) | direct | forward | 404 | - | no | yes | - | pass | no write |
| N04 | near-miss | full-width letter | direct | forward | 404 | - | no | yes | - | pass | no write |
| N05 | near-miss | sub-resource of a session | direct | forward | 404 | - | no | yes | - | pass | no write |

## Omnigent access-log lines mentioning sharing during the run

```
172.17.0.1:46358 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46368 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46380 - "PUT /v1/sharing/ HTTP/1.1" 404 Not Found
172.17.0.1:46382 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46392 - "PUT /v1/sharing// HTTP/1.1" 404 Not Found
172.17.0.1:46400 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46412 - "PUT //v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:46426 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46428 - "PUT /v1//sharing HTTP/1.1" 404 Not Found
172.17.0.1:46440 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46448 - "PUT ///v1///sharing/// HTTP/1.1" 404 Not Found
172.17.0.1:46464 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46472 - "PUT /V1/SHARING HTTP/1.1" 404 Not Found
172.17.0.1:46488 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46498 - "PUT /v1/Sharing HTTP/1.1" 404 Not Found
172.17.0.1:46506 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46508 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46518 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46524 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46538 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46548 - "PUT /v1/SHARING HTTP/1.1" 404 Not Found
172.17.0.1:46550 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46560 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46570 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46584 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46594 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46600 - "PUT //v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:46612 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46620 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46634 - "PUT /v1%252Fsharing HTTP/1.1" 404 Not Found
172.17.0.1:46642 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46648 - "PUT /v1/./sharing HTTP/1.1" 404 Not Found
172.17.0.1:46662 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46666 - "PUT /v1/x/../sharing HTTP/1.1" 404 Not Found
172.17.0.1:46680 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46690 - "PUT /./v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:46696 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46704 - "PUT /v1/./sharing HTTP/1.1" 404 Not Found
172.17.0.1:46712 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46724 - "PUT /v1/x/../sharing HTTP/1.1" 404 Not Found
172.17.0.1:46732 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46734 - "PUT /v1/x/../sharing HTTP/1.1" 404 Not Found
172.17.0.1:46750 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46762 - "PUT /v1/x/../sharing HTTP/1.1" 404 Not Found
172.17.0.1:46776 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46788 - "PUT /v1/sharing?x=1 HTTP/1.1" 200 OK
172.17.0.1:46800 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46806 - "PUT /v1/sharing%3Bx%3D1 HTTP/1.1" 404 Not Found
172.17.0.1:46822 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46838 - "PUT /v1/sharing%3Bx%3D1 HTTP/1.1" 404 Not Found
172.17.0.1:46842 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46844 - "PUT /v1/sharing%00 HTTP/1.1" 404 Not Found
172.17.0.1:46852 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46862 - "PUT /v1/sharing%20 HTTP/1.1" 404 Not Found
172.17.0.1:46870 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46884 - "PUT /v1/sharing/ HTTP/1.1" 404 Not Found
172.17.0.1:46900 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46908 - "PUT /v1%5Csharing HTTP/1.1" 404 Not Found
172.17.0.1:46918 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46920 - "PUT /v1%5Csharing HTTP/1.1" 404 Not Found
172.17.0.1:46922 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46926 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46934 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46938 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46954 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46970 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46972 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46986 - "PUT /v1/sharing. HTTP/1.1" 404 Not Found
172.17.0.1:46988 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46994 - "PUT /v1/sharing HTTP/1.0" 200 OK
172.17.0.1:47006 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:47020 - "POST /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:47032 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:47040 - "PATCH /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:45698 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45714 - "DELETE /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:45728 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45730 - "OPTIONS /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:45736 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45752 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45782 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45786 - "PROPPATCH /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:45792 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45810 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45820 - "TRACE /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:45824 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45838 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45840 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45846 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45850 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45860 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45866 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45878 - "POST /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:45880 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45888 - "GET /v1/sharing?_method=PUT HTTP/1.1" 200 OK
172.17.0.1:45892 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45902 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45904 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45906 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45908 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45922 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45926 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45940 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45948 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45952 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45962 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45972 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45974 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45984 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:45998 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46000 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46012 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46026 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46034 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46040 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46048 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46052 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46054 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46062 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46078 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46090 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46092 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46108 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46112 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46118 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46134 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46150 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46152 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46162 - "PUT /v1/sharing HTTP/1.1" 422 Unprocessable Entity
172.17.0.1:46178 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46184 - "PUT /v1/sharing HTTP/1.1" 422 Unprocessable Entity
172.17.0.1:46192 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46206 - "PUT /v1/sharing HTTP/1.1" 422 Unprocessable Entity
172.17.0.1:46216 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46232 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46240 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46254 - "PUT /v1/sharing HTTP/1.1" 400 Bad Request
172.17.0.1:46264 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46280 - "PUT /v1/sharing HTTP/1.1" 422 Unprocessable Entity
172.17.0.1:46292 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46296 - "PUT /v1/sharing HTTP/1.1" 400 Bad Request
172.17.0.1:46306 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46318 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46320 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46328 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46330 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46346 - "PUT /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46358 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46360 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46362 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46370 - "HEAD /v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:46386 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46388 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46394 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46402 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46418 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46426 - "GET /v1/sharing HTTP/1.1" 401 Unauthorized
172.17.0.1:46436 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46464 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46472 - "PUT /v1/sharingx HTTP/1.1" 404 Not Found
172.17.0.1:46488 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46504 - "PUT /v1/sharing-x HTTP/1.1" 404 Not Found
172.17.0.1:46510 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46522 - "PUT /x/v1/sharing HTTP/1.1" 404 Not Found
172.17.0.1:46530 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46554 - "GET /v1/sharing HTTP/1.1" 200 OK
172.17.0.1:46562 - "PUT /v1/sessions/abc/sharing HTTP/1.1" 404 Not Found
172.17.0.1:46578 - "GET /v1/sharing HTTP/1.1" 200 OK
```
