const {chromium}=require('@playwright/test');
const fs=require('fs');
(async()=>{
 const browser=await chromium.launch({executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true,args:['--enable-webgl','--ignore-gpu-blocklist','--use-angle=swiftshader']});
 const page=await browser.newPage({viewport:{width:1500,height:1000},deviceScaleFactor:1});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('422 (Unprocessable Entity)'))errors.push(m.text());});
 await page.goto('http://127.0.0.1:8765');
 await page.waitForSelector('.formula-display');await page.waitForFunction(()=>document.querySelector('.formula-display')?.textContent!=='—');
 await page.waitForTimeout(1500);await page.screenshot({path:'tests/initial.png',fullPage:true});
 console.log('initial',await page.locator('.formula-display').innerText(),'canvas',await page.locator('canvas').count());
 await page.getByRole('button',{name:'方法與使用說明',exact:true}).click();await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'關閉說明',exact:true}).click();
 await page.getByRole('textbox',{name:'SMILES 分子輸入'}).fill('O');await page.getByRole('button',{name:'生成三維結構'}).click();await page.waitForFunction(()=>document.querySelector('.formula-display')?.textContent==='H2O');
 console.log('water',await page.locator('.right-panel').innerText());
 await page.getByRole('button',{name:'復原',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.formula-display')?.textContent==='C3H7NO');
 await page.getByRole('button',{name:'重做',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.formula-display')?.textContent==='H2O');
 await page.getByRole('textbox',{name:'SMILES 分子輸入'}).fill('C(C)(C)(C)(C)C');await page.getByRole('button',{name:'生成三維結構'}).click();await page.getByRole('alert').waitFor();console.log('invalid valence',await page.getByRole('alert').innerText());await page.getByRole('button',{name:'關閉錯誤'}).click();
 await page.getByRole('textbox',{name:'SMILES 分子輸入'}).fill('CC(=O)NC');await page.getByRole('button',{name:'生成三維結構'}).click();await page.waitForFunction(()=>document.querySelector('.formula-display')?.textContent==='C3H7NO');
 await page.getByLabel('原子標籤',{exact:true}).check();await page.waitForTimeout(300);await page.screenshot({path:'tests/labels.png',fullPage:true});
 await page.getByTitle('顯示設定',{exact:true}).click();await page.getByRole('button',{name:/空間填充/}).click();await page.waitForTimeout(200);await page.getByRole('button',{name:/球棍模型/}).click();
 await page.getByTitle('計算設定',{exact:true}).click();console.log('conformers',await page.locator('.conformer-list button').count());
 const before=await page.locator('.conformer-list button').count();if(before>1){await page.locator('.conformer-list button').nth(1).click();await page.waitForTimeout(800);if(await page.locator('.conformer-list button').count()!==before)throw Error('Conformer list lost');}
 await page.getByTitle('結構建構',{exact:true}).click();
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'tests/mobile.png',fullPage:true});
 console.log('mobile horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth));
 console.log('browser errors',JSON.stringify(errors));if(errors.length)process.exitCode=1;
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1);});
