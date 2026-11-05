import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {setImmediate} from 'node:timers/promises';

let source=await readFile(new URL('../lib/chemistry-proxy.ts',import.meta.url),'utf8');
source=source.replace("import {getChatGPTUser} from '../app/chatgpt-auth';",'const getChatGPTUser=async()=>globalThis.__testUser;');
const moduleURL='data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64');
let proxyChemistry,moduleId=0;
const oldFetch=globalThis.fetch;
const base='https://studio.example';
const health={status:'ready',app:'orbital-chemistry',version:'1.2.0'};
function request(body={action:'generate',smiles:'C[N+](=O)[O-]'},headers={},signal){return new Request(base+'/api/molecule',{method:'POST',headers:{'Content-Type':'application/json',Origin:base,...headers},body:typeof body==='string'?body:JSON.stringify(body),signal});}
function isHealth(url){return new URL(url).pathname==='/api/health';}
function fakeTime(t){t.mock.timers.enable({apis:['setTimeout','Date']});}
async function advance(t,ms){t.mock.timers.tick(ms);await setImmediate();}

test.beforeEach(async()=>{({proxyChemistry}=await import(moduleURL+'#'+(++moduleId)));globalThis.__testUser={userId:'owner'};process.env.CHEMISTRY_API_URL='https://chemistry.example';process.env.CHEMISTRY_API_TOKEN='test-only-secret';globalThis.fetch=async()=>{throw new Error('Unexpected request');};});
test.after(()=>{globalThis.fetch=oldFetch;delete globalThis.__testUser;delete process.env.CHEMISTRY_API_URL;delete process.env.CHEMISTRY_API_TOKEN;});

test('anonymous computation is rejected before contacting backend',async()=>{globalThis.__testUser=null;assert.equal((await proxyChemistry(request(),'/api/molecule')).status,401);});
test('cross-origin and cross-site requests cannot use server credential',async()=>{assert.equal((await proxyChemistry(request({}, {Origin:'https://other.example'}),'/api/molecule')).status,403);assert.equal((await proxyChemistry(request({}, {'Sec-Fetch-Site':'cross-site'}),'/api/molecule')).status,403);});
test('invalid JSON and actual oversized body are rejected',async()=>{assert.equal((await proxyChemistry(request('{'),'/api/molecule')).status,400);assert.equal((await proxyChemistry(request('x'.repeat(2_000_001)),'/api/molecule')).status,413);});

test('overflow numbers, lone surrogates and excessive nesting fail before waking the backend',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('Must not contact backend');};
  for(const body of ['{"samples":1e309}','{"position":[-1e999]}','{"name":"\\ud800"}','{"\\udfff":"O"}',
    '{"nested":'+'['.repeat(65)+'0'+']'.repeat(65)+'}']){
    assert.equal((await proxyChemistry(request(body),'/api/molecule')).status,400);
  }
  assert.equal(calls,0);
});

test('malformed UTF-8 and JSON-like media types cannot silently alter an import',async()=>{
  const bytes=Buffer.concat([Buffer.from('{"name":"'),Buffer.from([0xff]),Buffer.from('","smiles":"O"}')]);
  const invalid=new Request(base+'/api/molecule',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:bytes});
  assert.equal((await proxyChemistry(invalid,'/api/molecule')).status,400);
  assert.equal((await proxyChemistry(request({}, {'Content-Type':'application/json-bogus'}),'/api/molecule')).status,415);
});

test('upload failure returns JSON and never begins a calculation',async()=>{
  const failed=new Request(base+'/api/molecule',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},
    body:new ReadableStream({start(controller){controller.error(new Error('connection lost'));}}),duplex:'half'});
  const response=await proxyChemistry(failed,'/api/molecule');
  assert.equal(response.status,400);assert.match((await response.json()).error,/無法讀取/);
});

test('a stalled upload is cancelled after ten seconds without waking the backend',async t=>{
  fakeTime(t);let cancelled=false;
  const stalled=new Request(base+'/api/molecule',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},
    body:new ReadableStream({cancel(){cancelled=true;}}),duplex:'half'});
  const pending=proxyChemistry(stalled,'/api/molecule');await setImmediate();await advance(t,10000);
  const response=await pending;assert.equal(response.status,408);assert.equal(cancelled,true);
  assert.match((await response.json()).error,/逾時/);
});

