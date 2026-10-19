'use strict';
const fs=require('node:fs');
const path=require('node:path');
const readline=require('node:readline/promises');
const {stdin:input,stdout:output}=require('node:process');
const {buildRelease,nextPatchVersion,validateTargetVersion}=require('./build_distribution.cjs');

function parseProfile(argv=process.argv.slice(2)){
  const index=argv.indexOf('--profile');
  const profile=index>=0?String(argv[index+1]||''):'release';
  if(!['release','source','all'].includes(profile))throw new Error(`distribution_profile_invalid:${profile}`);
  return profile;
}
async function main(argv=process.argv.slice(2)){
  const profile=parseProfile(argv),programDir=path.resolve(__dirname,'..');
  const current=fs.readFileSync(path.join(programDir,'VERSION.txt'),'utf8').trim(),suggested=nextPatchVersion(current);
  const labels={release:'사용자 배포본',source:'개발 소스본',all:'사용자 배포본 + 개발 소스본'};
  output.write(`\nLibrarian System Release Builder · ${labels[profile]}\n\n현재 버전: ${current}\n`);
  const rl=readline.createInterface({input,output});let answer='';
  try{
    if(profile==='source'){
      output.write('개발 소스본은 현재 버전을 그대로 패키징할 수 있습니다. 더 높은 버전을 입력하면 그 버전으로 승격합니다.\n');
      answer=await rl.question(`소스 버전 [${current}]: `);
    }else{
      output.write(`현재 버전 유지: [${current}] (Enter 입력 시 유지)\n새 버전으로 승격하려면 더 높은 버전(예: ${suggested})을 입력하세요.\n`);
      answer=await rl.question(`버전 [${current}]: `);
    }
  }finally{rl.close();}
  const text=String(answer||'').trim();
  const offline=argv.includes('--offline')||argv.includes('--offline-candidate');
  const qualIdx=argv.indexOf('--qualification');
  const qualification=offline?'offline_candidate':(qualIdx>=0?argv[qualIdx+1]:(process.env.LIBRARIAN_PACKAGE_QUALIFICATION||undefined));
  let options={profile,...(qualification?{qualification}:{})};
  let target=current;
  if(!text||text===current){target=current;}
  else {target=validateTargetVersion(current,text);options.version=target;}
  output.write(`\n[Librarian System] ${labels[profile]} ${target} 생성 시작\n`);
  const result=buildRelease(options),rows=result.profile==='all'?Object.values(result.results):[result];
  output.write('\n[Librarian System] 생성 완료\n');
  for(const row of rows){
    output.write(`- ${row.report.profile}: ${path.basename(row.archivePath)}\n  SHA-256: ${row.report.archiveSha256}\n`);
  }
  if(rows.some(row=>row.report.updaterEligible))output.write(`GitHub updater 자산: Librarian-System-${target}.zip\n`);
  if(rows.some(row=>!row.report.updaterEligible))output.write(`개발 소스 자산: Librarian-System-${target}-Source.zip (업데이터 대상 아님)\n`);
}
if(require.main===module)main().catch(error=>{console.error(`\n[Librarian System] 빌드 실패: ${String(error?.message||error)}`);process.exitCode=1});
module.exports={main,parseProfile};
