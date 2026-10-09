
'use strict';
const {checkLatest}=require('./update_common.cjs');
async function printUpdateNotice({currentVersion,write=process.stdout.write.bind(process.stdout)}={}){try{const r=await checkLatest({currentVersion});if(r.available){write(`[UPDATE] Librarian System v${r.latestVersion} 업데이트가 있습니다.\
`);write('[UPDATE] 현재 운영체제용 업데이트 런처를 실행해 주세요.\
');}else write('[UPDATE] 현재 최신 버전입니다.\
');return r;}catch(e){write('[UPDATE] 업데이트 정보를 확인하지 못했습니다. 서버 실행에는 영향을 주지 않습니다.\
');return {ok:false,error:String(e&&e.message||e)};}}
module.exports={printUpdateNotice};
