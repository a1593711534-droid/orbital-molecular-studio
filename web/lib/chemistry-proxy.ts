import {getChatGPTUser} from '../app/chatgpt-auth';

const MAX_BODY=2_000_000;
const MAX_RESPONSE=16*1024*1024;
const UPLOAD_TIMEOUT_MS=10_000;
const TOTAL_TIMEOUT_MS=125_000;
const WARMUP_TIMEOUT_MS=75_000;
const HEALTH_ATTEMPT_MS=15_000;
const HEALTH_RETRY_MS=1_500;
const MAX_HEALTH_BACKOFF_MS=12_000;
const COMPUTE_TIMEOUT_MS=50_000;
const READY_TTL_MS=60_000;
// One service readiness hint per isolate, never molecule data or user identity.
// Authentication and origin checks still run for every incoming request.
let readyService:{origin:string;token:string;expires:number;health:Record<string,unknown>}|undefined;
function forgetReadiness(endpoint:URL,token:string){
  if(readyService?.origin===endpoint.origin&&readyService.token===token)readyService=undefined;
}
function json(error:string,status:number){return Response.json({error},{status,headers:{'Cache-Control':'no-store'}});}
function startupFailure(limited:boolean,retryMs:number){
  return Response.json(limited
    ? {code:'wake_rate_limited',error:'Render 暫時限制啟動連線，計算尚未送出。'}
    : {code:'startup_timeout',error:'Render 啟動較久，計算尚未送出。'},
    {status:limited?429:503,headers:{'Cache-Control':'no-store','Retry-After':String(Math.max(1,Math.ceil(retryMs/1000)))}});
}
function diagnostic(stage:'warmup'|'compute',reason:string,response?:Response){
  const type=response?.headers.get('content-type')?.toLowerCase();
  // Never log credentials, payloads, URLs, exception messages or raw headers.
  console.warn('orbital-chemistry',JSON.stringify({stage,reason,status:response?.status,
    contentType:!type?'missing':type.includes('application/json')?'json':type.includes('text/html')?'html':'other'}));
}
async function discard(response:Response){try{await response.body?.cancel();}catch{/* Already consumed or cancelled. */}}
function delay(ms:number,signal:AbortSignal){
  return new Promise<void>((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new DOMException('Cancelled','AbortError'));};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
  });
}
function boundedSignal(parent:AbortSignal,ms:number){
  const controller=new AbortController();
  const abort=()=>controller.abort();
  parent.addEventListener('abort',abort,{once:true});
  if(parent.aborted)abort();
  const timer=setTimeout(abort,ms);
  return {signal:controller.signal,cleanup:()=>{clearTimeout(timer);parent.removeEventListener('abort',abort);}};
}
function isJSON(headers:Headers){return headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()==='application/json';}
function retryAfterMs(headers:Headers){
  const value=headers.get('retry-after')?.trim();
  if(!value)return 0;
  if(/^\d+$/.test(value))return Math.min(Number.MAX_SAFE_INTEGER,Number(value)*1000);
  const when=Date.parse(value);
  return Number.isFinite(when)?Math.max(0,when-Date.now()):0;
}
class BodySizeError extends Error {}
function parseObject(text:string){
  const value=JSON.parse(text);
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Expected object');
  const pending:Array<[unknown,number]>=[[value,0]];
  while(pending.length){
    const [item,depth]=pending.pop()!;
    if(depth>64)throw new Error('JSON nesting is too deep');
    if(typeof item==='number'&&!Number.isFinite(item))throw new Error('Non-finite number');
    // With the Unicode flag, paired surrogates form a single code point and do
    // not match this range. Lone surrogates cannot cross a UTF-8 worker pipe.
    if(typeof item==='string'&&/[\uD800-\uDFFF]/u.test(item))throw new Error('Invalid Unicode');
    if(item&&typeof item==='object')for(const [key,child] of Object.entries(item)){
      if(/[\uD800-\uDFFF]/u.test(key))throw new Error('Invalid Unicode');
      pending.push([child,depth+1]);
    }
  }
  return value as Record<string,unknown>;
}
async function readText(stream:ReadableStream<Uint8Array>|null,limit:number,signal:AbortSignal){
  if(!stream)throw new Error('Missing body');
  const reader=stream.getReader();
  const abort=()=>{void reader.cancel().catch(()=>{});};
  const chunks:Uint8Array[]=[];let size=0;
  signal.addEventListener('abort',abort,{once:true});
  try{
    if(signal.aborted)throw new DOMException('Cancelled','AbortError');
    while(true){
      const {done,value}=await reader.read();
      if(signal.aborted)throw new DOMException('Cancelled','AbortError');
      if(done)break;
      size+=value.byteLength;
      if(size>limit){void reader.cancel().catch(()=>{});throw new BodySizeError('Body too large');}
      chunks.push(value);
    }
    const bytes=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  }finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
}
type Readiness={ok:true;health:Record<string,unknown>}|{ok:false;response:Response};
async function waitUntilReady(endpoint:URL,token:string,signal:AbortSignal,fresh=false):Promise<Readiness>{
  if(signal.aborted)throw new DOMException('Cancelled','AbortError');
  if(!fresh&&readyService?.origin===endpoint.origin&&readyService.token===token&&Date.now()<readyService.expires){
    return {ok:true,health:readyService.health};
  }
  // Explicit health checks are fresh; expired or changed configuration is never reused.
  readyService=undefined;
  const deadline=Date.now()+WARMUP_TIMEOUT_MS;
  const healthURL=new URL('/api/health',endpoint.origin);
  let backoff=HEALTH_RETRY_MS;
  while(Date.now()<deadline){
    if(signal.aborted)throw new DOMException('Cancelled','AbortError');
    const attempt=boundedSignal(signal,Math.min(HEALTH_ATTEMPT_MS,deadline-Date.now()));
    let wait=backoff;
    try{
      // Waking a free instance is a read-only GET. A structural POST is never replayed.
      const response=await fetch(healthURL,{headers:{Authorization:`Bearer ${token}`},signal:attempt.signal,redirect:'manual'});
      if(response.status>=300&&response.status<400||response.status===401||response.status===403){
        diagnostic('warmup','configuration',response);await discard(response);
        return {ok:false,response:json('雲端服務連線設定需要更新。',503)};
      }
      // The backend's concurrency limit applies to computation POSTs only.
      // A 429 during this GET means the readiness check was rate-limited.
      const limited=response.status===429;
      if(response.status>=400&&response.status<500&&!limited){
        diagnostic('warmup','rejected',response);await discard(response);
        return {ok:false,response:json('雲端服務連線設定需要更新。',503)};
      }
      if(limited||response.status>=500||!isJSON(response.headers)){
        wait=Math.max(backoff,retryAfterMs(response.headers));
        diagnostic('warmup','not-ready',response);await discard(response);
        if(wait>=deadline-Date.now()){
          return {ok:false,response:startupFailure(limited,wait)};
        }
      }else{
        const health=parseObject(await readText(response.body,64*1024,attempt.signal));
        if(response.status===200&&health&&health.status==='ready'&&health.app==='orbital-chemistry'){
          readyService={origin:endpoint.origin,token,expires:Date.now()+READY_TTL_MS,health};
          return {ok:true,health};
        }
        diagnostic('warmup','invalid-health',response);
        return {ok:false,response:json('雲端服務連線設定需要更新。',503)};
      }
    }catch{
      if(signal.aborted)throw new DOMException('Cancelled','AbortError');
      diagnostic('warmup',attempt.signal.aborted?'attempt-timeout':'unavailable');
    }finally{attempt.cleanup();}
    const remaining=deadline-Date.now();
    if(remaining>0)await delay(Math.min(wait,remaining),signal);
    backoff=Math.min(backoff*2,MAX_HEALTH_BACKOFF_MS);
  }
  diagnostic('warmup','deadline');
  return {ok:false,response:startupFailure(false,HEALTH_RETRY_MS)};
}

