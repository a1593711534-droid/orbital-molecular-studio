import {getChatGPTUser} from '../app/chatgpt-auth';

const MAX_BODY=2_000_000;
const TOTAL_TIMEOUT_MS=125_000;
const WARMUP_TIMEOUT_MS=75_000;
const HEALTH_ATTEMPT_MS=15_000;
const HEALTH_RETRY_MS=1_500;
const COMPUTE_TIMEOUT_MS=50_000;
function json(error:string,status:number){return Response.json({error},{status,headers:{'Cache-Control':'no-store'}});}
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
type Readiness={ok:true;health:Record<string,unknown>}|{ok:false;response:Response};
async function waitUntilReady(endpoint:URL,token:string,signal:AbortSignal):Promise<Readiness>{
  const deadline=Date.now()+WARMUP_TIMEOUT_MS;
  const healthURL=new URL('/api/health',endpoint.origin);
  while(Date.now()<deadline){
    if(signal.aborted)throw new DOMException('Cancelled','AbortError');
    const attempt=boundedSignal(signal,Math.min(HEALTH_ATTEMPT_MS,deadline-Date.now()));
    try{
      // Waking a free instance is a read-only GET. A structural POST is never replayed.
      const response=await fetch(healthURL,{headers:{Authorization:`Bearer ${token}`},signal:attempt.signal,redirect:'manual'});
      if(response.status>=300&&response.status<400||response.status===401||response.status===403){
        diagnostic('warmup','configuration',response);await discard(response);
        return {ok:false,response:json('雲端服務連線設定需要更新。',503)};
      }
      if(response.status>=400&&response.status<500){
        diagnostic('warmup','rejected',response);await discard(response);
        return {ok:false,response:json(response.status===429?'計算服務忙碌中，請稍後再試。':'雲端服務連線設定需要更新。',response.status===429?429:503)};
      }
      if(response.status>=500||!response.headers.get('content-type')?.toLowerCase().includes('application/json')){
        diagnostic('warmup','not-ready',response);await discard(response);
      }else{
        const health=await response.json() as Record<string,unknown>|null;
        if(response.status===200&&health&&health.status==='ready'&&health.app==='orbital-chemistry')return {ok:true,health};
        diagnostic('warmup','invalid-health',response);
        return {ok:false,response:json('雲端服務連線設定需要更新。',503)};
      }
    }catch{
      if(signal.aborted)throw new DOMException('Cancelled','AbortError');
      diagnostic('warmup',attempt.signal.aborted?'attempt-timeout':'unavailable');
    }finally{attempt.cleanup();}
    const remaining=deadline-Date.now();
    if(remaining>0)await delay(Math.min(HEALTH_RETRY_MS,remaining),signal);
  }
  diagnostic('warmup','deadline');
  return {ok:false,response:json('雲端服務啟動較久，原結構已保留，請稍後再試。',503)};
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
    if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return json('請使用 JSON 結構資料。',415);
    if(Number(request.headers.get('content-length')||0)>MAX_BODY)return json('結構資料上限為 2 MB。',413);
    const reader=request.body?.getReader();
    if(!reader)return json('缺少結構資料。',400);
    const chunks:Uint8Array[]=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BODY){await reader.cancel();return json('結構資料上限為 2 MB。',413);}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    body=new TextDecoder().decode(bytes);
    try{const value=JSON.parse(body);if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();}catch{return json('無法讀取結構資料。',400);}
  }
  const operation=boundedSignal(request.signal,TOTAL_TIMEOUT_MS);
  let compute:ReturnType<typeof boundedSignal>|undefined;
  try {
    const readiness=await waitUntilReady(endpoint,token,operation.signal);
    if(!readiness.ok)return readiness.response;
    if(path==='/api/health')return Response.json(readiness.health,{headers:{'Cache-Control':'no-store'}});
    if(operation.signal.aborted)throw new DOMException('Cancelled','AbortError');
    compute=boundedSignal(operation.signal,COMPUTE_TIMEOUT_MS);
    // Workers supports manual/follow only. Reject redirects ourselves so the
    // server credential and molecule body never travel to another destination.
    const response=await fetch(endpoint,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body,signal:compute.signal,redirect:'manual'});
    if(response.status>=300&&response.status<400||response.status===401||response.status===403){
      diagnostic('compute','configuration',response);await discard(response);
      return json('雲端服務連線設定需要更新。',503);
    }
    if(!response.headers.get('content-type')?.toLowerCase().includes('application/json')){
      diagnostic('compute','non-json',response);await discard(response);
      return json('雲端服務暫時無法回應，原結構已保留，請稍後再試。',503);
    }
    if(response.status>=500)diagnostic('compute','upstream-error',response);
    // Keep the deadline active through the body; receiving headers alone does
    // not mean a calculation finished. Returning a stream would clear it early.
    const result=await response.text();
    return new Response(result,{status:response.status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  } catch {
    const timedOut=operation.signal.aborted||compute?.signal.aborted;
    diagnostic(compute?'compute':'warmup',timedOut?'cancelled-or-timeout':'unavailable');
    return json(timedOut?'雲端回應逾時，原結構已保留，請稍後再試。':'雲端計算服務暫時無法連線，請稍後再試。',503);
  } finally{compute?.cleanup();operation.cleanup();}
}
