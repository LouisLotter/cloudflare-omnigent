#!/bin/sh
# S1 computer entrypoint: report boot and SIGTERM to the Worker through the omnigent.internal
# intercept, then run the Omnigent host against the server behind that intercept. The marks
# are timestamps only; they carry no secrets.

T_BOOT=$(date +%s%3N)
INCARNATION=$(cat /proc/sys/kernel/random/uuid)
echo "$INCARNATION" > /tmp/s1-incarnation
echo "$T_BOOT" > /tmp/s1-boot-ms

# With enableInternet: true, the platform may not answer DNS for an intercepted virtual
# hostname. Fall back to a fixed address that the Durable Object also intercepts.
DNS=intercept
if ! getent hosts omnigent.internal >/dev/null 2>&1; then
  echo "10.199.0.1 omnigent.internal" >> /etc/hosts
  DNS=etc-hosts
fi

mark() {
  curl -s -m 5 -o /dev/null -X POST \
    "http://omnigent.internal/__s1/mark?ev=$1&run=${S1_RUN:-0}&inc=$INCARNATION&ct=$(date +%s%3N)&boot=$T_BOOT&dns=$DNS&loc=${CLOUDFLARE_LOCATION:-}&region=${CLOUDFLARE_REGION:-}&country=${CLOUDFLARE_COUNTRY_A2:-}"
}

mark boot &

CHILD=
on_term() {
  mark sigterm
  [ -n "$CHILD" ] && kill -TERM "$CHILD" 2>/dev/null
  wait "$CHILD" 2>/dev/null
  exit 0
}
trap on_term TERM INT

# Restore wakes: hold the host until the controller has restored the workspace and created
# /tmp/s1-host-release, as the design orders a wake (restore first, then the host).
if [ "${S1_HOLD_HOST:-0}" = "1" ]; then
  HELD=0
  while [ ! -e /tmp/s1-host-release ] && [ "$HELD" -lt 18000 ]; do
    sleep 0.1
    HELD=$((HELD + 1))
  done
  mark release &
fi

omnigent host --server http://omnigent.internal --non-interactive --no-open &
CHILD=$!
wait "$CHILD"
STATUS=$?
mark host-exit
# Keep the container alive after a host exit, so the controller sees the failure rather
# than a silent stop.
while :; do sleep 3600 & wait $!; done
exit "$STATUS"