test('invalid or oversized upstream JSON fails cleanly and invalidates readiness',async()=>{
  for(const bad of ['{"formula":', '[]', '{"energy":1e309}', 'x'.repeat(16*1024*1024+1)]){
    let gets=0,posts=0,fail=true;
    process.env.CHEMISTRY_API_TOKEN='test-'+bad.length;
    globalThis.fetch=async url=>{if(isHealth(url)){gets++;return Response.json(health);}posts++;return fail?new Response(bad,{headers:{'Content-Type':'application/json'}}):Response.json({formula:'H2O'});};
    const response=await proxyChemistry(request(),'/api/molecule');assert.equal(response.status,503);assert.equal(posts,1);
    fail=false;assert.equal((await proxyChemistry(request(),'/api/molecule')).status,200);assert.equal(gets,2);assert.equal(posts,2);
  }
});

test('paired Unicode escapes remain valid and the exact request body is preserved',async()=>{
  let actual;
  globalThis.fetch=async(url,options)=>{if(isHealth(url))return Response.json(health);actual=options.body;return Response.json({formula:'H2O'});};
  const body='{"smiles":"O","name":"\\ud83e\\uddea"}';
  assert.equal((await proxyChemistry(request(body),'/api/molecule')).status,200);assert.equal(actual,body);
});

test('ready health precedes exactly one authenticated POST with exact body',async()=>{
  const payload={action:'generate',smiles:'C[N+](=O)[O-]'};const calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url:String(url),options});assert.equal(options.headers.Authorization,'Bearer test-only-secret');assert.equal(options.redirect,'manual');return Response.json(isHealth(url)?health:{displayFormula:'CH3NO2'});};
  const response=await proxyChemistry(request(payload),'/api/molecule');
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{displayFormula:'CH3NO2'});
  assert.deepEqual(calls.map(c=>c.url),['https://chemistry.example/api/health','https://chemistry.example/api/molecule']);
  assert.equal(calls[0].options.method,undefined);assert.equal(calls[0].options.body,undefined);assert.equal(calls[1].options.method,'POST');assert.deepEqual(JSON.parse(calls[1].options.body),payload);
});

test('health HTML cold start is retried before sending one calculation',async t=>{
  fakeTime(t);let gets=0,posts=0;
  globalThis.fetch=async(url)=>{if(isHealth(url)){gets++;return gets===1?new Response('<html>boot</html>',{headers:{'Content-Type':'text/html'}}):Response.json(health);}posts++;return Response.json({displayFormula:'CH4'});};
  const pending=proxyChemistry(request(),'/api/molecule');await setImmediate();assert.equal(posts,0);await advance(t,1500);
  assert.equal((await pending).status,200);assert.equal(gets,2);assert.equal(posts,1);
});

test('warmup auth and redirects fail immediately without leaking upstream details or posting',async()=>{
  for(const status of [301,302,303,307,308,401,403]){let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({error:'private detail'},{status,headers:{Location:'https://other.example/secret'}});};const result=await proxyChemistry(request(),'/api/molecule');assert.equal(result.status,503);assert.equal(calls,1);assert.equal(result.headers.get('location'),null);assert.equal((await result.text()).includes('private detail'),false);}
});

test('busy health fails immediately and busy calculation is never replayed',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({error:'忙碌中'},{status:429});};assert.equal((await proxyChemistry(request(),'/api/molecule')).status,429);assert.equal(calls,1);
  let posts=0;globalThis.fetch=async url=>{if(isHealth(url))return Response.json(health);posts++;return Response.json({error:'忙碌中'},{status:429});};assert.equal((await proxyChemistry(request(),'/api/molecule')).status,429);assert.equal(posts,1);
});

test('calculation HTML or server failure never replays the POST',async()=>{
  for(const html of [true,false]){let posts=0;globalThis.fetch=async url=>{if(isHealth(url))return Response.json(health);posts++;return html?new Response('<html>boot</html>',{headers:{'Content-Type':'text/html'}}):Response.json({error:'compute failed'},{status:500});};const result=await proxyChemistry(request(),'/api/molecule');assert.equal(result.status,html?503:500);assert.equal(posts,1);assert.equal((await result.text()).includes('<html>'),false);}
});

test('cancelling warmup stops further GET attempts and sends no POST',async t=>{
  fakeTime(t);let calls=0;const cancel=new AbortController();globalThis.fetch=async()=>{calls++;return new Response('boot',{status:503});};
  const pending=proxyChemistry(request(undefined,{},cancel.signal),'/api/molecule');await setImmediate();assert.equal(calls,1);cancel.abort();assert.equal((await pending).status,503);await advance(t,100000);assert.equal(calls,1);
});

test('warmup has a 75 second deadline with no calculation sent',async t=>{
  fakeTime(t);let posts=0;globalThis.fetch=async url=>{if(!isHealth(url))posts++;return new Response('boot',{status:503});};
  const pending=proxyChemistry(request(),'/api/molecule');await setImmediate();await advance(t,75000);const result=await pending;assert.equal(result.status,503);assert.match(await result.text(),/啟動較久/);assert.equal(posts,0);
});

