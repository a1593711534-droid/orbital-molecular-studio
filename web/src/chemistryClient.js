// One request per user operation. Never silently replay a structural edit.
export async function chemistryRequest(payload, {signal, hosted=false}={}) {
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
    return data;
  } catch(error) {
    if(error.name==='AbortError'&&!signal?.aborted)throw new Error('等待計算逾時，原結構已保留，請稍後再試。');
    throw error;
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
