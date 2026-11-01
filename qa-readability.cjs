const {chromium}=require('@playwright/test');
const fs=require('node:fs');
(async()=>{
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.env.ORBITAL_TEST_URL || 'http://127.0.0.1:8765');
 await page.waitForFunction(()=>document.querySelector('.formula-display')?.textContent.includes('C3'));
 await page.waitForTimeout(700);
 const report=[];
 for(const [width,height] of [[1440,900],[1366,768],[1024,900],[390,844]]){
  await page.setViewportSize({width,height});await page.waitForTimeout(250);
  report.push(await page.evaluate(()=>({width:innerWidth,horizontalOverflow:document.documentElement.scrollWidth>innerWidth,canvas:document.querySelector('canvas').getBoundingClientRect().toJSON(),fonts:Object.fromEntries(['.section-heading h2','.primary-button','.property-row','.property-row b','.micro-copy','.switch-copy','.scientific-note p','textarea','.tool-row','.left-foot'].map(s=>{const e=document.querySelector(s),c=getComputedStyle(e);return [s,{font:c.fontSize,color:c.color}]}))})));
  await page.screenshot({path:`../readability-${width}.png`,fullPage:true});
 }
 await page.setViewportSize({width:1440,height:900});
 await page.getByRole('button',{name:'文字大小與顯示設定'}).click();
 await page.getByLabel('介面字級').selectOption('1.25');await page.waitForTimeout(200);
 await page.screenshot({path:'../readability-large.png',fullPage:true});
 report.push(await page.evaluate(()=>({scale:document.querySelector('.app-shell').dataset.uiScale,primaryFont:getComputedStyle(document.querySelector('.switch-copy')).fontSize,horizontalOverflow:document.documentElement.scrollWidth>innerWidth})));
 await page.reload();await page.waitForFunction(()=>document.querySelector('.formula-display')?.textContent.includes('C3'));
 report.push(await page.evaluate(()=>({scaleAfterReload:document.querySelector('.app-shell').dataset.uiScale})));
 await page.getByRole('button',{name:'文字大小與顯示設定'}).click();await page.getByLabel('介面字級').selectOption('1');
 await page.getByTitle('結構建構',{exact:true}).click();
 await page.getByLabel('原子標籤',{exact:true}).check();await page.waitForTimeout(300);
 await page.screenshot({path:'../readability-labels.png',fullPage:true});
 await page.getByRole('button',{name:'方法與使用說明',exact:true}).click();await page.screenshot({path:'../readability-help.png',fullPage:true});
 console.log(JSON.stringify({report,errors},null,2));
 fs.writeFileSync('../readability-report.json',JSON.stringify({report,errors},null,2));
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
