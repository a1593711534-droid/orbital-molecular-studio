import test from 'node:test';
import assert from 'node:assert/strict';

const originalFetch=globalThis.fetch;
let chemistryRequest,moduleId=0;
const inspect=smiles=>({action:'inspect',smiles});
const preview=smiles=>({valid:true,canonicalSmiles:smiles,svg:'<svg/>',atoms:[{element:'N'}]});
test.beforeEach(async()=>{({chemistryRequest}=await import('../src/chemistryClient.js?test='+(++moduleId)));});
test.afterEach(()=>{globalThis.fetch=originalFetch;});

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
