#!/bin/bash
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TOOLCHAIN=/workspace/scratch/d09f18a13aaa/min-verification-20261004T2120Z/toolchain/node_modules
export NODE_PATH="$TOOLCHAIN"
export NODE_OPTIONS="--preserve-symlinks --preserve-symlinks-main --require=$ROOT/tools/libra_final_delivery_offline_guard.cjs"
for flavor in Full Min; do
 name='LIBRA World Manager Full.js'; [ "$flavor" = Min ] && name='LIBRA World Manager.js'
 export WM_CHECKSUM_DIST="$ROOT/dist/$name" WM_VERSIONED_DIST="$ROOT/dist/$name" LIBRA_RECALL_TEST_DIST="$ROOT/dist/$name" WM_EVIDENCE_DIR="$ROOT/evidence"
 run() {
  label="$1"; shift
  printf '%s %s START\n' "$flavor" "$label"
  "$@" > "$ROOT/evidence/$label-$flavor.log" 2>&1
  status=$?; printf '%s\n' "$status" > "$ROOT/evidence/$label-$flavor.exit"
  printf '%s %s EXIT %s\n' "$flavor" "$label" "$status"
  tail -12 "$ROOT/evidence/$label-$flavor.log"
 }
 run WITNESS node --test "$ROOT/tools/checksum-witness.test.cjs"
 run CALLBACK-BOUNDARY node --test "$ROOT/tools/checksum-boundary-r1.test.cjs"
 run CHECKSUM-SAFETY node --expose-gc --test --test-concurrency=1 "$ROOT/tools/checksum-batch.test.cjs"
 run HOOK-PARITY node --expose-gc --test --test-concurrency=1 "$ROOT/tools/checksum-hook-parity.test.cjs"
 run NATIVE-SAFETY node --expose-gc --test --test-concurrency=1 "$ROOT/tools/wm-native-cache-lifecycle.test.cjs" "$ROOT/tools/wm-native-cache-final-policy.test.cjs" "$ROOT/tools/independent-post-adapter-race.test.cjs" "$ROOT/tools/wm-native-dispatch-repair-controls.test.cjs"
 run CONSUMERS node "$ROOT/tools/libra_typed_recall_consumers_test.cjs"
 run CONSUMER-REVIEW node "$ROOT/tools/libra_typed_recall_consumer_reviewfix_test.cjs"
 run BINDING-SIZE node --test "$ROOT/tools/libra_typed_consumer_binding_size_test.cjs"
 run READ-PASS-CHECKSUM node --test "$ROOT/tools/checksum-read-pass.test.cjs"
 done
