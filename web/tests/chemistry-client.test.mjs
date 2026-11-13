import test from 'node:test';
import assert from 'node:assert/strict';

const originalFetch=globalThis.fetch;
let chemistryRequest,warmChemistry,moduleId=0;
const inspect=smiles=>({action:'inspect',smiles});
const preview=smiles=>({valid:true,canonicalSmiles:smiles,svg:'<svg/>',atoms:[{element:'N'}]});
test.beforeEach(async()=>{({chemistryRequest,warmChemistry}=await import('../src/chemistryClient.js?test='+(++moduleId)));});
test.afterEach(()=>{globalThis.fetch=originalFetch;});

const readyHealth=()=>Response.json({app:'orbital-chemistry',status:'ready'});
const wakeUrl='https://orbital.example/healthz';

test('concurrent hosted mounts share one anonymous wake and one authenticated readiness check',async()=>{
  const calls=[];
  let finishHealth;
  globalThis.fetch=async(url,options)=>{
    calls.push({url,options});
    if(url===wakeUrl)return new Response();
    return new Promise(resolve=>{finishHealth=resolve;});
  };
  const first=warmChemistry(wakeUrl);
  assert.equal(first,warmChemistry(wakeUrl));
  assert.deepEqual(calls.map(c=>c.url),[wakeUrl,'/api/health']);
  assert.deepEqual(calls[0].options,{method:'GET',mode:'no-cors',credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store'});
  assert.equal(calls[1].options.credentials,'same-origin');
  assert.equal(calls[1].options.cache,'no-store');
  assert.equal(calls[1].options.method,'GET');
  finishHealth(readyHealth());
  await first;
});

test('only the same-origin chemistry readiness marker opens the workspace',async()=>{
  for(const body of [{app:'other',status:'ready'},{app:'orbital-chemistry',status:'starting'},null]){
    globalThis.fetch=async url=>url===wakeUrl?readyHealth():Response.json(body);
    await assert.rejects(warmChemistry(wakeUrl),/尚未收到計算服務的就緒回應/);
  }
  globalThis.fetch=async url=>{
    if(url===wakeUrl)throw new TypeError('blocked');
    return readyHealth();
  };
  await warmChemistry(wakeUrl);
});

test('a failed startup can be retried without replaying a molecule operation',async()=>{
  const calls=[];
  let available=false;
  globalThis.fetch=async(url,options)=>{
    calls.push([url,options.method]);
    if(url===wakeUrl)return new Response();
    return available?readyHealth():new Response('sign in',{status:401});
  };
  await assert.rejects(warmChemistry(wakeUrl),/登入已逾時/);
  available=true;
  await warmChemistry(wakeUrl);
  assert.deepEqual(calls,[[wakeUrl,'GET'],['/api/health','GET'],[wakeUrl,'GET'],['/api/health','GET']]);
});

test('startup exposes the proxy cooldown and distinguishes wake throttling from a busy engine',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,0,1)});
  for(const [code,header,seconds,message] of [
    ['wake_rate_limited','8',8,/啟動請求暫時受限/],
    ['startup_timeout',new Date(Date.now()+5000).toUTCString(),5,/啟動時間較長/],
    [undefined,'3',3,/計算服務忙碌/],
  ]){
    globalThis.fetch=async()=>Response.json({code},{status:429,headers:{'Retry-After':header}});
    await assert.rejects(warmChemistry(),e=>message.test(e.message)&&e.retryAt===Date.now()+seconds*1000);
  }
});

test('a startup network timeout is recoverable on the next check',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  globalThis.fetch=(_url,{signal})=>new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
  });
  const pending=warmChemistry();
  t.mock.timers.tick(135_000);
  await assert.rejects(pending,/等待雲端計算服務逾時/);
  globalThis.fetch=async()=>readyHealth();
  await warmChemistry();
});

test('a cold service found by the first operation after idle requires reconnection and never replays the edit',async()=>{
  for(const code of ['startup_timeout','wake_rate_limited']){
    const calls=[];
    globalThis.fetch=async(url,options)=>{
      calls.push([url,options.method]);
      return Response.json({code,error:'cold'},{status:503,headers:{'Retry-After':'5'}});
    };
    await assert.rejects(chemistryRequest({action:'generate',smiles:'O'},{hosted:true}),e=>
      e.canRetryStartup&&e.retryAt>Date.now()&&e.message.includes('重新連線後再次提交'));
    assert.deepEqual(calls,[['/api/molecule','POST']]);
  }
});

test('reopening the exact preview reuses memory and returns isolated objects',async()=>{
  let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json(preview('[NH4+]'));};
  const first=await chemistryRequest(inspect('[NH4+]'),{hosted:true});
  first.atoms[0].element='changed';
  const second=await chemistryRequest(inspect('[NH4+]'),{hosted:true});
  assert.equal(calls,1);assert.equal(second.atoms[0].element,'N');
  second.atoms[0].element='also changed';
  assert.equal((await chemistryRequest(inspect('[NH4+]'),{hosted:true})).atoms[0].element,'N');
});

