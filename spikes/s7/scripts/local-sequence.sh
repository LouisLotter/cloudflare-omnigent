#!/usr/bin/env bash
# The full local S7 sequence. Reproduces everything under spikes/s7/results/ except the staging
# files. Needs Docker, the pinned image, Chromium and `pnpm install` at the repository root.
#
#   bash spikes/s7/scripts/local-sequence.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$ROOT"
S="bash $HERE/server.sh"
W="bash $HERE/workers.sh"
V="node $HERE/run-variants.ts"
U="node $HERE/ui-check.ts"
LOG="$HERE/../results/local-sequence.log"
: >"$LOG"
step() { echo "== $(date -u +%FT%TZ) $*" | tee -a "$LOG"; }

step "fresh server (standard start) and both Worker entries, strict guard"
$S purge >>"$LOG" 2>&1
$S start standard >>"$LOG" 2>&1
$W start strict >>"$LOG" 2>&1

step "control: every variant straight to Omnigent, no Worker"
$V direct control-standard 2>&1 | tee -a "$LOG"
step "interface straight from Omnigent, no Worker"
$U direct-standard http://localhost:18700 2>&1 | tail -1 >>"$LOG"

step "before replacement: every variant through both entries"
$V guarded before-replacement 2>&1 | tee -a "$LOG"
step "before replacement: the staging computer image replays every variant from a container"
bash "$HERE/computer-local.sh" before-replacement 2>&1 | tee -a "$LOG"
step "interface through the browser entry"
$U browser-before-replacement http://localhost:8787 --try-put 2>&1 | tail -1 >>"$LOG"

step "server replacement: container removed (data directory lost, database volume kept)"
$S stop >>"$LOG" 2>&1
step "during replacement: every variant through both entries while the server is down"
$V down during-replacement 2>&1 | tee -a "$LOG"
$S start standard >>"$LOG" 2>&1

step "after replacement: every variant through both entries"
$V guarded after-replacement 2>&1 | tee -a "$LOG"
step "after replacement: the staging computer image replays every variant from a container"
bash "$HERE/computer-local.sh" after-replacement 2>&1 | tee -a "$LOG"
step "after the computer replays: override files and settings on the server"
docker exec cfo-s7-omnigent python -c 'import os; d="/data/state"; print("override files:", sorted(os.listdir(d)) if os.path.isdir(d) else [])' 2>&1 | tee -a "$LOG"
step "interface through the browser entry, after replacement"
$U browser-after-replacement http://localhost:8787 --try-put 2>&1 | tail -1 >>"$LOG"

step "comparison: a naive guard that matches the raw path exactly"
$W start naive >>"$LOG" 2>&1
$V guarded naive-guard 2>&1 | tee -a "$LOG"
$S replace standard >>"$LOG" 2>&1

step "base path /omni on the server and the Worker"
$S replace standard /omni >>"$LOG" 2>&1
$W start strict /omni >>"$LOG" 2>&1
$V direct control-base-path --base-path 2>&1 | tee -a "$LOG"
$V guarded strict-base-path --base-path 2>&1 | tee -a "$LOG"

step "authoritative server start (defense in depth), no Worker"
$S replace authoritative >>"$LOG" 2>&1
$W start strict >>"$LOG" 2>&1
$V direct control-authoritative 2>&1 | tee -a "$LOG"
$U direct-authoritative http://localhost:18700 --try-put 2>&1 | tail -1 >>"$LOG"
$V guarded authoritative-guarded 2>&1 | tee -a "$LOG"

step "teardown"
$W stop >>"$LOG" 2>&1
$S purge >>"$LOG" 2>&1
docker ps -a --filter label=cfo.spike=s7 --format '{{.Names}}' | tee -a "$LOG"
docker volume ls --filter name=cfo-s7 --format '{{.Name}}' | tee -a "$LOG"
step "done"
