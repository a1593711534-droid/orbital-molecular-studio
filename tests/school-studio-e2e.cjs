// Run against a local ORBITAL server with its real Python chemistry engine.
const { chromium, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

async function main() {
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser = await chromium.launch({
    executablePath: process.env.ORBITAL_BROWSER || (fs.existsSync(edge) ? edge : undefined),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage({ viewport: {width: 1280, height: 850} });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.ORBITAL_TEST_URL || 'http://127.0.0.1:8765');
    const button = name => page.getByRole('button', { name, exact: true });
    const search = page.getByRole('searchbox', { name: '搜尋常見結構' });
    const examples = page.getByRole('combobox', { name: '選擇高中常見結構' });
    async function choose(query, name) {
      await button('輸入結構').click();
      await search.fill(query);
      const choice = examples.locator('option').filter({hasText: name});
      await expect(choice).toHaveCount(1);
      await examples.selectOption(await choice.getAttribute('value'));
      await expect(button('生成三維結構')).toBeEnabled();
    }
    async function generate(smiles) {
      const response = page.waitForResponse(r => {
        if (!r.url().endsWith('/api/molecule')) return false;
        const body = r.request().postDataJSON();
        return body?.action === 'generate' && body.smiles === smiles;
      });
      await button('生成三維結構').click();
      const r = await response;
      assert.equal(r.status(), 200);
      await expect(page.getByRole('dialog', {name:'輸入結構'})).toHaveCount(0);
      return r.json();
    }
    await choose('SF6', '六氟化硫');
    const sulfur = await generate('FS(F)(F)(F)(F)F');
    assert.equal(sulfur.geometrySource.model, 'AX6');
    await expect(page.locator('.formula-display')).toHaveText('SF6');
    await button('計算設定').click();
    await expect(button('套用模型幾何')).toBeVisible();
    assert.equal(sulfur.energy, null);
    await page.reload();
    await expect(page.locator('.formula-display')).toHaveText('SF6');
    console.log('PASS SF6 search, 2D preview, real 3D generation, computation panel and restoration');

    await page.setViewportSize({width:390, height:844});
    await choose('C2H6O', '二甲醚');
    await expect(examples.locator('option:not([value=""])')).toHaveCount(2);
    await expect(page.locator('.formula-display')).toHaveText('SF6');
    await button('關閉結構輸入').click();
    await choose('氧氣', '氧氣');
    const oxygen = await generate('O=O');
    assert.equal(oxygen.electronicState.multiplicity, 3);
    await button('分子資訊').click();
    await expect(page.getByText(/三重態/).first()).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log('PASS mobile search, both C2H6O isomers, unchanged canvas during preview, triplet O2');
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
