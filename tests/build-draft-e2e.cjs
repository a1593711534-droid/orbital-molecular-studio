// Every addition goes through the real UI and the local chemistry service.
const {chromium, expect} = require('@playwright/test');
const assert = require('node:assert/strict');
const {existsSync} = require('node:fs');

async function main() {
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser = await chromium.launch({
    executablePath:process.env.ORBITAL_BROWSER || (existsSync(edge) ? edge : undefined),
    args:['--use-angle=swiftshader','--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage({viewport:{width:1280,height:900}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.ORBITAL_TEST_URL || 'http://127.0.0.1:8765');
    const button = name => page.getByRole('button', {name,exact:true});
    const draft = page.getByRole('dialog', {name:'接原子草稿'});
    const stored = () => page.evaluate(() => localStorage.getItem('orbital-v1-session'));
    const names = {P:'磷',Be:'鈹',Xe:'氙',F:'氟',Cl:'氯',S:'硫'};
    async function choose(symbol) {
      const tool = button('選擇' + names[symbol] + '元素');
      if (!await tool.isVisible()) await button('更多元素').click();
      await tool.click();
    }
    async function generate(click) {
      const waiting = page.waitForResponse(r => r.url().endsWith('/api/molecule')
        && r.request().postDataJSON()?.action === 'generate');
      await click();
      const response = await waiting;
      const result = await response.json();
      if (response.status() === 422) await expect(draft).toBeVisible();
      else {
        assert.equal(response.status(),200,result.error);
        await expect(draft).toHaveCount(0);
        await expect.poll(async () => JSON.parse(await stored())?.molblock).toBe(result.molblock);
      }
      return result;
    }
    for (const [center,ligand,count,vsepr] of [
      ['Be','Cl',2,'AX2'], ['Xe','F',4,'AX4E2'], ['P','F',5,'AX5'],
      ['S','F',6,'AX6'], ['Cl','F',3,'AX3E2'],
    ]) {
      await button('新建').click();
      await choose(center);
      let result = await generate(() => button('放下第一個原子').click());
      for (let n=0;n<count;n++) {
        const before = await stored();
        if (await draft.isVisible()) {
          await draft.getByLabel('連接位置').selectOption('0');
          await draft.getByLabel('接上的元素').selectOption(ligand);
          result = await generate(() => button('接上並驗證').click());
        } else {
          await choose(ligand);
          await button('依編號選取').click();
          result = await generate(() => page.getByLabel('依編號選取原子').selectOption('0'));
          if (!result.error && await button('關閉編號選取').isVisible()) await button('關閉編號選取').click();
        }
        if (result.error) {
          assert.equal(await stored(),before,'an incomplete draft replaced the saved model');
          if (center==='P' && n===3) {
            await button('取消草稿').click();
            assert.equal(await stored(),before);
            if (!await page.getByLabel('依編號選取原子').isVisible()) await button('依編號選取').click();
            result=await generate(() => page.getByLabel('依編號選取原子').selectOption('0'));
            assert(result.error);
          }
        } else if(await button('關閉編號選取').isVisible()) await button('關閉編號選取').click();
      }
      assert.equal(result.geometrySource?.model,vsepr);
      assert.equal(result.graph.bonds.length,count);
      console.log('PASS build from single atom through draft:',center,ligand,count);
    }
    assert.deepEqual(errors,[]);
  } finally {
    await browser.close();
  }
}
main().catch(error => {console.error(error);process.exitCode=1;});