test('a stalled health request is aborted and retried as GET only',async t=>{
  fakeTime(t);let gets=0,posts=0;let firstAborted=false;
  globalThis.fetch=async(url,options)=>{if(!isHealth(url)){posts++;return Response.json({ok:true});}gets++;if(gets>1)return Response.json(health);return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{firstAborted=true;reject(new DOMException('timeout','AbortError'));},{once:true}));};
  const pending=proxyChemistry(request(),'/api/molecule');await setImmediate();await advance(t,15000);assert.equal(firstAborted,true);assert.equal(posts,0);await advance(t,1500);assert.equal((await pending).status,200);assert.equal(gets,2);assert.equal(posts,1);
});

test('the 50 second calculation deadline covers a stalled response body',async t=>{
  fakeTime(t);let posts=0;
  globalThis.fetch=async(url,options)=>{if(isHealth(url))return Response.json(health);posts++;return new Response(new ReadableStream({start(controller){options.signal.addEventListener('abort',()=>controller.error(new DOMException('timeout','AbortError')),{once:true});}}),{headers:{'Content-Type':'application/json'}});};
  const pending=proxyChemistry(request(),'/api/molecule');await setImmediate();assert.equal(posts,1);await advance(t,50000);const result=await pending;assert.equal(result.status,503);assert.match(await result.text(),/逾時/);assert.equal(posts,1);
});

test('sequential warm calculations reuse only readiness and still check identity and origin',async()=>{
  const calls=[];let posts=0;
  globalThis.fetch=async(url,options)=>{calls.push(isHealth(url)?'GET':'POST');return Response.json(isHealth(url)?health:{sequence:++posts,smiles:JSON.parse(options.body).smiles});};
  assert.deepEqual(await (await proxyChemistry(request({action:'generate',smiles:'C'}),'/api/molecule')).json(),{sequence:1,smiles:'C'});
  assert.deepEqual(await (await proxyChemistry(request({action:'generate',smiles:'CC'}),'/api/molecule')).json(),{sequence:2,smiles:'CC'});
  globalThis.__testUser=null;
  assert.equal((await proxyChemistry(request(),'/api/molecule')).status,401);
  globalThis.__testUser={userId:'owner'};
  assert.equal((await proxyChemistry(request({}, {Origin:'https://other.example'}),'/api/molecule')).status,403);
  assert.deepEqual(calls,['GET','POST','POST']);
});

test('readiness expires after 60 seconds and explicit health always checks upstream',async t=>{
  fakeTime(t);const calls=[];
  globalThis.fetch=async url=>{calls.push(isHealth(url)?'GET':'POST');return Response.json(isHealth(url)?health:{ok:true});};
  await proxyChemistry(request(),'/api/molecule');
  await advance(t,59000);await proxyChemistry(request(),'/api/molecule');
  await advance(t,1000);await proxyChemistry(request(),'/api/molecule');
  await proxyChemistry(new Request(base+'/api/health'),'/api/health');
  assert.deepEqual(calls,['GET','POST','POST','GET','POST','GET']);
});

test('changing service origin or credential cannot reuse old readiness',async()=>{
  let healthChecks=0;
  globalThis.fetch=async url=>{if(isHealth(url))healthChecks++;return Response.json(isHealth(url)?health:{ok:true});};
  await proxyChemistry(request(),'/api/molecule');
  process.env.CHEMISTRY_API_TOKEN='a-different-test-token';await proxyChemistry(request(),'/api/molecule');
  process.env.CHEMISTRY_API_URL='https://new-chemistry.example';await proxyChemistry(request(),'/api/molecule');
  assert.equal(healthChecks,3);
});

test('upstream failures invalidate readiness without replaying a calculation',async()=>{
  for(const failure of ['html','network',500,401,403,302]){
    let gets=0,posts=0,failNext=false;
    process.env.CHEMISTRY_API_TOKEN='test-for-'+failure;
    globalThis.fetch=async url=>{
      if(isHealth(url)){gets++;return Response.json(health);}
      posts++;
      if(failNext){failNext=false;if(failure==='network')throw new Error('unavailable');if(failure==='html')return new Response('<html>boot</html>',{headers:{'content-type':'text/html'}});return Response.json({error:'failed'},{status:failure});}
      return Response.json({ok:true});
    };
    await proxyChemistry(request(),'/api/molecule');failNext=true;
    assert.equal((await proxyChemistry(request(),'/api/molecule')).status, failure===500?500:503);
    assert.equal(posts,2);assert.equal(gets,1);
    assert.equal((await proxyChemistry(request(),'/api/molecule')).status,200);
    assert.equal(posts,3);assert.equal(gets,2);
  }
});
