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
    let data;
    try {data=await response.json();} catch {throw new Error(hosted?'雲端服務正在啟動或暫時無法回應，請稍後再試。':'計算服務回應無法讀取，請重新啟動 App。');}
    if(!response.ok||data.error)throw new Error(data.error||(response.status===401?'登入已逾時，請重新整理並登入。':response.status===429?'計算服務忙碌中，請稍後再試。':'計算未完成'));
    if(controller.signal.aborted)throw new DOMException('Cancelled','AbortError');
    rememberPreview(key,data);
    return data;
  } catch(error) {
    if(error.name==='AbortError'&&!signal?.aborted)throw new Error('等待計算逾時，原結構已保留，請稍後再試。');
    throw error;
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
