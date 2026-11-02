import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {Miniflare} from 'miniflare';

// Exercise the real Workers runtime, not Node's Fetch implementation. The
// upstream is intercepted only after workerd has constructed the HTTP request.
let proxy=await readFile(new URL('../lib/chemistry-proxy.ts',import.meta.url),'utf8');
proxy=proxy.replace("import {getChatGPTUser} from '../app/chatgpt-auth';",'const getChatGPTUser=async()=>({userId:"test-owner"});');
proxy=proxy.replaceAll('process.env.', 'testEnv.');
proxy=stripTypeScriptTypes(proxy);
const upstreamReplies=[];
const upstreamCalls=[];
let unexpectedRedirects=0;
const mf=new Miniflare({
  modules:true, compatibilityDate:'2026-05-15',
  // Intercept every outbound service call, without a second Node fetch layer
  // that could follow redirects independently of the tested Workers fetch.
  outboundService:async request=>{
    if(new URL(request.url).origin!=='https://chemistry.example') {
      unexpectedRedirects++;
      return Response.json({error:'redirect target contacted'});
    }
    upstreamCalls.push({url:request.url,method:request.method,headers:Object.fromEntries(request.headers),body:await request.text()});
    const reply=upstreamReplies.shift();
    if(!reply)return Response.json({error:'unexpected upstream request'},{status:599});
    if(reply.raw!==undefined)return new Response(reply.raw,{status:reply.status,headers:reply.headers});
    return Response.json(reply.body,{status:reply.status,headers:reply.headers});
  },
  bindings:{CHEMISTRY_API_URL:'https://chemistry.example',CHEMISTRY_API_TOKEN:'test-only-never-a-real-token'},
  script:`let testEnv;\n${proxy}\nexport default {async fetch(request,env) {
    testEnv=env;
    if(new URL(request.url).pathname==='/legacy-redirect') {
      try {await fetch('https://chemistry.example/legacy',{redirect:'error'});return Response.json({unexpected:true});}
      catch(error){return Response.json({name:error.name,message:error.message});}
    }
    return proxyChemistry(request,new URL(request.url).pathname==='/api/health'?'/api/health':'/api/molecule');
  }};`,
});
test.after(async()=>{await mf.dispose();});
const requestOptions=body=>({method:'POST',headers:{Origin:'https://studio.example','Content-Type':'application/json'},body:JSON.stringify(body)});
const jsonHeaders={'Content-Type':'application/json'};
const ready={status:200,body:{status:'ready',app:'orbital-chemistry',version:'1.2.0'},headers:jsonHeaders};
test.beforeEach(()=>{upstreamReplies.length=0;upstreamCalls.length=0;unexpectedRedirects=0;});

test('workerd reproduces the original unsupported redirect:error before contacting the upstream',async()=>{
  const response=await mf.dispatchFetch('https://studio.example/legacy-redirect');
  const result=await response.json();
  assert.equal(result.name,'TypeError');
  assert.match(result.message,/redirect/i);
  assert.match(result.message,/follow|manual/i);
  assert.equal(upstreamCalls.length,0);
});

test('authenticated molecular POST succeeds through real workerd fetch with the exact body and server credential',async()=>{
  const payload={action:'generate',smiles:'C[N+](=O)[O-]'};
  upstreamReplies.push(ready,{status:200,body:{displayFormula:'CH3NO2',atoms:[{element:'C'}]},headers:jsonHeaders});
  const response=await mf.dispatchFetch('https://studio.example/api/molecule',requestOptions(payload));
  assert.equal(response.status,200);
  assert.deepEqual(upstreamCalls.map(call=>call.method),['GET','POST']);
  assert.equal(upstreamCalls[0].url,'https://chemistry.example/api/health');
  const received=upstreamCalls.at(-1);
  assert.equal(received.url,'https://chemistry.example/api/molecule');
  assert.equal(received.method,'POST');
  assert.deepEqual(JSON.parse(received.body),payload);
  assert.equal(received.headers.authorization,'Bearer test-only-never-a-real-token');
  assert.equal(received.headers['content-type'],'application/json');
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(await response.json(),{displayFormula:'CH3NO2',atoms:[{element:'C'}]});
});

test('health proxy succeeds through real workerd fetch',async()=>{
  upstreamReplies.push(ready);
  const response=await mf.dispatchFetch('https://studio.example/api/health');
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),ready.body);
  const received=upstreamCalls.at(-1);
  assert.equal(received.url,'https://chemistry.example/api/health');
  assert.equal(received.method,'GET');
  assert.equal(received.headers.authorization,'Bearer test-only-never-a-real-token');
});

test('all upstream redirect codes are rejected without following or forwarding the credential',async()=>{
  for(const phase of ['warmup','compute'])for(const status of [301,302,303,307,308]) {
    const callsBefore=upstreamCalls.length;
    if(phase==='compute')upstreamReplies.push(ready);
    upstreamReplies.push({status,body:{privateDetail:'must not leak'},headers:{...jsonHeaders,Location:'https://untrusted.example/collect'}});
    const response=await mf.dispatchFetch('https://studio.example/api/molecule',requestOptions({action:'generate',smiles:'C'}));
    assert.equal(response.status,503,`redirect ${status} must not be returned as a successful response`);
    assert.equal(response.headers.get('location'),null);
    const body=await response.text();
    assert.equal(body.includes('must not leak'),false);
    assert.equal(body.includes('test-only-never-a-real-token'),false);
    assert.equal(unexpectedRedirects,0,`redirect ${status} contacted the untrusted destination`);
    assert.equal(upstreamCalls.length,callsBefore+(phase==='compute'?2:1),`redirect ${status} replayed the calculation`);
  }
  assert.deepEqual(upstreamReplies,[]);
});

test('real workerd waits through an HTML cold start then sends exactly one molecular POST',async()=>{
  upstreamReplies.push({status:503,raw:'<html>Starting service</html>',headers:{'Content-Type':'text/html'}},ready,{status:200,body:{displayFormula:'CH4'},headers:jsonHeaders});
  const response=await mf.dispatchFetch('https://studio.example/api/molecule',requestOptions({action:'generate',smiles:'C'}));
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{displayFormula:'CH4'});
  assert.deepEqual(upstreamCalls.map(call=>call.method),['GET','GET','POST']);
  assert.deepEqual(upstreamReplies,[]);
});