export async function proxyChemistry(request:Request,path:'/api/molecule'|'/api/health') {
  if(!await getChatGPTUser())return json('請重新整理頁面並登入。',401);
  const origin=request.headers.get('origin');
  if(origin&&origin!==new URL(request.url).origin)return json('不允許跨來源請求。',403);
  if(request.headers.get('sec-fetch-site')==='cross-site')return json('不允許跨來源請求。',403);
  const base=process.env.CHEMISTRY_API_URL;
  const token=process.env.CHEMISTRY_API_TOKEN;
  if(!base||!token)return json('雲端計算服務尚未設定完成。',503);
  let endpoint:URL;
  try {endpoint=new URL(base);if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password)throw new Error();endpoint=new URL(path,endpoint.origin);}catch{return json('雲端計算服務設定無效。',503);}
  let body:string|undefined;
  if(path==='/api/molecule'){
    if(!isJSON(request.headers))return json('請使用 JSON 結構資料。',415);
    if(Number(request.headers.get('content-length')||0)>MAX_BODY)return json('結構資料上限為 2 MB。',413);
    const upload=boundedSignal(request.signal,UPLOAD_TIMEOUT_MS);
    try{body=await readText(request.body,MAX_BODY,upload.signal);parseObject(body);}
    catch(error){
      if(error instanceof BodySizeError)return json('結構資料上限為 2 MB。',413);
      if(upload.signal.aborted)return json('資料傳送已取消或逾時，請重新操作。',408);
      return json('無法讀取結構資料。',400);
    }finally{upload.cleanup();}
  }
  const operation=boundedSignal(request.signal,TOTAL_TIMEOUT_MS);
  let compute:ReturnType<typeof boundedSignal>|undefined;
  try {
    const readiness=await waitUntilReady(endpoint,token,operation.signal,path==='/api/health');
    if(!readiness.ok)return readiness.response;
    if(path==='/api/health')return Response.json(readiness.health,{headers:{'Cache-Control':'no-store'}});
    if(operation.signal.aborted)throw new DOMException('Cancelled','AbortError');
    compute=boundedSignal(operation.signal,COMPUTE_TIMEOUT_MS);
    // Workers supports manual/follow only. Reject redirects ourselves so the
    // server credential and molecule body never travel to another destination.
    const response=await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body,signal:compute.signal,redirect:'manual'});
    if(response.status>=300&&response.status<400||response.status===401||response.status===403){
      forgetReadiness(endpoint,token);
      diagnostic('compute','configuration',response);await discard(response);
      return json('雲端服務連線設定需要更新。',503);
    }
    if(!isJSON(response.headers)){
      forgetReadiness(endpoint,token);
      diagnostic('compute','non-json',response);await discard(response);
      return json('雲端服務暫時無法回應，原結構已保留，請稍後再試。',503);
    }
    if(response.status>=500){forgetReadiness(endpoint,token);diagnostic('compute','upstream-error',response);}
    // Keep the deadline active through the body; receiving headers alone does
    // not mean a calculation finished. Returning a stream would clear it early.
    const result=await readText(response.body,MAX_RESPONSE,compute.signal);
    parseObject(result);
    const headers=new Headers({'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    const retryMs=retryAfterMs(response.headers);
    if(response.status===429&&retryMs>0)headers.set('Retry-After',String(Math.ceil(retryMs/1000)));
    return new Response(result,{status:response.status,headers});
  } catch {
    forgetReadiness(endpoint,token);
    const timedOut=operation.signal.aborted||compute?.signal.aborted;
    diagnostic(compute?'compute':'warmup',timedOut?'cancelled-or-timeout':'unavailable');
    return json(timedOut?'雲端回應逾時，原結構已保留，請稍後再試。':'雲端計算服務暫時無法連線，請稍後再試。',503);
  } finally{compute?.cleanup();operation.cleanup();}
}
