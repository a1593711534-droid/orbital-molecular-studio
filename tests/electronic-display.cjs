/* v1.2 electronic display and iPad-size touch integration checks. Real Edge
 * with touch emulation; this does not claim a physical iPad/Safari test. */
const {chromium,expect}=require('@playwright/test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const URL=process.env.ORBITAL_TEST_URL||'http://127.0.0.1:8766';
const folder=process.env.ORBITAL_SCREENSHOT_DIR||path.resolve(__dirname,'../../electronic-preview');
const results=[],errors=[];
async function main(){
 fs.mkdirSync(folder,{recursive:true});
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 let context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
 const setup=()=>{page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));};setup();
 const button=name=>page.getByRole('button',{name,exact:true});
 const canvas=()=>page.locator('.molecule-scene canvas');
 const stored=()=>page.evaluate(()=>localStorage.getItem('orbital-v1-session'));
 async function shot(name){await expect(page.locator('.toast.success')).toHaveCount(0,{timeout:7000});await page.waitForTimeout(200);await page.screenshot({path:path.join(folder,name),fullPage:true});}
 async function step(name,fn){try{const detail=await fn();results.push({name,pass:true,detail});console.log('PASS '+name);}catch(e){results.push({name,pass:false,error:e.message});await shot('electronic-failure.png');throw e;}}
 async function closePanel(){if(await button('關閉工具面板').count())await button('關閉工具面板').click();}
 async function generate(smiles){
  await button('輸入結構').click();await page.getByLabel('SMILES 分子輸入',{exact:true}).fill(smiles);
  await expect(page.locator('.structure-input')).toHaveAttribute('data-preview-state','valid');
  const waiting=page.waitForResponse(r=>r.url().endsWith('/api/molecule')&&r.request().postDataJSON()?.action==='generate');
  await button('生成三維結構').click();const response=await waiting,data=await response.json();assert(response.ok()&&!data.error,data.error);
  await expect(page.locator('.computing')).toHaveCount(0);await expect(page.getByRole('dialog')).toHaveCount(0);return data;
 }
 async function layer(name,checked){await button('顯示設定').click();await page.getByLabel(name,{exact:true}).setChecked(checked);await closePanel();}
 async function counts(pairs,p){await expect(canvas()).toHaveAttribute('data-lone-pair-count',String(pairs));await expect(canvas()).toHaveAttribute('data-p-orbital-count',String(p));}
 async function atomPoint(symbol){
  const box=await canvas().boundingBox();
  for(let y=.4;y<=.6;y+=.025)for(let x=.4;x<=.6;x+=.025){
   const p={x:box.x+box.width*x,y:box.y+box.height*y};await page.mouse.move(p.x,p.y);
   if((await page.locator('.scene-hover-hint').textContent())?.startsWith(symbol)&&await page.locator('.scene-hover-hint').isVisible())return p;
  }
  throw new Error('Unable to pick central '+symbol);
 }
 try{
  await page.goto(URL,{waitUntil:'domcontentloaded'});
  await step('NH4+ displays conventional order and superscript charge; actual canvas click still selects nitrogen',async()=>{
   await generate('[NH4+]');await expect(page.locator('.formula-display')).toHaveText('NH4+');
   await expect(page.locator('.formula-display sub')).toHaveText('4');await expect(page.locator('.formula-display .formula-charge')).toHaveText('+');
   await button('選取').click();const p=await atomPoint('N');await page.mouse.click(p.x,p.y);
   await expect(page.locator('.atom-heading')).toContainText('氮');await closePanel();await shot('ammonium.png');
  });
  await step('ozone switches between symmetric hybrid and complete Lewis counts without modifying stored molecule',async()=>{
   const data=await generate('[O-][O+]=O');assert.equal(data.resonance.equivalentBondGroups.length,1);assert.equal(data.resonance.groups[0].piElectrons,4);
   await button('離域示意').click();await counts(5,0);await expect(page.getByLabel('電子對圖例')).toContainText('π 系統 · 4 e⁻');await shot('ozone-hybrid.png');
   const original=await stored();await button('Lewis 式').click();await counts(6,0);await shot('ozone-lewis.png');
   await layer('π 軌域示意',true);await counts(6,3);
   await button('離域示意').click();await counts(5,3);await shot('ozone-orbitals.png');
   assert.equal(await stored(),original);await layer('π 軌域示意',false);
   return {equivalentBonds:data.resonance.equivalentBondGroups,geometrySource:data.geometrySource};
  });
  await step('carboxylic acid, nitromethane and water retain correct independent electron layers',async()=>{
   const data=await generate('C(=O)O');assert.deepEqual(data.resonance.equivalentBondGroups,[]);await counts(3,0);await shot('formic-hybrid.png');
   await button('Lewis 式').click();await counts(4,0);await layer('π 軌域示意',true);await counts(4,3);await shot('formic-lewis-orbitals.png');
   await layer('孤電子對',false);await counts(0,3);await layer('孤電子對',true);await layer('π 軌域示意',false);
   await generate('C[N+](=O)[O-]');await button('離域示意').click();await counts(4,0);await shot('nitromethane-hybrid.png');
   await button('Lewis 式').click();await counts(5,0);await shot('nitromethane-lewis.png');
   await generate('O');await counts(2,0);await expect(page.getByRole('group',{name:'電子結構表示法'})).toHaveCount(0);await shot('water.png');
  });
  await context.close();context=await browser.newContext({viewport:{width:1024,height:1366},hasTouch:true,isMobile:true,deviceScaleFactor:2});page=await context.newPage();setup();await page.goto(URL,{waitUntil:'domcontentloaded'});
  await step('iPad portrait and landscape keep large text controls visible and touch hints present',async()=>{
   await generate('[O-][O+]=O');await layer('π 軌域示意',true);await button('顯示設定').click();await page.getByLabel('介面字級',{exact:true}).selectOption('1.25');await closePanel();
   for(const [width,height] of [[1024,1366],[1366,1024]]){
    await page.setViewportSize({width,height});await expect(page.locator('.touch-hint')).toBeVisible();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    for(const name of ['離域示意','Lewis 式','顯示設定','輸入結構']){
     const box=await button(name).boundingBox();assert(box.x>=0&&box.y>=0&&box.x+box.width<=width&&box.y+box.height<=height,name+' out of bounds');assert(box.height>=44,name+' touch target too small');
    }
    await button('Lewis 式').tap();await counts(6,3);await button('離域示意').tap();await counts(5,3);
    const legend=await page.getByLabel('電子對圖例').boundingBox(),nudge=await page.locator('.mode-nudge').boundingBox();
    assert(legend.y+legend.height<=nudge.y||nudge.y+nudge.height<=legend.y||legend.x+legend.width<=nudge.x||nudge.x+nudge.width<=legend.x,'legend overlaps selection hint');
    await shot(`ipad-${width}.png`);
   }
  });
  await step('real touch tap adds an atom, pinch and drag-return never add accidental atoms',async()=>{
   await generate('C');await layer('π 軌域示意',false);await button('接原子').click();
   const box=await canvas().boundingBox(),p={x:box.x+box.width/2,y:box.y+box.height/2};
   const waiting=page.waitForResponse(r=>r.url().endsWith('/api/molecule')&&r.request().postDataJSON()?.action==='generate');
   await page.touchscreen.tap(p.x,p.y);const response=await waiting,data=await response.json();assert(response.ok(),JSON.stringify(data));assert.equal(data.formula,'C2H6');await expect(page.locator('.computing')).toHaveCount(0);
   await generate('C');await button('接原子').click();const before=await stored();let edits=0;page.on('request',r=>{if(r.url().endsWith('/api/molecule')&&r.postDataJSON()?.action==='generate')edits++;});
   const cdp=await context.newCDPSession(page),touch=(id,x,y)=>({id,x,y});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch(1,p.x-20,p.y),touch(2,p.x+20,p.y)]});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[touch(1,p.x-45,p.y),touch(2,p.x+45,p.y)]});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[touch(2,p.x+45,p.y)]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[touch(3,p.x,p.y)]});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[touch(3,p.x+45,p.y)]});
   await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[touch(3,p.x,p.y)]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
   await page.waitForTimeout(500);assert.equal(edits,0);assert.equal(await stored(),before);await cdp.detach();
  });
  await step('no uncaught browser errors',async()=>assert.deepEqual(errors,[]));
 }finally{fs.writeFileSync(path.join(folder,'electronic-report.json'),JSON.stringify({total:results.length,passed:results.filter(r=>r.pass).length,results,errors},null,2));await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
