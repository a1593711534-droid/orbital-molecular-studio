/* Isolated Edge regression checks for v1.1.1 lone-pair/orbital presentation. */
const {chromium,expect}=require('@playwright/test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const URL=process.env.ORBITAL_TEST_URL||'http://127.0.0.1:8766';
const folder=process.env.ORBITAL_SCREENSHOT_DIR||path.resolve(__dirname,'../../carboxyl-preview');
const results=[],errors=[];
async function main(){
  fs.mkdirSync(folder,{recursive:true});
  const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  const page=await context.newPage();page.setDefaultTimeout(18000);
  page.on('pageerror',e=>errors.push(e.message));
  const button=name=>page.getByRole('button',{name,exact:true});
  async function shot(name){await expect(page.locator('.toast.success')).toHaveCount(0,{timeout:7000});await page.waitForTimeout(250);await page.screenshot({path:path.join(folder,name),fullPage:true});}
  async function step(name,fn){try{const detail=await fn();results.push({name,pass:true,detail});console.log('PASS '+name);}catch(e){results.push({name,pass:false,error:e.message});await shot('failure.png');throw e;}}
  async function closePanel(){if(await button('關閉工具面板').count())await button('關閉工具面板').click();}
  async function generate(smiles){
    await button('輸入結構').click();await page.getByLabel('SMILES 分子輸入',{exact:true}).fill(smiles);
    await expect(page.locator('.structure-input')).toHaveAttribute('data-preview-state','valid');
    const response=page.waitForResponse(r=>r.url().endsWith('/api/molecule')&&r.request().method()==='POST'&&r.request().postDataJSON().action==='generate');
    await button('生成三維結構').click();const result=await response,data=await result.json();assert(result.ok()&&!data.error);
    await expect(page.locator('.computing')).toHaveCount(0);await expect(page.getByRole('dialog')).toHaveCount(0);
    return data;
  }
  async function layer(name,checked){
    if(!(await page.getByLabel(name,{exact:true}).count()))await button('顯示設定').click();
    await page.getByLabel(name,{exact:true}).setChecked(checked);await closePanel();
  }
  async function counts(pairs,orbitals){await expect(page.locator('.molecule-scene canvas')).toHaveAttribute('aria-description',new RegExp(`孤電子對顯示 ${pairs} 對；p 軌域顯示 ${orbitals} 個`));}
  async function selectAtom(id){
    await button('選取').click();await button('依編號選取').click();
    await page.getByLabel('依編號選取原子',{exact:true}).selectOption(String(id));
    await button('關閉編號選取').click();
  }
  function hydroxyl(data){return data.atoms.find(a=>a.element==='O'&&data.bonds.some(b=>{
    const other=b.a===a.id?b.b:b.b===a.id?b.a:null;
    return other!==null&&data.atoms.find(n=>n.id===other)?.element==='H';
  }));}
  const angle=(data,a,b,c)=>{
    const p=id=>data.atoms.find(x=>x.id===id).position;
    const u=p(a).map((v,i)=>v-p(b)[i]),v=p(c).map((x,i)=>x-p(b)[i]);
    return Math.acos(u.reduce((s,x,i)=>s+x*v[i],0)/Math.hypot(...u)/Math.hypot(...v))*180/Math.PI;
  };
  try{
    await page.goto(URL,{waitUntil:'domcontentloaded'});
    await step('formic-acid OH remains two lone pairs, with one localized and one conjugated contribution',async()=>{
      const data=await generate('C(=O)O'),oh=hydroxyl(data);assert(oh);assert.equal(data.formula,'CH2O2');
      assert.equal(oh.lonePairs.length,2);assert.equal(oh.lonePairs.filter(p=>p.kind==='localized').length,1);assert.equal(oh.lonePairs.filter(p=>p.kind==='delocalized').length,1);
      const ns=data.bonds.filter(b=>b.a===oh.id||b.b===oh.id).map(b=>b.a===oh.id?b.b:b.a);
      const degrees=angle(data,ns[0],oh.id,ns[1]);assert(degrees>100&&degrees<110,'OH angle was forced to 120 degrees');
      await selectAtom(oh.id);await expect(page.locator('.inspector')).toContainText(/孤電子對\s*2 對/);
      await expect(page.locator('.lone-pair-breakdown')).toContainText(/局域\s*1/);
      await expect(page.locator('.lone-pair-breakdown')).toContainText(/共軛\s*1/);
      await closePanel();await counts(4,0);await expect(page.getByLabel('電子對圖例')).toContainText('每組兩點＝1 對');await shot('formic-default.png');
      return {oxygenId:oh.id,pairs:oh.lonePairs.map(p=>p.kind),COHangle:degrees};
    });
    await step('pi and lone-pair layers work independently without changing stored molecular geometry',async()=>{
      const before=await page.evaluate(()=>localStorage.getItem('orbital-v1-session'));
      await layer('π 軌域示意',true);await counts(4,3);await expect(page.getByLabel('電子對圖例')).toContainText('雙葉＝1 個 p 軌域');await shot('formic-orbitals.png');
      await layer('孤電子對',false);await counts(0,3);await shot('formic-pi-only.png');
      await layer('π 軌域示意',false);await counts(0,0);await shot('formic-atoms-only.png');
      await layer('孤電子對',true);await counts(4,0);await shot('formic-pairs-only.png');
      assert.equal(await page.evaluate(()=>localStorage.getItem('orbital-v1-session')),before);
    });
    await step('acetic-acid OH has the same two-pair explanation and retains computed geometry',async()=>{
      const data=await generate('CC(=O)O'),oh=hydroxyl(data);assert(oh);assert.equal(data.formula,'C2H4O2');
      assert.equal(oh.lonePairs.length,2);assert.equal(oh.lonePairs.filter(p=>p.kind==='delocalized').length,1);
      await selectAtom(oh.id);await expect(page.locator('.lone-pair-breakdown')).toContainText(/共軛\s*1/);
      await shot('acetic-oh-inspector.png');await closePanel();
    });
    await step('water and ethanol retain two localized lone pairs without a false conjugated-pair explanation',async()=>{
      for(const [smiles,name] of [['O','water'],['CCO','ethanol']]){
        const data=await generate(smiles),oxygen=data.atoms.find(a=>a.element==='O');
        assert.equal(oxygen.lonePairs.length,2);assert(oxygen.lonePairs.every(p=>p.kind==='localized'));
        await selectAtom(oxygen.id);await expect(page.locator('.inspector')).toContainText(/孤電子對\s*2 對/);
        await expect(page.locator('.lone-pair-breakdown')).toHaveCount(0);await closePanel();
        await layer('π 軌域示意',true);await counts(2,0);await shot(name+'.png');await layer('π 軌域示意',false);
      }
    });
    await step('carboxyl explanation and orbitals remain usable at mobile large text',async()=>{
      const data=await generate('C(=O)O');await layer('π 軌域示意',true);
      await button('顯示設定').click();await page.getByLabel('介面字級',{exact:true}).selectOption('1.25');await closePanel();
      await page.setViewportSize({width:390,height:844});await selectAtom(hydroxyl(data).id);
      await expect(page.locator('.lone-pair-breakdown')).toBeVisible();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await shot('formic-mobile.png');
    });
    await step('no uncaught browser runtime errors',async()=>assert.deepEqual(errors,[]));
  }finally{
    fs.writeFileSync(path.join(folder,'carboxyl-report.json'),JSON.stringify({total:results.length,passed:results.filter(r=>r.pass).length,results,errors},null,2));
    await browser.close();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
