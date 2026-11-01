import {getChatGPTUser} from '../app/chatgpt-auth';

const MAX_BODY=2_000_000;
function json(error:string,status:number){return Response.json({error},{status,headers:{'Cache-Control':'no-store'}});}

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
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),125000);
  const abort=()=>controller.abort();request.signal.addEventListener('abort',abort,{once:true});
  try {
    const response=await fetch(endpoint,{method:path==='/api/molecule'?'POST':'GET',headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body,signal:controller.signal,redirect:'error'});
    if(!response.headers.get('content-type')?.includes('application/json'))return json('雲端服務正在啟動或暫時無法回應，請稍後再試。',503);
    if(response.status===401||response.status===403)return json('雲端服務連線設定需要更新。',503);
    return new Response(response.body,{status:response.status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  } catch {return json(controller.signal.aborted?'雲端回應逾時，請稍後再試。':'雲端計算服務暫時無法連線，請稍後再試。',503);}
  finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);}
}
