#!/bin/bash
# Spike S6 container entry point.
# Staging (S6_SERVE=1, set at image build): serve the owner's terminal with ttyd on port 7681,
# under /term, for the sign-in session. Locally: just stay up for `docker exec`.
if [ "${S6_SERVE:-0}" = 1 ]; then
  exec ttyd --writable --base-path /term --port 7681 \
    -t titleFixed="S6 computer" -t fontSize=15 -t disableLeaveAlert=true bash -l
fi
exec sleep infinity
