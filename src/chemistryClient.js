// Preview-only memory cache. It disappears with the page and never caches 3D edits.
const previews=new Map();
const PREVIEW_TTL_MS=120_000,MAX_PREVIEWS=32;
function previewKey(payload,hosted){
  return payload?.action==='inspect'&&typeof payload.smiles==='string'&&Object.keys(payload).every(key=>key==='action'||key==='smiles')
    ?JSON.stringify([hosted,payload.smiles]):null;
}
function cachedPreview(key){
  const entry=previews.get(key);
  if(!entry)return null;
  if(Date.now()>=entry.expires){previews.delete(key);return null;}
  previews.delete(key);previews.set(key,entry);
  return JSON.parse(entry.json);
}
function rememberPreview(key,data){
  if(!key||data.valid!==true)return;
  const json=JSON.stringify(data);
  if(json.length>256_000)return;
  previews.delete(key);previews.set(key,{json,expires:Date.now()+PREVIEW_TTL_MS});
  while(previews.size>MAX_PREVIEWS)previews.delete(previews.keys().next().value);
}

let pendingWarmup;
function warmupFailure(response,data){
  let message;
  if(response.status===401)message='登入已逾時，請重新整理並登入。';
  else if(data?.code==='wake_rate_limited')message='雲端服務的啟動請求暫時受限，請稍後重試。';
  else if(data?.code==='startup_timeout')message='雲端服務啟動時間較長，請重試連線。';
  else if(typeof data?.error==='string'&&data.error.trim())message=data.error;
  else if(response.status===429)message='計算服務忙碌中，請稍後再試。';
  else message='雲端計算服務暫時無法回應，請重試連線。';
  const error=new Error(message);
  error.canRetryStartup=data?.code==='wake_rate_limited'||data?.code==='startup_timeout';
  const retryAfter=response.headers.get('Retry-After');
  if(retryAfter){
    const retryAt=/^\d+$/.test(retryAfter)?Date.now()+Number(retryAfter)*1000:Date.parse(retryAfter);
    if(Number.isFinite(retryAt)&&retryAt>Date.now())error.retryAt=retryAt;
  }
  return error;
}
async function checkCloudHealth(wakeUrl){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),135_000);
  try{
    // The public liveness endpoint accepts no user data. Its opaque response
    // cannot confirm readiness; only the authenticated, same-origin GET can.
    if(wakeUrl){
      void fetch(wakeUrl,{method:'GET',mode:'no-cors',credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store'}).catch(()=>{});
    }
    const response=await fetch('/api/health',{
      method:'GET',credentials:'same-origin',cache:'no-store',signal:controller.signal,
    });
    const data=await response.json().catch(()=>null);
    if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');
    if(!response.ok)throw warmupFailure(response,data);
    if(data?.app!=='orbital-chemistry'||data.status!=='ready'){
      throw new Error('尚未收到計算服務的就緒回應，請重試連線。');
    }
  }catch(error){
    if(controller.signal.aborted)throw new Error('等待雲端計算服務逾時，請重試連線。');
    if(error instanceof TypeError)throw new Error('無法連上雲端計算服務，請檢查網路後重試。');
    throw error;
  }finally{clearTimeout(timer);}
}

// Multiple mounts can wait on the same GET. A later opening or manual retry
// performs a fresh check because the Render service may have gone back to sleep.
export function warmChemistry(wakeUrl){
  if(!pendingWarmup)pendingWarmup=checkCloudHealth(wakeUrl).finally(()=>{pendingWarmup=undefined;});
  return pendingWarmup;
}

// One request per uncached user operation. Never replay a structural edit.
export async function chemistryRequest(payload, {signal, hosted=false}={}) {
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  const key=previewKey(payload,hosted);
  const cached=key&&cachedPreview(key);
  if(cached)return cached;
  const controller=new AbortController();
  const abort=()=>controller.abort();
  if(signal?.aborted)controller.abort();
  else signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,hosted?135000:65000);
  try {
    const response=await fetch('/api/molecule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});
    const statusMessage=response.status===401?'登入已逾時，請重新整理並登入。':response.status===429?'計算服務忙碌中，請稍後再試。':null;
    const unreadable=()=>new Error(statusMessage||(hosted?'雲端服務正在啟動或暫時無法回應，請稍後再試。':'計算服務回應無法讀取，請重新啟動 App。'));
    let data;
    try {data=await response.json();} catch(error) {
      // Aborting after response headers also aborts body decoding. Preserve the
      // cancellation so stale previews and genuine timeouts are handled alike.
      if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');
      throw unreadable();
    }
    if(!data||typeof data!=='object'||Array.isArray(data))throw unreadable();
    if(hosted&&!response.ok&&(data.code==='startup_timeout'||data.code==='wake_rate_limited')){
      const failure=warmupFailure(response,data);
      failure.message+=' 請重新連線後再次提交。';
      throw failure;
    }
    if(!response.ok||data.error){
      const error = new Error(typeof data.error==='string'?data.error:statusMessage||'計算未完成');
      error.status = response.status;
      throw error;
    }
    if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');
    rememberPreview(key,data);
    return data;
  } catch(error) {
    if(error.name==='AbortError'&&!signal?.aborted)throw new Error('等待計算逾時，原結構已保留，請稍後再試。');
    throw error;
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
