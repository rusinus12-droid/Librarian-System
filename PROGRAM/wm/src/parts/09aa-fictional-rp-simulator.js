    // Closed, code-only fictional RP rules. These numbers are not medical estimates.
    const FictionalRpSimulator = (() => {
        const VERSION='fictional_rp_v1', DRAW='wm.fictional-draw.utf8-fnv1a-avalanche-u32.v1';
        const DEFAULTS=Object.freeze({lengthDays:28,variationDays:2,periodDays:5,lutealDays:[10,16],fertileOffsets:[-5,0],implantationDays:[6,12],durationDays:266,cycleCoefficient:0.4,conditionalPeak:0.7});
        const clone=x=>JSON.parse(JSON.stringify(x)), own=(o,k)=>Object.prototype.hasOwnProperty.call(o || {},k), integer=Number.isSafeInteger;
        const encode=value=>JSON.stringify((function canonical(v){if(v===null||typeof v==='string'||typeof v==='boolean')return v;if(typeof v==='number'&&Number.isFinite(v))return Object.is(v,-0)?0:v;if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object'){const out={};for(const k of Object.keys(v).sort())if(v[k]!==undefined)out[k]=canonical(v[k]);return out;}throw Error('fictional_encoding_unsupported');})(value));
        // JSON canonical key order, UTF-8 replacement encoding, unsigned modulo 2^32;
        // draw interval [0,1), integer choices floor(u*(hi-lo+1))+lo. Version fixed.
        const hash32=(value,initial=2166136261)=>{let h=initial>>>0;for(const b of new TextEncoder().encode(encode(value)))h=Math.imul(h^b,16777619)>>>0;h^=h>>>16;h=Math.imul(h,0x85ebca6b)>>>0;h^=h>>>13;h=Math.imul(h,0xc2b2ae35)>>>0;return (h^(h>>>16))>>>0;};
        const digest=value=>[2166136261,2246822507,3266489909,668265263].map(seed=>hash32(value,seed).toString(16).padStart(8,'0')).join('');
        const draw=key=>hash32([DRAW,key])/4294967296;
        const pick=(key,lo,hi)=>lo+Math.floor(draw(key)*(hi-lo+1));
        const normalize=raw=>{const r=raw&&typeof raw==='object'&&!Array.isArray(raw)?clone(raw):{};delete r.waiting;return {...r,version:2,preset:r.preset || VERSION,simulationEnabled:r.simulationEnabled===true,cycleEnabled:r.cycleEnabled===true,pregnancyEnabled:r.pregnancyEnabled===true,calendarId:typeof r.calendarId==='string'?r.calendarId.trim():'',anchorDay:integer(r.anchorDay)?r.anchorDay:null,phases:Array.isArray(r.phases)?clone(r.phases):[],invalidPhases:r.invalidPhases===true||(r.phases!==undefined&&!Array.isArray(r.phases)),effectTarget:typeof r.effectTarget==='string'?r.effectTarget:''};};
        const resolve=(raw,permission,legacy={})=>{
            const p=normalize(raw);if(!permission?.adultFiction)return {...p,waiting:'scoped_adult_fiction_permission_required'};
            if(!p.simulationEnabled)return p;
            const approvedTemplate=p.template?.approved===true&&p.template?.targetLineage===permission.lineage&&p.template?.version&&p.template?.ruleRefs?.length;
            if(!permission.humanlike&&!approvedTemplate)return {...p,waiting:'supported_fictional_template_required'};
            if(p.preset!==VERSION&&!approvedTemplate)return {...p,waiting:'fictional_preset_unsupported'};
            const base=approvedTemplate?p.template.parameters:DEFAULTS,sources={};
            const legacyFields={lengthDays:'cycleLengthDays',periodDays:'bleedingDurationDays'};
            for(const key of Object.keys(DEFAULTS)){
                if(p[key]!==undefined&&p[key]!==null){sources[key]=p.presetInfo?.sources?.[key] || 'custom';continue;}
                const prior=legacy[key] ?? legacy[legacyFields[key]];
                if(prior!==undefined&&prior!==null){p[key]=clone(prior);sources[key]='legacy';}
                else if(base[key]!==undefined){p[key]=clone(base[key]);sources[key]=approvedTemplate?'approved_template':'preset';}
            }
            if(!own(p,'seed')&&own(legacy,'seed'))p.seed=clone(legacy.seed);
            if(!own(p,'seed')&&own(legacy,'cycleSeed'))p.seed=clone(legacy.cycleSeed);
            if(p.anchorDay===null&&integer(legacy.anchorDay)&&(!legacy.calendarId||legacy.calendarId===p.calendarId))p.anchorDay=legacy.anchorDay;
            p.presetInfo={name:VERSION,version:1,source:'user_approved_fictional_rp',medical:false,sources,overrides:Object.keys(sources).filter(k=>sources[k]!=='preset').sort()};
            return p;
        };
        const missing=p=>{
            const out=[];if(p.waiting)out.push(p.waiting);if(!p.simulationEnabled)return out;
            if(p.preset!==VERSION&&!p.template?.approved)out.push('preset');if(!p.calendarId)out.push('calendarId');if(!integer(p.anchorDay))out.push('anchorDay');
            for(const key of ['lengthDays','periodDays','durationDays'])if(!integer(p[key])||p[key]<1)out.push(key);
            if(!integer(p.variationDays)||p.variationDays<0||p.variationDays>=p.lengthDays)out.push('variationDays');
            for(const key of ['lutealDays','fertileOffsets','implantationDays'])if(!Array.isArray(p[key])||p[key].length!==2||!p[key].every(integer)||p[key][0]>p[key][1])out.push(key);
            if(p.lutealDays?.[0]<1||p.lutealDays?.[1]>=p.lengthDays-p.variationDays)out.push('lutealDays');
            if(p.implantationDays?.[0]<0||p.implantationDays?.[1]>p.durationDays)out.push('implantationDays');
            if(p.fertileOffsets?.[1]>0||p.fertileOffsets?.[0]<-p.lengthDays)out.push('fertileOffsets');
            if(p.periodDays>p.lengthDays-p.variationDays)out.push('periodDays');
            for(const key of ['cycleCoefficient','conditionalPeak'])if(typeof p[key]!=='number'||!Number.isFinite(p[key])||p[key]<0||p[key]>1)out.push(key);
            const phases=[...(p.phases || [])].sort((a,b)=>a.startDay-b.startDay);
            if(p.invalidPhases||phases.some((r,i)=>!r.label||!integer(r.startDay)||!integer(r.endDay)||r.startDay<1||r.endDay<r.startDay||r.endDay>p.lengthDays-p.variationDays||i&&phases[i-1].endDay>=r.startDay))out.push('phases');
            return [...new Set(out)];
        };
        const identity=(p,context)=>({model:VERSION,drawVersion:DRAW,lineage:String(context.lineage),seed:own(p,'seed')?clone(p.seed):'frp1:'+digest(['seed',context.scope,context.lineage]),calendarId:p.calendarId,anchorDay:p.anchorDay});
        const cycle=(id,p,number,startDay)=>{
            if(!integer(number)||number<0||!integer(startDay)||missing(p).length)throw Error('fictional_cycle_parameters_unavailable');
            const key=[VERSION,id.seed,id.lineage,id.calendarId,id.anchorDay,number],lengthDays=p.lengthDays+pick([...key,'length'],-p.variationDays,p.variationDays),luteal=pick([...key,'luteal'],...p.lutealDays),endDay=startDay+lengthDays;
            if(!integer(endDay))throw Error('fictional_cycle_time_out_of_range');
            const commonDraw=draw([...key,'cycle-common']);
            return {id:'cycle:'+digest(key),identity:clone(id),number,startDay,endDay,lengthDays,ovulationDay:endDay-luteal-1,implantationDelayDays:pick([...key,'implantation'],...p.implantationDays),commonDraw,commonCondition:commonDraw<p.cycleCoefficient,parameters:clone(p),drawKey:key};
        };
        const sameRules=(expected,actual)=>(expected||[]).length>0&&expected.every(r=>(actual||[]).some(a=>a.nodeId===r.nodeId&&a.ruleId===r.ruleId&&a.version===r.version));
        const effect=(definition,event)=>{
            const d=definition,f=event.fields||{},time=event.storyClock;
            if(event.eventType!=='item_use_observed'||event.factStatus!=='direct'||f.used!==true||f.itemRef!==d.itemRef)return {waiting:'actual_item_use_unavailable'};
            if(!time||!integer(time.day)||!integer(d.durationDays)||d.durationDays<1||!integer(time.day+d.durationDays))return {waiting:'effect_time_unavailable'};
            if(!sameRules(d.ruleRefs,event.ruleRefs))return {waiting:'effect_rule_version_unavailable'};
            if(!['exposureProbability','cycle','pregnancy'].includes(d.effectTarget)||!['set','add','multiply','allow','block'].includes(d.operation))return {waiting:'fictional_effect_adapter_unsupported'};
            if(['set','add','multiply'].includes(d.operation)&&(d.effectTarget!=='exposureProbability'||typeof d.operand!=='number'||!Number.isFinite(d.operand)))return {waiting:'fictional_effect_operand_unsupported'};
            if((d.conditions||[]).some(c=>!own(f,c.field)))return {waiting:'condition_evidence_unavailable'};
            if((d.conditions||[]).some(c=>f[c.field]!==c.equals))return {waiting:'condition_not_satisfied'};
            if((d.conditions||[]).length&&!f.stateVersion)return {waiting:'same_state_version_required'};
            return {id:event.occurrenceRef,itemRef:d.itemRef,calendarId:time.calendarId,startDay:time.day,endDay:time.day+d.durationDays,order:integer(f.storyOrder)?f.storyOrder:null,operation:d.operation,operand:d.operand ?? null,target:d.effectTarget,ruleRefs:clone(d.ruleRefs),conditions:clone(d.conditions || []),stateVersion:f.stateVersion || null,stacking:d.stacking || 'defer_overlap'};
        };
        const day=(c,events,effects=[])=>{
            const valid=events.filter(e=>!['negated','cancelled'].includes(e.factStatus)),first=valid[0]||events[0],time=first?.storyClock;
            const base={cycleId:c.id,cycleNumber:c.number,calendarId:c.identity.calendarId,day:time?.day ?? null,commonDraw:c.commonDraw,commonCondition:c.commonCondition,draw:time&&integer(time.day)?draw([...c.drawKey,'exposure-day',time.day]):null,candidateIds:[],occurrenceRefs:valid.map(e=>e.occurrenceRef).sort(),classification:'simulated'};
            if(!valid.length)return {...base,status:'invalidated',probability:null};
            const waiting=reason=>({...base,status:'waiting',reason,probability:null});
            if(!time||!integer(time.day)||time.calendarId!==c.identity.calendarId||valid.some(e=>!e.storyClock||e.storyClock.day!==time.day||e.storyClock.calendarId!==time.calendarId))return waiting('exact_exposure_day_required');
            if(time.day<c.startDay||time.day>=c.endDay)return waiting('exposure_cycle_mismatch');
            if(valid.some(e=>e.factStatus!=='direct'||e.fields?.completed!==true||e.fields?.exposureType!=='conception_possible'||!e.occurrenceRef||!Array.isArray(e.participantIds)||e.participantIds.length<2))return waiting('completed_exposure_evidence_required');
            if(valid.some(e=>!['none','approved_rule'].includes(e.fields.contraceptionStatus)))return waiting('contraception_model_unavailable');
            for(const target of ['cycle','pregnancy']){
                const gate=effects.filter(e=>e.target===target&&e.calendarId===time.calendarId&&time.day>=e.startDay).sort((a,b)=>a.startDay-b.startDay||(a.order ?? 0)-(b.order ?? 0)).at(-1);
                if(gate?.operation==='allow'&&time.day>=gate.endDay)return {...base,status:'blocked',reason:'fictional_function_allow_expired',probability:null};
            }
            const active=effects.filter(e=>e.calendarId===time.calendarId&&time.day>=e.startDay&&time.day<e.endDay);
            let probability=c.parameters.conditionalPeak;
            // The v1 RP support window is deliberately a flat fictional coefficient,
            // not a medical day-specific curve or conversion of annual failure rates.
            for(const e of valid){if(e.fields.contraceptionStatus==='approved_rule'&&!active.some(a=>sameRules(a.ruleRefs,e.ruleRefs)))return waiting('contraception_effect_unconfirmed');}
            const selected=active.filter(e=>e.target==='exposureProbability'||e.target==='cycle'||e.target==='pregnancy');
            if(selected.length>1&&selected.some(e=>e.stacking!=='replace'))return waiting('effect_overlap_requires_explicit_policy');
            if(selected.some((e,i)=>selected.slice(i+1).some(other=>other.startDay===e.startDay&&(e.order===null||other.order===null||e.order===other.order))))return waiting('effect_order_requires_review');
            const applied=selected.length>1?[...selected].sort((a,b)=>a.startDay-b.startDay||(a.order ?? 0)-(b.order ?? 0)).slice(-1):selected;
            for(const e of applied){
                if(e.startDay===time.day&&valid.some(v=>!integer(v.fields.storyOrder)||e.order===null||v.fields.storyOrder<=e.order))return waiting('effect_order_requires_review');
                if(e.conditions.length&&valid.some(v=>v.fields.stateVersion!==e.stateVersion||e.conditions.some(k=>own(v.fields,k.field)&&v.fields[k.field]!==k.equals)))return waiting('same_state_version_required');
                if(e.operation==='block'&&e.target!=='exposureProbability')return {...base,status:'blocked',reason:'fictional_function_blocked',probability:null};
                if(e.operation==='block')probability=0;else if(e.operation==='set')probability=e.operand;else if(e.operation==='add')probability+=e.operand;else if(e.operation==='multiply')probability*=e.operand;
            }
            if(!Number.isFinite(probability)||probability<0||probability>1)return waiting('fictional_probability_out_of_range');
            const relative=time.day-c.ovulationDay,inWindow=relative>=c.parameters.fertileOffsets[0]&&relative<=c.parameters.fertileOffsets[1];
            base.candidateIds=inWindow?[...new Set(valid.flatMap(e=>e.participantIds.filter(id=>!e.targetIds.includes(id))))].sort():[];
            return {...base,status:c.commonCondition&&inWindow&&base.draw<probability?'potential_conception':'not_established_for_day',probability:inWindow?probability:0,inWindow,effectIds:applied.map(e=>e.id),evidenceRevision:digest(valid.map(e=>({id:e.occurrenceRef,fields:e.fields,participants:e.participantIds,ruleRefs:e.ruleRefs||[]})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0))};
        };
        const reduce=(prior={},c,result,observations=[])=>{
            const state=clone(prior);state.observed=state.observed||{status:'unknown',episodeId:'',originDay:null,calendarId:c.identity.calendarId,terminal:false};
            if(result){state.lastDay=result;
                if(result.status==='waiting')state.waiting=result.reason;
                if(result.status==='potential_conception'&&!state.episode&&state.observed.status==='confirmed')state.waiting='observed_episode_conflict_requires_review';
                if(result.status==='potential_conception'&&!state.episode&&!state.recovery&&state.observed.status!=='confirmed'){state.episode={id:'episode:'+c.id,cycleId:c.id,status:'potential',originDay:result.day,calendarId:result.calendarId,parameters:{durationDays:c.parameters.durationDays,implantationDelayDays:c.implantationDelayDays},originOccurrenceRefs:clone(result.occurrenceRefs),candidateIds:clone(result.candidateIds),confirmedParentId:null};}
                else if(state.episode?.cycleId===c.id&&state.episode.status!=='closed'&&result.inWindow)state.episode.candidateIds=[...new Set([...state.episode.candidateIds,...result.candidateIds])].sort();
            }
            for(const e of observations){
                const f=e.fields||{},time=e.storyClock;if(!time||!integer(time.day)){state.waiting='episode_time_unavailable';continue;}
                if(e.eventType==='cycle_resumed'){
                    if(!integer(f.anchorDay)||f.anchorDay!==time.day){state.waiting='explicit_recovery_anchor_required';continue;}
                    if(!state.observed.terminal){state.waiting='recovery_requires_terminal_episode';continue;}
                    state.episode=null;state.recovery=null;state.recoveryAnchor={calendarId:time.calendarId,day:f.anchorDay};continue;
                }
                if(e.eventType==='paternity_confirmed'){
                    if(f.episodeId!==state.episode?.id||!state.episode.candidateIds.includes(f.parentId)){state.waiting='paternity_episode_evidence_required';continue;}
                    state.episode.confirmedParentId=f.parentId;continue;
                }
                const status={pregnancy_confirmed:'confirmed',pregnancy_ended:'ended',birth_confirmed:'birth_confirmed'}[e.eventType];if(!status)continue;
                if(!f.episodeId){state.waiting='episode_identity_unavailable';continue;}
                const old=state.observed,same=old.episodeId===f.episodeId,matching=state.episode?.id===f.episodeId;
                if(same&&old.terminal&&status==='confirmed'){state.waiting='terminal_episode_requires_new_identity';continue;}
                if(old.episodeId&&!same&&!old.terminal){state.waiting='active_episode_conflict_requires_review';continue;}
                if(own(f,'originDay')&&(!integer(f.originDay)||f.originDay>time.day)){state.waiting='episode_origin_unavailable';continue;}
                const known=same&&old.originDay!==null?old.originDay:null;
                if(known!==null&&integer(f.originDay)&&known!==f.originDay){state.waiting='episode_origin_conflict_requires_review';continue;}
                state.observed={status,episodeId:f.episodeId,calendarId:time.calendarId,originDay:known!==null?known:integer(f.originDay)?f.originDay:null,lastEventDay:time.day,terminal:status!=='confirmed',evidenceRefs:clone(e.evidenceRefs||[])};
                if(status!=='confirmed'){
                    if(state.episode)state.episode={...state.episode,status:'closed',closedDay:time.day};state.recovery='requires_explicit_anchor_or_rule';
                }else if(state.episode&&(!matching||(integer(f.originDay)&&f.originDay!==state.episode.originDay))){state.episode={...state.episode,status:'suspended_observed_conflict'};state.waiting='observed_episode_conflict_requires_review';}
            }
            return state;
        };
        const project=(state={},clock=null,c=null,effects=[])=>{
            const observed=clone(state.observed||{status:'unknown',originDay:null,terminal:false});
            observed.elapsedDays=integer(observed.originDay)&&clock?.calendarId===observed.calendarId&&clock.day>=observed.originDay?(observed.terminal?observed.lastEventDay:clock.day)-observed.originDay:null;
            const simulated={status:state.waiting?'waiting':'current'};
            if(c&&clock&&clock.calendarId===c.identity.calendarId&&clock.day>=c.startDay&&clock.day<c.endDay){const cycleDay=clock.day-c.startDay+1;simulated.cycle={status:state.recovery?'waiting':'current',cycleDay,cycleNumber:c.number,phase:c.parameters.phases.find(p=>cycleDay>=p.startDay&&cycleDay<=p.endDay)?.label || (cycleDay<=c.parameters.periodDays?'fictional_period':clock.day>=c.ovulationDay+c.parameters.fertileOffsets[0]&&clock.day<=c.ovulationDay+c.parameters.fertileOffsets[1]?'fictional_support_window':'fictional_other'),ovulationDay:c.ovulationDay,basis:{calendarId:c.identity.calendarId,startDay:c.startDay,lengthDays:c.lengthDays,number:c.number,phases:clone(c.parameters.phases)}};}
            if(state.episode){const e=state.episode,elapsed=clock?.calendarId===e.calendarId&&clock.day>=e.originDay?(e.status==='closed'?e.closedDay:clock.day)-e.originDay:null;simulated.pregnancy={...clone(e),episodeId:e.id,elapsedDays:elapsed,status:e.status,stage:e.status==='closed'?'closed':elapsed===null?'waiting':elapsed>=e.parameters.durationDays?'duration_elapsed':elapsed<e.parameters.implantationDelayDays?'pre_implantation_coordinate':'post_implantation_coordinate'};}
            for(const target of ['cycle','pregnancy']){
                const gate=effects.filter(e=>e.target===target&&e.calendarId===clock?.calendarId&&clock.day>=e.startDay).sort((a,b)=>a.startDay-b.startDay||(a.order ?? 0)-(b.order ?? 0)).at(-1);
                if(gate&&simulated[target]&&((gate.operation==='block'&&clock.day<gate.endDay)||(gate.operation==='allow'&&clock.day>=gate.endDay)))simulated[target]={...simulated[target],status:'blocked'};
            }
            return {observed,simulated,clock:clock?clone(clock):null,missing:state.waiting?[state.waiting]:[],lastExposureDay:state.lastDay?clone(state.lastDay):null,recovery:state.recovery || null};
        };
        const dayKey=n=>{if(!integer(n))throw Error('fictional_day_key_invalid');return n<0?'0'+String(Number.MAX_SAFE_INTEGER+n).padStart(16,'0'):'1'+String(n).padStart(16,'0');};
        return Object.freeze({VERSION,DRAW,DEFAULTS,normalize,resolve,missing,encode,digest,draw,identity,cycle,day,effect,reduce,project,dayKey,sameRules});
    })();
