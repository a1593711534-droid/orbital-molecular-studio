// Exercise the audit cases through the real editor and its chemistry service.
const { chromium, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');

async function main() {
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser = await chromium.launch({
    executablePath: process.env.ORBITAL_BROWSER || (existsSync(edge) ? edge : undefined),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.ORBITAL_TEST_URL || 'http://127.0.0.1:8765');
    const button = name => page.getByRole('button', {name, exact: true});
    const choices = page.getByLabel('依編號選取原子', {exact: true});
    async function pick(id) {
      if (!await choices.isVisible()) await button('依編號選取').click();
      await choices.selectOption(String(id));
      if (await button('關閉編號選取').isVisible()) await button('關閉編號選取').click();
    }
    async function action(name, trigger) {
      const pending = page.waitForResponse(response => response.url().endsWith('/api/molecule')
        && response.request().postDataJSON()?.action === name);
      await trigger();
      const response = await pending;
      return response.json();
    }
    async function preview(smiles) {
      await button('輸入結構').click();
      await page.getByLabel('SMILES 分子輸入', {exact:true}).fill(smiles);
      await expect(page.locator('.structure-input')).toHaveAttribute('data-preview-state', 'valid');
    }
    async function generate(smiles) {
      await preview(smiles);
      const data = await action('generate', () => button('生成三維結構').click());
      assert(data.molblock, data.error);
      await expect(page.locator('.structure-input')).toHaveCount(0);
      return data;
    }
    await button('輸入結構').click();
    const editor = page.getByLabel('SMILES 分子輸入', {exact:true});
    await expect(editor).toBeFocused();
    // The previously competing focus timer fired 40 ms after the dialog opened.
    await page.waitForTimeout(100);
    await expect(editor).toBeFocused();
    await button('關閉結構輸入').click();
    console.log('PASS #24 initial keyboard focus');

    const nitrate = await generate('[O-][N+](=O)[O-]');
    await action('analyze', () => page.reload());
    await button('選取').click();
    await pick(nitrate.atoms.find(a => a.element === 'O' && a.charge < 0).id);
    await expect(page.getByLabel('氫原子設定')).toHaveValue('0');
    await button('增加電荷').click();
    const denied = await action('generate', () => button('套用原子變更').click());
    assert(denied.error);
    await expect(page.locator('.formula-display')).toContainText('NO3');
    await button('關閉錯誤').click();
    console.log('PASS #1 nitrate edit after project restore');

    const alanine = await generate('N[C@@H](C)C(=O)O');
    await button('選取').click();
    await pick(alanine.atoms.find(a => a.cip === 'S').id);
    await page.getByLabel('氫原子設定').selectOption('auto');
    const edited = await action('generate', () => button('套用原子變更').click());
    assert.equal(edited.smiles, alanine.smiles);
    assert(edited.atoms.some(a => a.cip === 'S'));
    console.log('PASS #2 alanine hydrogen mode preserves S');

    await generate('[O-]S(=O)(=O)[O-]');
    await button('Lewis 式').click();
    await expect(button('Lewis 式')).toHaveAttribute('aria-pressed','true');
    await button('離域示意').click();
    console.log('PASS #7 sulfate representation switch');

    const water = await generate('[2H]O');
    const d = water.atoms.find(a => a.isotope === 2).id;
    await button('選取').click();
    await button('依編號選取').click();
    await expect(choices.locator(`option[value="${d}"]`)).toContainText('²H');
    await pick(d);
    await expect(page.locator('.atom-heading')).toContainText('²H');
    const unlabelled = await action('generate', () => page.locator('.delete-button').click());
    assert.equal(unlabelled.formula, 'H2O');
    assert(unlabelled.atoms.every(a => !a.isotope));
    console.log('PASS #18 select and remove an isotope');

    const file = {name:'pair.sdf', mimeType:'chemical/x-mdl-sdfile',
      buffer:Buffer.from(water.molblock + '\n$$$$\n' + alanine.molblock + '\n$$$$\n')};
    await page.locator('input[type=file]').setInputFiles(file);
    await expect(page.getByText(/(?:2|兩)\s*筆/).first()).toBeVisible();
    console.log('PASS #16 multi-record SDF disclosure');

    const methane = await generate('C');
    const record = methane.molblock.split(/\r?\n/);
    const atomStart = record.findIndex(line => line.includes('V2000')) + 1;
    assert(atomStart > 0);
    for (let i = 0; i < methane.atoms.length; i++) {
      const line = record[atomStart+i];
      const shifted = [80,-60,40].map((offset, axis) =>
        (Number(line.slice(axis*10,axis*10+10))+offset).toFixed(4).padStart(10));
      record[atomStart+i] = shifted.join('') + line.slice(30);
    }
    const result = await action('analyze', () => page.locator('input[type=file]').setInputFiles({
      name:'shifted.mol',mimeType:'chemical/x-mdl-molfile',buffer:Buffer.from(record.join('\n')),
    }));
    assert(result.atoms[0].position[0] > 79);
    await button('匯出').click();
    const download = page.waitForEvent('download');
    await page.locator('.export-menu').getByRole('button',{name:/三維結構/}).click();
    const chunks = [];
    for await (const chunk of await (await download).createReadStream()) chunks.push(chunk);
    const output = Buffer.concat(chunks).toString().split(/\r?\n/);
    const start = output.findIndex(line => line.includes('V2000')) + 1;
    for (let i = 0; i < result.atoms.length; i++) assert.equal(output[start+i].slice(0,30),record[atomStart+i].slice(0,30));
    await button('選取').click();
    const canvas = page.locator('.molecule-scene canvas');
    const box = await canvas.boundingBox();
    await canvas.click({position:{x:box.width/2,y:box.height/2}});
    await expect(page.locator('.atom-heading')).toBeVisible();
    console.log('PASS #15 translated MOL stays selectable and retains coordinates on export');

    await page.setViewportSize({width:390,height:844});
    await preview('FS(F)(F)(F)(F)F');
    await expect(page.locator('.si-model-warning').filter({hasText:/VSEPR/}).first()).toBeVisible();
    const sf6 = await action('generate', () => button('生成三維結構').click());
    await expect(page.locator('.structure-input')).toHaveCount(0);
    await page.setViewportSize({width:1440,height:1000});
    const fluorines = sf6.atoms.filter(a => a.element === 'F').map(a => a.id);
    await button('量測').click();
    for (const id of fluorines.slice(0,3)) await pick(id);
    await expect(page.locator('.measurement-value')).toContainText('夾角');
    await button('清除量測').click();
    for (const id of [fluorines[0],sf6.atoms.find(a => a.element === 'S').id,fluorines[1]]) await pick(id);
    await expect(page.locator('.measurement-value')).toContainText('鍵角');
    console.log('PASS #17 bonded angle distinction and #22 mobile warning');

    await page.evaluate(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'orbital-v1-session') throw new DOMException('full','QuotaExceededError');
        return setItem.call(this,key,value);
      };
    });
    await page.getByLabel('專案名稱',{exact:true}).fill('儲存失敗測試');
    await expect(page.getByText(/儲存失敗|未儲存|無法儲存/).first()).toBeVisible();
    assert.deepEqual(errors, []);
    console.log('PASS #23 simulated storage failure and browser exception check');
  } finally {
    await browser.close();
  }
}
main().catch(error => {console.error(error);process.exitCode=1;});
