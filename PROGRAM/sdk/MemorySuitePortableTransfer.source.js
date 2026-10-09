/* LIBRARIAN PORTABLE TRANSFER SDK v1.0.0 */
// File bytes never become pluginStorage, prompt text, or debug-log payloads.
const createMemorySuitePortableTransferClient = (options = {}) => {
  if(typeof options.request!=='function')throw Error('portable_request_adapter_required');
  const request=options.request,pollMs=Math.max(20,Number(options.pollMs)||350);
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const check=signal=>{if(signal?.aborted)throw Object.assign(Error('portable_cancelled'),{code:'PORTABLE_CANCELLED'});};
  const ref=s=>({transferId:s.transferId,transferToken:s.transferToken});
  const progress=(cb,value)=>{try{cb?.(value);}catch(_){};};
  const assertServer=(s,r)=>{if(r?.dataInstanceId&&s?.dataInstanceId&&r.dataInstanceId!==s.dataInstanceId)throw Error('portable_server_changed');return r;};
  const b64encode=bytes=>{let s='';for(let p=0;p<bytes.length;p+=0x8000)s+=String.fromCharCode(...bytes.subarray(p,p+0x8000));return btoa(s);};
  const b64decode=text=>{if(typeof text!=='string'||text.length>400000||text.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(text))throw Error('portable_chunk_invalid');const raw=atob(text),b=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)b[i]=raw.charCodeAt(i);return b;};
  // Incremental SHA-256: at most one 64-byte tail, never a whole-file buffer.
  // Used even when WebCrypto is unavailable in an opaque plugin iframe.
  const sha256Stream = () => {
    const K=new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
    const h=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]),tail=new Uint8Array(64),w=new Uint32Array(64);let used=0,total=0,done=false;
    const r=(x,n)=>(x>>>n)|(x<<(32-n));
    const block=(b,off)=>{for(let i=0;i<16;i++){const j=off+4*i;w[i]=(b[j]<<24)|(b[j+1]<<16)|(b[j+2]<<8)|b[j+3];}for(let i=16;i<64;i++){const x=w[i-15],y=w[i-2];w[i]=(w[i-16]+(r(x,7)^r(x,18)^(x>>>3))+w[i-7]+(r(y,17)^r(y,19)^(y>>>10)))>>>0;}
      let [a,bv,c,d,e,f,g,v]=h;for(let i=0;i<64;i++){const t1=(v+(r(e,6)^r(e,11)^r(e,25))+((e&f)^((~e)&g))+K[i]+w[i])>>>0,t2=((r(a,2)^r(a,13)^r(a,22))+((a&bv)^(a&c)^(bv&c)))>>>0;v=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=bv;bv=a;a=(t1+t2)>>>0;}[a,bv,c,d,e,f,g,v].forEach((v,i)=>h[i]=(h[i]+v)>>>0);
    };
    const update=bytes=>{if(done)throw Error('portable_hash_finalized');total+=bytes.length;let i=0;if(used){const n=Math.min(64-used,bytes.length);tail.set(bytes.subarray(0,n),used);used+=n;i=n;if(used===64){block(tail,0);used=0;}}for(;i+64<=bytes.length;i+=64)block(bytes,i);if(i<bytes.length){tail.set(bytes.subarray(i));used=bytes.length-i;}};
    const hex=()=>{if(done)throw Error('portable_hash_finalized');done=true;const end=new Uint8Array(used<56?64:128);end.set(tail.subarray(0,used));end[used]=128;const view=new DataView(end.buffer);view.setUint32(end.length-8,Math.floor(total/0x20000000));view.setUint32(end.length-4,(total*8)>>>0);for(let i=0;i<end.length;i+=64)block(end,i);return Array.from(h,v=>v.toString(16).padStart(8,'0')).join('');};
    return {update,hex};
  };
  const digest=async bytes=>{const c=options.crypto||(typeof crypto!=='undefined'?crypto:null);if(c?.subtle){const b=await c.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(b),n=>n.toString(16).padStart(2,'0')).join('');}const h=sha256Stream();h.update(bytes);return h.hex();};
  const op=prefix=>prefix+'-'+Date.now()+'-'+(typeof crypto!=='undefined'&&crypto?.randomUUID?crypto.randomUUID():Math.random().toString(36).slice(2));
  const cancel=async s=>{if(s?.transferId)return request('cancel',ref(s));};
  const wait=async(s,{signal,onProgress,target='ready'}={})=>{
    const start=Date.now();
    while(Date.now()-start<20*60*1000){check(signal);const r=assertServer(s,await request('status',ref(s)));progress(onProgress,r);
      if(r.status===target)return r;
      if(['failed','cancelled'].includes(r.status))throw Object.assign(Error(r.error||'portable_'+r.status),{transfer:s,code:r.error||r.status});
      await pause(pollMs);
    }
    throw Object.assign(Error('portable_status_timeout_check_history'),{transfer:s});
  };
  const startExport=async opts=>{
    check(opts?.signal);const cap=await request('capabilities',{});check(opts?.signal);
    const s=await request('export-start',{operationId:op('portable-export')});assertServer(cap,s);progress(opts?.onProgress,s);
    try{return await wait(s,opts);}catch(e){if(opts?.signal?.aborted)await cancel(s).catch(()=>{});throw Object.assign(e,{transfer:s});}
  };
  const download=async(s,sink,opts={})=>{
    if(s?.status!=='ready'||s.kind!=='export'||!Number.isSafeInteger(s.totalBytes)||s.totalBytes<=0)throw Error('portable_export_not_ready');
    try{
      await sink.prepare?.(s);let offset=0,verifiedChunks=0;const wholeHash=sha256Stream();
      while(offset<s.totalBytes){check(opts.signal);const part=await request('download-chunk',{...ref(s),offset});
        if(part.offset!==offset||part.totalBytes!==s.totalBytes)throw Error('portable_download_changed');const bytes=b64decode(part.base64);
        if(!bytes.length||bytes.length>Math.min(s.chunkBytes||262144,s.totalBytes-offset))throw Error('portable_download_bounds');
        const local=await digest(bytes);if(local&&local!==part.sha256)throw Error('portable_download_digest');if(local)verifiedChunks++;
        check(opts.signal);wholeHash.update(bytes);await sink.write(bytes);offset+=bytes.length;progress(opts.onProgress,{...s,phase:'download',bytes:offset,totalBytes:s.totalBytes});
      }
      check(opts.signal);const clientSha256=wholeHash.hex();if(clientSha256!==s.sha256)throw Error('portable_download_whole_digest');await sink.close(s);await cancel(s).catch(()=>{});
      return {ok:true,bytes:offset,serverSha256:s.sha256,clientSha256,verifiedChunks,sink:sink.kind||'provided',downloadStarted:sink.browserDownload===true};
    }catch(e){try{await sink.abort?.();}catch(_){}if(opts.signal?.aborted)await cancel(s).catch(()=>{});throw Object.assign(e,{transfer:s});}
  };
  const upload=async(file,opts={})=>{
    if(!file||typeof file.slice!=='function'||!Number.isSafeInteger(file.size))throw Error('portable_file_required');
    check(opts.signal);const cap=await request('capabilities',{});if(file.size<22||file.size>cap.limits.maxArchiveBytes)throw Error('portable_archive_size_limit');
    const s=await request('upload-start',{operationId:op('portable-upload'),size:file.size});assertServer(cap,s);progress(opts.onProgress,s);
    try{
      const wholeHash=sha256Stream();
      for(let offset=0;offset<file.size;){check(opts.signal);const n=Math.min(cap.limits.chunkBytes,file.size-offset),bytes=new Uint8Array(await file.slice(offset,offset+n).arrayBuffer());if(bytes.length!==n)throw Error('portable_file_changed');
        wholeHash.update(bytes);const sha256=await digest(bytes),body={...ref(s),offset,base64:b64encode(bytes),...(sha256?{sha256}:{})};check(opts.signal);
        const result=await request('upload-chunk',body);if(result.receivedBytes!==offset+n||sha256&&result.sha256!==sha256)throw Error('portable_upload_receipt_invalid');
        offset+=n;progress(opts.onProgress,{...s,phase:'upload',bytes:offset,totalBytes:file.size});
      }
      check(opts.signal);await request('upload-finish',{...ref(s),sha256:wholeHash.hex()});return await wait(s,opts);
    }catch(e){if(opts.signal?.aborted)await cancel(s).catch(()=>{});throw Object.assign(e,{transfer:s});}
  };
  const planRestore=async s=>assertServer(s,await request('restore-plan',ref(s)));
  const restore=async(s,plan,{replaceAcknowledged=false,onProgress}={})=>{
    if(!plan?.planId||plan.dataInstanceId!==s.dataInstanceId)throw Error('portable_restore_plan_required');
    // No AbortSignal after execution begins: aborting a view cannot roll back
    // an already running durable server transaction. Observe status/history.
    await request('restore-execute',{...ref(s),planId:plan.planId,confirmation:plan.confirmation,replaceAcknowledged});
    return await wait(s,{onProgress,target:'restored'});
  };
  return Object.freeze({capabilities:()=>request('capabilities',{}),startExport,download,upload,planRestore,restore,cancel,status:s=>request('status',ref(s))});
};
/* END LIBRARIAN PORTABLE TRANSFER SDK */
