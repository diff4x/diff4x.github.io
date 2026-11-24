import init,*as wasm from'../wasm/compute_intensive_task_processor.min.js';const{set_data,build_flat_data,doc_count,search_multi_range,set_comments,search_comments,get_snippets
}=wasm;const get_snippets_ads=wasm.get_snippets_ads;const build_and_set_data=wasm.build_and_set_data;const search_ads_range=wasm.search_ads_range;const bloom_might_match=wasm.bloom_might_match;const prepare_search=wasm.prepare_search;const scan_prepared_range=wasm.scan_prepared_range;const prepare_ads_search=wasm.prepare_ads_search;const scan_prepared_ads_range=wasm.scan_prepared_ads_range;const comment_doc_count=wasm.comment_doc_count;const prepare_comment_search=wasm.prepare_comment_search;const scan_prepared_comments_range=wasm.scan_prepared_comments_range;let wasmReady=false;let wasmSupportsWeighted=false;let synReady=false;let synMod=null;function toHalfwidth(str){let out="";for(let i=0;i<str.length;i++){const code=str.charCodeAt(i);if(code===0x3000)out+=" ";else if(code>=0xFF01&&code<=0xFF5E)out+=String.fromCharCode(code-0xFEE0);else out+=str.charAt(i);}
return out;}
function adaptKeywordsForWasm(kws){if(!Array.isArray(kws))return[];if(wasmSupportsWeighted)return kws;return kws.map(k=>(typeof k==='string'?k:(k&&typeof k.text==='string'?k.text:''))).filter(Boolean);}
function adaptAdsTermsForWasm(terms){if(!Array.isArray(terms))return[];if(wasmSupportsWeighted)return terms;return terms.map(t=>Object.assign({},t,{keywords:adaptKeywordsForWasm(t.keywords)}));}
function adaptAdsPlanForWasm(plan){if(!plan||!Array.isArray(plan.terms))return plan;if(wasmSupportsWeighted)return plan;return{terms:adaptAdsTermsForWasm(plan.terms),expr:plan.expr};}
let messageQueue=[];let lastSavedKw="";let dataReady=false;let pendingSearch=null;let dataGen=0;let commentGen=0;let latestToken=0;const SLICE_MS=8;const MIN_SLICE=16;const MAX_SLICE=4096;let sliceDocs=256;let commentSliceDocs=128;const yieldWaiters=[];const yieldChan=new MessageChannel();yieldChan.port1.onmessage=()=>{const resolve=yieldWaiters.shift();if(resolve)resolve();};const yieldToQueue=()=>new Promise(resolve=>{yieldWaiters.push(resolve);yieldChan.port2.postMessage(0);});function bumpToken(t){if(typeof t==='number'&&t>latestToken)latestToken=t;}
function compareResults(a,b){return(b.score-a.score)
||(b.count-a.count)
||(a.title<b.title?-1:a.title>b.title?1:0);}
function compareCommentHits(a,b){const sa=typeof a.score==='number'?a.score:0;const sb=typeof b.score==='number'?b.score:0;return(sb-sa)
||(b.count-a.count)
||(a.path<b.path?-1:a.path>b.path?1:0);}
function expandTermSpecs(rawText,useSyn,opts={}){const str=toHalfwidth(String(rawText||""));const clean=str.replace(/\s+/g,"");if(!clean)return[];const specs=[{text:clean,weight:100,tier:0}];if(useSyn&&synReady&&synMod&&typeof synMod.expandQuery==='function'){const skipBloom=!!(opts&&opts.skipCorpusFilter);const existsInCorpus=(!skipBloom&&dataReady&&typeof bloom_might_match==='function')
?(w)=>!!bloom_might_match(w)
:null;const res=synMod.expandQuery(str,{existsInCorpus,cacheTag:skipBloom?'raw':((dataReady?dataGen:0)+':'+commentGen)
});if(Array.isArray(res.items)&&res.items.length>0){for(let i=0;i<res.items.length;i++)specs.push(res.items[i]);}else if(Array.isArray(res.variants)&&res.variants.length>0){for(let i=0;i<res.variants.length;i++){specs.push({text:res.variants[i],weight:65,maxNoise:0,tier:1});}}}
return specs;}
function resolvePayloadTermSpecs(payload){if(payload.synonymsEnabled!==undefined){return expandTermSpecs(payload.keyword,!!payload.synonymsEnabled);}
if(Array.isArray(payload.searchKeywords)&&payload.searchKeywords.length>0){return payload.searchKeywords;}
return expandTermSpecs(payload.keyword,false);}
function resolveAdsTerms(rawTerms){if(!Array.isArray(rawTerms))return[];return rawTerms.map(t=>{if(!t)return null;const noise=t.noise!==undefined?t.noise:5;if(typeof t.text==='string'&&(!Array.isArray(t.keywords)||t.keywords.length===0)){return{text:t.text,like:!!t.like,noise,keywords:expandTermSpecs(t.text,!!t.like)
};}
return{text:typeof t.text==='string'?t.text:'',like:!!t.like,noise,keywords:Array.isArray(t.keywords)?t.keywords:[]
};}).filter(t=>t&&t.keywords.length>0);}
function mergeRanges(dst,src){const bySpan=new Map();for(let i=0;i<dst.length;i++){bySpan.set(dst[i][0]+','+dst[i][1],i);}
for(const r of src||[]){const k=r[0]+','+r[1];const idx=bySpan.get(k);if(idx===undefined){bySpan.set(k,dst.length);dst.push(r);}else if(r[2]<dst[idx][2]){dst[idx]=r;}}
dst.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);}
function itemNoise(it){if(typeof it.n==='number')return it.n;let m=Infinity;for(const r of it.h||[]){if(r[2]<m)m=r[2];}
return m===Infinity?0:m;}
function mergeSection(parts,pick,keyOf,limit,tie){const byKey=new Map();const all=[];parts.forEach((p,ti)=>{const items=(pick(p)&&pick(p).items)||[];items.forEach((it,k)=>{const key=keyOf(it);const prev=byKey.get(key);if(prev){mergeRanges(prev.item.h,it.h);const n=itemNoise(it);if(n<prev.item.n)prev.item.n=n;if(k<prev.k)prev.k=k;return;}
const copy=Object.assign({},it,{h:(it.h||[]).slice(),n:itemNoise(it)
});const rec={item:copy,k,ti};byKey.set(key,rec);all.push(rec);});});all.sort((a,b)=>(a.item.n-b.item.n)||tie(a,b));const kept=all.slice(0,limit).map(r=>r.item);return{items:kept,dropped:Math.max(0,all.length-kept.length)};}
function mergeAdsSnippets(parts,maxBody,maxComments){const valid=parts.filter(Boolean);if(valid.length===0)return null;if(valid.length===1)return valid[0];const body=mergeSection(valid,p=>p.body,it=>it.t,maxBody,(a,b)=>(a.k-b.k)||(a.ti-b.ti)
);const cm=mergeSection(valid,p=>p.comments,it=>it.c+'\u0000'+it.t,maxComments,(a,b)=>(a.item.c-b.item.c)||(a.k-b.k)||(a.ti-b.ti)
);const sum=(pick)=>valid.reduce((s,p)=>s+(pick(p)||0),0);const distinctC=new Set(cm.items.map(it=>it.c)).size;return{body:{hits:sum(p=>p.body&&p.body.hits),docs:0,more:sum(p=>p.body&&p.body.more)+body.dropped,items:body.items
},comments:{hits:sum(p=>p.comments&&p.comments.hits),docs:Math.max(distinctC,...valid.map(p=>(p.comments&&p.comments.docs)||0)),more:sum(p=>p.comments&&p.comments.more)+cm.dropped,items:cm.items
}};}
function getAdsSnippets(payload){const maxBody=payload.maxBody!==undefined?payload.maxBody:40;const maxComments=payload.maxComments!==undefined?payload.maxComments:30;const resolved=resolveAdsTerms(payload.adsTerms);const terms=adaptAdsTermsForWasm(resolved.map(t=>({noise:t.noise,keywords:t.keywords})));if(terms.length===0)return null;if(typeof get_snippets_ads==='function'){try{return get_snippets_ads(payload.path,terms,maxBody,maxComments);}catch(err){console.error("[Worker] get_snippets_ads 调用失败，回退至分项合并:",err);}}
const parts=[];for(const t of terms){try{parts.push(get_snippets(payload.path,t.keywords,t.noise!==undefined?t.noise:5,maxBody,maxComments
));}catch(err){console.error("[Worker] 组合搜索 snippet 生成失败:",err);}}
return mergeAdsSnippets(parts,maxBody,maxComments);}
function slimFlat(raw){const n=raw.length;const out=new Array(n);let i=0;for(;i+3<n;i+=4){const content=raw[i+1];out[i]=raw[i];out[i+1]=raw[i+3]==='html'
?(typeof content==='string'&&content.startsWith('localOnly')?'localOnly':'')
:content;out[i+2]=raw[i+2];out[i+3]=raw[i+3];}
for(;i<n;i++)out[i]=raw[i];return out;}
function fingerprintFlat(raw,isOffline){let h1=0x811c9dc5,h2=0x1b873593;h1=Math.imul(h1^(isOffline?1:0),16777619);for(let k=0;k<raw.length;k++){const s=raw[k];const len=s.length;h1=Math.imul(h1^len,16777619);for(let c=0;c<len;c++){const code=s.charCodeAt(c);h1=Math.imul(h1^code,16777619);h2=Math.imul(h2^code,0x85ebca6b)^(h2>>>15);}}
return(h1>>>0).toString(16)+(h2>>>0).toString(16)+'.'+raw.length;}
async function scanAll(token,prepare,scan){for(;;){const gen=dataGen;if(token!==latestToken)return null;if(typeof prepare==='function'&&!prepare()){return[];}
const total=doc_count();const results=[];let restart=false;for(let from=0;from<total;){if(token!==latestToken)return null;if(gen!==dataGen){restart=true;break;}
const to=Math.min(total,from+sliceDocs);const t0=performance.now();const part=scan(from,to);const dt=performance.now()-t0;for(let i=0;i<part.length;i++)results.push(part[i]);from=to;const ratio=Math.min(2,Math.max(0.5,SLICE_MS/Math.max(dt,0.5)));sliceDocs=Math.min(MAX_SLICE,Math.max(MIN_SLICE,Math.round(sliceDocs*ratio)));if(from<total)await yieldToQueue();}
if(restart||gen!==dataGen)continue;if(token!==latestToken)return null;results.sort(compareResults);return results;}}
async function runCommentSearch(token,searchKeywords,noise){if(token!==undefined&&token!==latestToken)return null;const hasChunked=typeof comment_doc_count==='function'
&&typeof prepare_comment_search==='function'
&&typeof scan_prepared_comments_range==='function';if(!hasChunked){const hits=search_comments(searchKeywords,noise)||[];if(token!==undefined&&token!==latestToken)return null;return hits;}
for(;;){const gen=commentGen;if(token!==undefined&&token!==latestToken)return null;if(!prepare_comment_search(searchKeywords,noise)){return[];}
const total=comment_doc_count();const hits=[];let restart=false;for(let from=0;from<total;){if(token!==undefined&&token!==latestToken)return null;if(gen!==commentGen){restart=true;break;}
const to=Math.min(total,from+commentSliceDocs);const t0=performance.now();const part=scan_prepared_comments_range(from,to);const dt=performance.now()-t0;for(let i=0;i<part.length;i++)hits.push(part[i]);from=to;const ratio=Math.min(2,Math.max(0.5,SLICE_MS/Math.max(dt,0.5)));commentSliceDocs=Math.min(MAX_SLICE,Math.max(MIN_SLICE,Math.round(commentSliceDocs*ratio)));if(from<total)await yieldToQueue();}
if(restart||gen!==commentGen)continue;if(token!==undefined&&token!==latestToken)return null;hits.sort(compareCommentHits);return hits;}}
async function runSearch(payload){if(payload.ads)return runAdsSearch(payload);const kw=payload.keyword;const token=payload.token;const noise=payload.noise!==undefined?payload.noise:5;const useSyn=payload.synonymsEnabled!==undefined?!!payload.synonymsEnabled:false;const termSpecs=resolvePayloadTermSpecs(payload);const searchKeywords=adaptKeywordsForWasm(termSpecs);const synApplied=!useSyn||synReady;const usePrepared=typeof prepare_search==='function'&&typeof scan_prepared_range==='function';const results=await scanAll(token,usePrepared?()=>!!prepare_search(searchKeywords,noise):null,usePrepared
?(from,to)=>scan_prepared_range(from,to)
:(from,to)=>search_multi_range(searchKeywords,noise,from,to)
);if(results===null)return;let commentHits=[];try{const ch=await runCommentSearch(token,searchKeywords,noise);if(ch===null)return;commentHits=ch;}catch(err){console.error("[Worker] 评论搜索失败:",err);}
if(token!==latestToken)return;self.postMessage({type:'SEARCH_RESULTS',results,keyword:kw,token,ns:payload.ns||'',commentHits,termSpecs,synApplied
});}
async function runAdsSearch(payload){const kw=payload.keyword;const token=payload.token;const rawPlan=payload.plan||{terms:[],expr:null};const resolvedTerms=resolveAdsTerms(rawPlan.terms);const synApplied=resolvedTerms.every(t=>!t.like)||synReady;const wasmPlan=adaptAdsPlanForWasm({terms:resolvedTerms.map(t=>({noise:t.noise,keywords:t.keywords})),expr:rawPlan.expr
});if(typeof search_ads_range!=='function'&&typeof scan_prepared_ads_range!=='function'){console.error("[Worker] 当前 wasm 没有 search_ads_range，请用新版 lib.rs 重新编译");self.postMessage({type:'SEARCH_RESULTS',results:[],keyword:kw,token,error:'组合搜索需要新版 wasm（缺少 search_ads_range）'
});return;}
const usePrepared=typeof prepare_ads_search==='function'&&typeof scan_prepared_ads_range==='function';const results=await scanAll(token,usePrepared?()=>!!prepare_ads_search(wasmPlan):null,usePrepared
?(from,to)=>scan_prepared_ads_range(from,to)
:(from,to)=>search_ads_range(wasmPlan,from,to)
);if(results===null)return;self.postMessage({type:'SEARCH_RESULTS',results,keyword:kw,token,ns:payload.ns||'',adsTermSpecs:resolvedTerms,synApplied
});}
function startSearch(payload){runSearch(payload).catch(err=>console.error("[Worker] 搜索失败:",err));}
function flushPendingSearch(){if(!pendingSearch)return;const p=pendingSearch;pendingSearch=null;startSearch(p);}
async function loadSynonymsInWorker(){try{const mod=await import('./synonyms.js');synMod=mod;synReady=true;const idx=mod.synonymIndex||{};self.postMessage({type:'SYNONYMS_READY',payload:{version:idx.version||'',sig:idx.sig||'',groups:Array.isArray(idx.groups)?idx.groups:[],stats:idx.stats||null
}});}catch(err){console.error("[Worker] synonyms.js 加载失败，近义搜索将保持停用状态:",err);}}
async function initWorker(){loadSynonymsInWorker();try{await init();wasmSupportsWeighted=typeof wasm.supports_weighted_keywords==='function'&&!!wasm.supports_weighted_keywords();wasmReady=true;const queue=messageQueue;messageQueue=[];for(const msg of queue){processMessage(msg);}}catch(err){console.error("[Worker] 初始化 Wasm 失败:",err);self.postMessage({type:'ENGINE_ERROR',error:'搜索引擎 Wasm 初始化失败: '+(err&&err.message?err.message:String(err))
});}}
initWorker();self.onmessage=function(e){const data=e.data;if(data&&data.payload&&(data.type==='SEARCH'||data.type==='SEARCH_ADS'||data.type==='CANCEL'||data.type==='SEARCH_COMMENTS')){bumpToken(data.payload.token);}
if(!wasmReady){if(data.type==='SEARCH'||data.type==='SEARCH_ADS'){messageQueue=messageQueue.filter(m=>m.type!=='SEARCH'&&m.type!=='SEARCH_ADS'
);}
messageQueue.push(data);return;}
processMessage(data);};function processMessage(data){const{type,payload}=data;switch(type){case'BUILD_DATA':{const{liteData,fatData,shadowData,isOffline}=payload;try{let slim,fp;if(typeof build_and_set_data==='function'){const out=build_and_set_data(liteData,fatData,shadowData,isOffline);slim=out.data;fp=out.fp;}else{const raw=build_flat_data(liteData,fatData,shadowData,isOffline);set_data(raw);fp=fingerprintFlat(raw,isOffline);slim=slimFlat(raw);}
dataGen++;dataReady=true;if(synMod&&typeof synMod.clearSynonymCache==='function'){synMod.clearSynonymCache();}
self.postMessage({type:'DATA_READY',payload:{data:slim,fp}});flushPendingSearch();}catch(err){console.error("[Worker] 数据编译打包失败:",err);self.postMessage({type:'ENGINE_ERROR',error:'搜索索引构建失败: '+(err&&err.message?err.message:String(err))
});}
break;}
case'SEARCH':case'SEARCH_ADS':{const job=type==='SEARCH_ADS'
?Object.assign({},payload,{ads:true})
:payload;if(!dataReady){pendingSearch=job;break;}
startSearch(job);break;}
case'CANCEL':break;case'SET_COMMENTS':{const docs=Array.isArray(payload)?payload:[];set_comments(docs.map(d=>({path:d.path,texts:(d.texts||[]).map(t=>(typeof t==='string'?t:''))
})));commentGen++;if(synMod&&typeof synMod.clearSynonymCache==='function'){synMod.clearSynonymCache();}
break;}
case'SEARCH_COMMENTS':{const token=payload.token;const noise=payload.noise!==undefined?payload.noise:5;const searchKeywords=adaptKeywordsForWasm(resolvePayloadTermSpecs(payload));runCommentSearch(token,searchKeywords,noise).then(hits=>{if(hits===null)return;if(token!==undefined&&token!==latestToken)return;self.postMessage({type:'COMMENT_HITS',keyword:payload.keyword,token,commentHits:hits
});}).catch(err=>{console.error("[Worker] 评论搜索失败:",err);});break;}
case'EXPAND_QUERY':{const reqId=payload&&payload.reqId;const items=Array.isArray(payload&&payload.items)?payload.items:[];const results=items.map(it=>({text:it&&typeof it.text==='string'?it.text:'',like:!!(it&&it.like),skipCorpusFilter:!!(it&&it.skipCorpusFilter),specs:expandTermSpecs(it&&it.text,!!(it&&it.like),{skipCorpusFilter:!!(it&&it.skipCorpusFilter)})
}));self.postMessage({type:'EXPAND_RESULT',reqId,synReady,results
});break;}
case'SNIPPETS':{let snippets=null;try{if(Array.isArray(payload.adsTerms)&&payload.adsTerms.length>0){snippets=getAdsSnippets(payload);}else{const searchKeywords=adaptKeywordsForWasm(resolvePayloadTermSpecs(payload));snippets=get_snippets(payload.path,searchKeywords,payload.noise!==undefined?payload.noise:5,payload.maxBody!==undefined?payload.maxBody:40,payload.maxComments!==undefined?payload.maxComments:30
);}}catch(err){console.error("[Worker] snippet 生成失败:",err);}
self.postMessage({type:'SNIPPETS_RESULT',reqId:payload.reqId,path:payload.path,snippets
});break;}
case'COMMIT_CURSOR':{const newKw=payload.keyword;let deleteOld=null;if(lastSavedKw&&newKw.startsWith(lastSavedKw)&&newKw.length>lastSavedKw.length){deleteOld=lastSavedKw;}
lastSavedKw=newKw;if(deleteOld){self.postMessage({type:'DELETE_CACHE',keyword:deleteOld});}
break;}
case'CLEAR_CURSOR':lastSavedKw="";break;}}