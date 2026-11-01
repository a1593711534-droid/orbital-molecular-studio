/* Final v1.1.0 regression and responsive checks, using an isolated Edge profile. */
const {chromium,expect}=require('@playwright/test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const URL=process.env.ORBITAL_TEST_URL||'http://127.0.0.1:8765';
const folder=process.env.ORBITAL_SCREENSHOT_DIR||path.resolve(__dirname,'../../studio-preview');
const results=[],errors=[];
async function main(){
  fs.mkdirSync(folder,{recursive:true});
  const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage();page.setDefaultTimeout(15000);
  page.on('pageerror',e=>errors.push(e.message));
  const button=name=>page.getByRole('button',{name,exact:true});
  const saved=()=>page.evaluate(()=>localStorage.getItem('orbital-v1-session'));
  async function shot(name){await page.waitForTimeout(150);await page.screenshot({path:path.join(folder,name),fullPage:true});}
  async function step(name,fn){try{const detail=await fn();results.push({name,pass:true,detail});console.log('PASS '+name);}catch(e){results.push({name,pass:false,error:e.message});await shot('studio-focused-failure.png');throw e;}}
  async function modelReady(){await expect(page.locator('.model-caption')).toBeVisible();await expect(page.locator('.computing')).toHaveCount(0);}
  async function visibleInside(locator){return locator.evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right,inside:r.y>=0&&r.bottom<=innerHeight&&r.x>=0&&r.right<=innerWidth};});}
  async function panelVisible(){await expect.poll(async()=>page.locator('.panel-header').evaluate(el=>{const r=el.getBoundingClientRect();return r.y>=60&&r.bottom<=innerHeight;})).toBe(true);}
  async function closePanel(){if(await button('關閉工具面板').count())await button('關閉工具面板').click();}
  try{
    await page.goto(URL,{waitUntil:'domcontentloaded'});
    await step('failed restoration preserves unnamed project; explicit new clears it even when state values are unchanged',async()=>{
      await button('放下第一個原子').click();await modelReady();
      const original=await saved();assert(original);assert.equal(JSON.parse(original).name,'未命名結構');
      await page.route('**/api/molecule',route=>route.abort('failed'));
      await page.reload({waitUntil:'domcontentloaded'});await expect(page.getByRole('alert')).toBeVisible();
      assert.equal(await saved(),original,'failed restore removed stored work');
      await button('新建').click();await expect.poll(saved).toBe(null);
      await page.unroute('**/api/molecule');await page.reload({waitUntil:'domcontentloaded'});
      await expect(button('放下第一個原子')).toBeEnabled();assert.equal(await saved(),null);
    });
    await step('mobile tool panels scroll into view and editable project name survives reload',async()=>{
      await button('放下第一個原子').click();await modelReady();
      await page.setViewportSize({width:390,height:844});
      await button('顯示設定').click();await panelVisible();
      await page.getByLabel('介面字級',{exact:true}).selectOption('1.25');await closePanel();
      await button('分子資訊').click();await panelVisible();
      await page.getByLabel('資訊面板專案名稱',{exact:true}).fill('手機命名驗證');
      await expect.poll(async()=>JSON.parse(await saved()).name).toBe('手機命名驗證');
      await page.reload({waitUntil:'domcontentloaded'});await modelReady();
      await button('分子資訊').click();await panelVisible();
      await expect(page.getByLabel('資訊面板專案名稱',{exact:true})).toHaveValue('手機命名驗證');
      await expect(page.locator('[data-ui-scale]')).toHaveAttribute('data-ui-scale','1.25');
      await shot('studio-focused-mobile.png');await closePanel();
    });
    await step('mobile live 2D preview and Generate stay visible while editing and scrolling at 20 px',async()=>{
      await button('輸入結構').click();
      const input=page.getByLabel('SMILES 分子輸入',{exact:true});
      await input.fill('CC(O)C');
      await expect(page.locator('.structure-input')).toHaveAttribute('data-preview-state','valid');
      const svg=await visibleInside(page.locator('.si-svg svg'));
      const generate=await visibleInside(button('生成三維結構'));
      assert(svg.inside&&svg.height>=70,`preview outside viewport or too small: ${JSON.stringify(svg)}`);
      assert(generate.inside,`Generate outside viewport: ${JSON.stringify(generate)}`);
      const footer=await page.locator('.si-footer').boundingBox();assert(svg.bottom<=footer.y,'footer overlaps diagram');
      const before=await page.locator('.si-preview').boundingBox();
      await page.locator('.si-editor').evaluate(el=>{el.scrollTop=el.scrollHeight;});
      const after=await page.locator('.si-preview').boundingBox();assert(Math.abs(before.y-after.y)<1,'preview scrolls away with editor');
      await button('清除輸入').click();await button('插入碳元素').click();await button('插入氧元素').click();
      await expect(input).toHaveValue('CO');await expect(page.locator('.structure-input')).toHaveAttribute('data-preview-state','valid');
      await expect(page.locator('.si-preview-status')).toContainText('CH4O');
      assert((await visibleInside(page.locator('.si-svg svg'))).inside);
      await shot('studio-input-mobile.png');
      await button('生成三維結構').click();await modelReady();await expect(page.locator('.model-caption')).toContainText('CH4O');
      return {svg,generate};
    });
    await step('320, 390 and 1440 px layouts keep 16 and 20 px primary controls unobstructed',async()=>{
      const measurements=[];
      for(const width of [320,390,1440])for(const scale of [1,1.25]){
        await page.setViewportSize({width,height:width===1440?1000:844});
        await button('顯示設定').click();await page.getByLabel('介面字級',{exact:true}).selectOption(String(scale));await closePanel();
        await page.evaluate(()=>scrollTo(0,0));
        const metrics=await page.evaluate(()=>{
          const modes=[...document.querySelectorAll('.mode-switch button')].map(el=>{const r=el.getBoundingClientRect();return {font:parseFloat(getComputedStyle(el).fontSize),x:r.x,right:r.right,top:r.top,bottom:r.bottom,width:r.width,scroll:el.scrollWidth,client:el.clientWidth};});
          const undo=document.querySelector('[aria-label="復原"]'),r=undo.getBoundingClientRect();
          const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
          return {overflow:document.documentElement.scrollWidth>innerWidth,modes,undoVisible:!!hit&&(hit===undo||undo.contains(hit)),undoX:r.x};
        });
        assert(!metrics.overflow,`horizontal overflow ${width}/${scale}`);
        assert(metrics.undoVisible,`Undo obstructed ${width}/${scale}`);
        for(const m of metrics.modes){assert(m.font>=16*scale-.1,`small mode font ${width}/${scale}: ${m.font}`);assert(m.right<=metrics.undoX+1,'modes overlap Undo');assert(m.scroll<=m.client+1,`mode text overflow ${width}/${scale}`);}
        measurements.push({width,scale,...metrics});
      }
      return measurements;
    });
    await step('no uncaught browser runtime errors',async()=>assert.deepEqual(errors,[]));
  }finally{
    fs.writeFileSync(path.join(folder,'studio-focused-report.json'),JSON.stringify({total:results.length,passed:results.filter(x=>x.pass).length,results,errors},null,2));
    await browser.close();
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
