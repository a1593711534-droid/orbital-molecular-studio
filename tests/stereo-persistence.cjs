const {chromium,expect}=require('@playwright/test');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1440,height:980}});
 const url=process.env.ORBITAL_TEST_URL||'http://127.0.0.1:8765';
 const response=()=>page.waitForResponse(r=>r.url().endsWith('/api/molecule')&&r.request().method()==='POST');
 async function action(fn){const wait=response();await fn();const r=await wait;const m=await r.json();assert(r.ok(),m.error);await expect(page.locator('.computing')).toHaveCount(0);return m;}
 await action(()=>page.goto(url));
 for(const smiles of ['CC(O)F','FC=CF']){
  await page.getByTitle('結構建構',{exact:true}).click();
  await page.getByLabel('SMILES 分子輸入').fill(smiles);
  let m=await action(()=>page.getByRole('button',{name:'生成三維結構'}).click());
  const canonical=m.smiles;
  assert(m.warnings.some(w=>w.includes('未指定')));
  m=await action(()=>page.reload());assert.equal(m.smiles,canonical);assert(m.warnings.some(w=>w.includes('未指定')));
  await page.getByTitle('計算設定',{exact:true}).click();
  m=await action(()=>page.getByRole('button',{name:'最佳化目前構象'}).click());assert.equal(m.smiles,canonical);assert(m.warnings.some(w=>w.includes('未指定')));
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('orbital-v1-session')));
  assert(saved.graph?.atoms.length);
  m=await action(()=>page.locator('input[type=file]').setInputFiles({name:'stereo-project.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...saved,format:'orbital-project'}))}));
  assert.equal(m.smiles,canonical);assert(m.warnings.some(w=>w.includes('未指定')));
  console.log('PASS unspecified stereo preserved through reload, optimize, JSON import:',canonical);
 }
 await page.getByTitle('結構建構',{exact:true}).click();await page.getByLabel('SMILES 分子輸入').fill('O=C=O');
 const co2=await action(()=>page.getByRole('button',{name:'生成三維結構'}).click());assert.equal(co2.energy,null);assert(co2.method.includes('NIST'));assert(co2.bonds.every(b=>Math.abs(b.length-1.1621)<.00001));console.log('PASS CO2 reference geometry and unavailable energy displayed');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
