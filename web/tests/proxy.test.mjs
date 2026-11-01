import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';

let source=await readFile(new URL('../lib/chemistry-proxy.ts',import.meta.url),'utf8');
source=source.replace("import {getChatGPTUser} from '../app/chatgpt-auth';",'const getChatGPTUser=async()=>globalThis.__testUser;');
const {proxyChemistry}=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(source)).toString('base64'));
const oldFetch=globalThis.fetch;
const base='https://studio.example';
function request(body={action:'generate',smiles:'C[N+](=O)[O-]'},headers={}){return new Request(base+'/api/molecule',{method:'POST',headers:{'Content-Type':'application/json',Origin:base,...headers},body:typeof body==='string'?body:JSON.stringify(body)});}
test.beforeEach(()=>{globalThis.__testUser={userId:'owner'};process.env.CHEMISTRY_API_URL='https://chemistry.example';process.env.CHEMISTRY_API_TOKEN='test-only-secret';globalThis.fetch=async()=>{throw new Error('Unexpected request');};});
test.after(()=>{globalThis.fetch=oldFetch;delete globalThis.__testUser;delete process.env.CHEMISTRY_API_URL;delete process.env.CHEMISTRY_API_TOKEN;});
test('anonymous computation is rejected before contacting backend',async()=>{globalThis.__testUser=null;assert.equal((await proxyChemistry(request(),'/api/molecule')).status,401);});
test('cross-origin and cross-site requests cannot use server credential',async()=>{assert.equal((await proxyChemistry(request({}, {Origin:'https://other.example'}),'/api/molecule')).status,403);assert.equal((await proxyChemistry(request({}, {'Sec-Fetch-Site':'cross-site'}),'/api/molecule')).status,403);});
test('invalid JSON and actual oversized body are rejected',async()=>{assert.equal((await proxyChemistry(request('{'),'/api/molecule')).status,400);assert.equal((await proxyChemistry(request('x'.repeat(2_000_001)),'/api/molecule')).status,413);});
test('valid authenticated computation forwards exact body and only server auth',async()=>{const payload={action:'generate',smiles:'C[N+](=O)[O-]'};globalThis.fetch=async(url,options)=>{assert.equal(String(url),'https://chemistry.example/api/molecule');assert.equal(options.headers.Authorization,'Bearer test-only-secret');assert.deepEqual(JSON.parse(options.body),payload);assert.equal(options.redirect,'error');return Response.json({displayFormula:'CH3NO2'});};const response=await proxyChemistry(request(payload),'/api/molecule');assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{displayFormula:'CH3NO2'});});
test('upstream auth failures and HTML cold-start pages are safely explained',async()=>{globalThis.fetch=async()=>Response.json({error:'private detail'},{status:401});const auth=await proxyChemistry(request(),'/api/molecule');assert.equal(auth.status,503);assert.equal((await auth.text()).includes('private detail'),false);globalThis.fetch=async()=>new Response('<html>boot</html>',{headers:{'Content-Type':'text/html'}});assert.equal((await proxyChemistry(request(),'/api/molecule')).status,503);});
test('busy responses preserve status and do not replay computation',async()=>{let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({error:'忙碌中'},{status:429});};assert.equal((await proxyChemistry(request(),'/api/molecule')).status,429);assert.equal(calls,1);});
