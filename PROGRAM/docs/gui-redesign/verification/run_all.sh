#!/usr/bin/env sh
# GUI 시안 검증 묶음. agent-browser(Chromium)로 각 시나리오를 실제 클릭 경로대로 실행하고
# results/ 아래에 시나리오별 원본 결과(JSON)와 summary.tsv를 남긴다.
# 사용: sh run_all.sh            (모든 시나리오)
#       sh run_all.sh r6_paths   (이름에 r6_paths가 들어간 줄만)
set -u
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
SITE=$(CDPATH= cd -- "$HERE/.." && pwd -P)
OUT="$HERE/results"
FILTER="${1:-}"
mkdir -p "$OUT"
NODE=${NODE_BIN:-node}
SESSION="guiverify$$"

# 스크립트  화면(파일#해시 또는 ?쿼리)
PLAN='final_lia lia.html#mine
r4_lia lia.html#mine
r5_lia lia.html#mine
final_libra libra.html
r5_libra libra.html#desk
pr1 libra.html#settings
final_gated libra.html
final_hayaku hayaku.html
r5_hayaku hayaku.html#overview
final_gradia gradia.html#manage
r4_gradia gradia.html#manage
r5_gr gradia.html#home
r4_fb flashback.html#connect
r5_fb flashback.html#lab
final_retrace retrace.html#overview
r5_rt retrace.html#overview
final_gated retrace.html
r6_paths flashback.html?open=job-maint#care
r6_paths retrace.html#server
r6_paths lia.html#assets
r6_paths libra.html#memory
r6_extra lia.html#mine
r6_extra libra.html#desk
r6_extra hayaku.html#overview
r6_extra gradia.html#home
r6_extra flashback.html#settings
r6_extra gradia.html?mode=rp#home
sweep_noctx libra.html
sweep_noctx hayaku.html
sweep_noctx flashback.html
sweep_noctx gradia.html
sweep_noctx lia.html
sweep_noctx retrace.html
final_jobs libra.html
final_jobs hayaku.html
final_jobs flashback.html
final_jobs gradia.html
final_jobs lia.html
final_jobs retrace.html
r6_query lia.html?open=sheet-bind
r6_query lia.html?open=sheet-persona
r6_query lia.html?open=job-gen
r6_query lia.html?open=job-update
r6_query lia.html?open=job-neutral
r6_query lia.html?open=job-emo
r6_query libra.html?open=dlg-range
r6_query libra.html?open=job-memory
r6_query libra.html?open=job-recover
r6_query hayaku.html?open=dlg-compare
r6_query hayaku.html?open=job-repair
r6_query hayaku.html?open=job-cold
r6_query hayaku.html?open=job-regen
r6_query retrace.html?open=dlg-del
r6_query retrace.html?open=job-next
r6_query retrace.html?open=job-del
r6_query retrace.html?open=job-restore
r6_query retrace.html?open=job-reset
r6_query gradia.html?open=dlg-skill
r6_query flashback.html?open=dlg-del-items
r6_query flashback.html?open=job-maint
r6_query flashback.html?open=job-restore
layout libra.html?device=mobile
layout hayaku.html?device=mobile
layout flashback.html?device=mobile
layout gradia.html?device=mobile
layout lia.html?device=mobile
layout retrace.html?device=mobile
layout libra.html?device=tablet
layout hayaku.html?device=tablet
layout flashback.html?device=tablet
layout gradia.html?device=tablet
layout lia.html?device=tablet
layout retrace.html?device=tablet
layout libra.html?device=desktop
layout hayaku.html?device=desktop
layout flashback.html?device=desktop
layout gradia.html?device=desktop
layout lia.html?device=desktop
layout retrace.html?device=desktop
static_check index.html
static_check libra.html
static_check hayaku.html
static_check flashback.html
static_check gradia.html
static_check lia.html
static_check retrace.html'

printf 'script\tpage\tchecks\tfailed\tpage_errors\n' > "$OUT/summary.tsv"
printf '%s\n' "$PLAN" | while read -r SCRIPT PAGE; do
  [ -z "$SCRIPT" ] && continue
  case "$SCRIPT $PAGE" in *"$FILTER"*) ;; *) continue ;; esac
  NAME=$(printf '%s__%s' "$SCRIPT" "$PAGE" | tr '/?#=&' '_____')
  agent-browser --session "$SESSION" set viewport 1280 920 >/dev/null 2>&1
  # 같은 파일을 해시만 바꿔 열면 페이지가 다시 로드되지 않아 이전 시나리오 상태가 남는다. 빈 페이지를 거쳐 매번 새로 연다
  agent-browser --session "$SESSION" open "about:blank" >/dev/null 2>&1
  agent-browser --session "$SESSION" open "file://$SITE/$PAGE" >/dev/null 2>&1
  agent-browser --session "$SESSION" wait 700 >/dev/null 2>&1
  agent-browser --session "$SESSION" eval "$(cat "$HERE/scripts/$SCRIPT.js")" > "$OUT/$NAME.raw" 2>&1
  ERRS=$(agent-browser --session "$SESSION" errors 2>&1 | grep -c . || true)
  "$NODE" -e '
const fs=require("fs");const [raw,json,script,page,errs]=process.argv.slice(1);
let txt=fs.readFileSync(raw,"utf8").trim(),d;
try{d=JSON.parse(JSON.parse(txt));}catch(e){d={evalError:txt};}
fs.writeFileSync(json,JSON.stringify(d,null,1));
let checks="",failed="";
if(Array.isArray(d)){checks=d.length+" rows";failed=d.filter(l=>/NOT-DONE/.test(l)).length+" not-done (대상 필요 작업은 blocked가 정상)";}
else if(d.evalError){checks="EVAL_ERROR";failed=d.evalError.slice(0,120);}
else if(d.ok){checks=Object.keys(d.ok).length;failed=(d.failed||[]).join(",")||"0";}
else if("rawPlaceholders" in d){checks=d.clicks+" clicks";failed=(d.rawPlaceholders.length+d.errors.length)?JSON.stringify(d.rawPlaceholders.concat(d.errors)):"0";}
else{const bad=Object.keys(d).filter(k=>d[k]&&d[k].length);checks="static";failed=bad.length?bad.join(","):"0";}
fs.appendFileSync(process.argv[6],[script,page,checks,failed,errs].join("\t")+"\n");
' "$OUT/$NAME.raw" "$OUT/$NAME.json" "$SCRIPT" "$PAGE" "$ERRS" "$OUT/summary.tsv"
  rm -f "$OUT/$NAME.raw"
done
cat "$OUT/summary.tsv"