test('SMILES spelling and local/hosted mode have distinct previews',async()=>{
  let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json(preview('C'));};
  await chemistryRequest(inspect('C'),{hosted:true});
  await chemistryRequest(inspect('C'),{hosted:false});
  await chemistryRequest(inspect(' C'),{hosted:true});
  assert.equal(calls,3);
});

test('previews expire after two minutes rather than staying stale',async t=>{
  t.mock.timers.enable({apis:['Date']});let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json(preview('C'));};
  await chemistryRequest(inspect('C'));t.mock.timers.tick(119999);
  await chemistryRequest(inspect('C'));assert.equal(calls,1);
  t.mock.timers.tick(1);await chemistryRequest(inspect('C'));assert.equal(calls,2);
});

test('preview memory is bounded and evicts least recently used inputs',async()=>{
  const calls=[];
  globalThis.fetch=async(_url,options)=>{const smiles=JSON.parse(options.body).smiles;calls.push(smiles);return Response.json(preview(smiles));};
  for(let i=1;i<=32;i++)await chemistryRequest(inspect('C'.repeat(i)));
  await chemistryRequest(inspect('C')); // keep first entry recent
  await chemistryRequest(inspect('C'.repeat(33)));
  await chemistryRequest(inspect('C'));assert.equal(calls.length,33);
  await chemistryRequest(inspect('CC'));assert.equal(calls.length,34);
});

test('3D operations and expanded preview payloads always reach the server once',async()=>{
  let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json(preview('C'));};
  for(let i=0;i<2;i++)await chemistryRequest({action:'generate',smiles:'C'});
  for(let i=0;i<2;i++)await chemistryRequest({...inspect('C'),futureOption:true});
  assert.equal(calls,4);
});

test('transport errors and invalid input results are never cached',async()=>{
  let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json({error:'busy'},{status:503});};
  for(let i=0;i<2;i++)await assert.rejects(chemistryRequest(inspect('C')),/busy/);
  globalThis.fetch=async()=>{calls++;return Response.json({valid:false,message:'unfinished'});};
  for(let i=0;i<2;i++)assert.equal((await chemistryRequest(inspect('C'))).valid,false);
  assert.equal(calls,4);
});

test('already-aborted requests do not return a cached preview or send a new request',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;return Response.json(preview('C'));};
  await chemistryRequest(inspect('C'));
  const controller=new AbortController();controller.abort();
  await assert.rejects(chemistryRequest(inspect('C'),{signal:controller.signal}),{name:'AbortError'});
  await assert.rejects(chemistryRequest(inspect('CC'),{signal:controller.signal}),{name:'AbortError'});
  assert.equal(calls,1);
});

test('a cancelled in-flight result cannot populate the preview cache',async()=>{
  let release,calls=0;
  globalThis.fetch=async()=>{calls++;return new Promise(resolve=>{release=resolve;});};
  const controller=new AbortController();
  const pending=chemistryRequest(inspect('C'),{signal:controller.signal});
  controller.abort();release(Response.json(preview('C')));
  await assert.rejects(pending,{name:'AbortError'});
  globalThis.fetch=async()=>{calls++;return Response.json(preview('C'));};
  await chemistryRequest(inspect('C'));assert.equal(calls,2);
});

test('invalid JSON response shapes produce a service error rather than a TypeError',async()=>{
  for(const body of [null,42,[], 'upstream unavailable']) {
    globalThis.fetch=async()=>Response.json(body);
    await assert.rejects(chemistryRequest({action:'generate',smiles:'C'},{hosted:true}),/雲端服務正在啟動或暫時無法回應/);
  }
});

test('HTML authentication and rate-limit responses retain their actionable status',async()=>{
  for(const [status,message] of [[401,/登入已逾時/],[429,/計算服務忙碌中/]]) {
    globalThis.fetch=async()=>new Response('<html>upstream error</html>',{status});
    await assert.rejects(chemistryRequest(inspect('C'),{hosted:true}),message);
  }
});

test('cancelling while reading the response body remains an AbortError',async()=>{
  const controller=new AbortController();
  let rejectBody;
  globalThis.fetch=async()=>({ok:true,status:200,json:()=>new Promise((resolve,reject)=>{rejectBody=reject;})});
  const pending=chemistryRequest(inspect('C'),{signal:controller.signal});
  await new Promise(resolve=>setImmediate(resolve));
  controller.abort();rejectBody(new DOMException('The operation was aborted','AbortError'));
  await assert.rejects(pending,{name:'AbortError'});
});
