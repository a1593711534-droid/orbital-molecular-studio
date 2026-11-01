/* Regression checks for atom-by-atom E/Z editing. Uses an isolated Edge profile.
 * ORBITAL_TEST_URL=http://127.0.0.1:8766 node tests/stereo-editor-e2e.cjs
 * Optional ORBITAL_SCREENSHOT_DIR writes cis/trans and narrow-screen previews.
 */
const { chromium, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const URL = process.env.ORBITAL_TEST_URL || 'http://127.0.0.1:8765';
const heavy = model => model.atoms.filter(atom => atom.element !== 'H');
const doubleBonds = model => model.bonds.filter(bond => bond.order === 2);
const bondBetween = (model, a, b) => model.bonds.find(bond => (bond.a === a && bond.b === b) || (bond.a === b && bond.b === a));
function dihedral(model, ids) {
  const p = ids.map(id => model.atoms.find(atom => atom.id === id).position);
  const sub = (a,b) => a.map((v,i) => v-b[i]);
  const dot = (a,b) => a.reduce((sum,v,i) => sum+v*b[i],0);
  const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const b0=sub(p[0],p[1]), b1=sub(p[2],p[1]), b2=sub(p[3],p[2]);
  const unit=b1.map(v => v/Math.hypot(...b1));
  const v=b0.map((x,i) => x-dot(b0,unit)*unit[i]), w=b2.map((x,i) => x-dot(b2,unit)*unit[i]);
  return Math.atan2(dot(cross(unit,v),w),dot(v,w))*180/Math.PI;
}
function assertButene(model, configuration) {
  assert.equal(model.formula, 'C4H8');
  const bond=doubleBonds(model)[0];
  assert.equal(bond.stereoControl.current, configuration);
  assert.equal(bond.stereo, `STEREO${configuration}`);
  assert.equal(bond.rotatable, false, 'pi bond became freely rotatable');
  const neighbor = center => model.bonds.filter(b => b.id !== bond.id && (b.a === center || b.b === center))
    .map(b => b.a === center ? b.b : b.a).find(id => model.atoms.find(a => a.id === id).element === 'C');
  const angle=Math.abs(dihedral(model,[neighbor(bond.a),bond.a,bond.b,neighbor(bond.b)]));
  assert(Math.abs(angle-(configuration === 'Z' ? 0 : 180)) < 5, `wrong actual carbon dihedral: ${angle}`);
  return bond;
}

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true,
    args: ['--enable-webgl','--ignore-gpu-blocklist','--use-angle=swiftshader','--enable-unsafe-swiftshader'],
  });
  const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  const page=await context.newPage();
  page.setDefaultTimeout(15000);
  const errors=[], results=[];
  page.on('pageerror', error => errors.push(error.message));
  async function step(name, action) {
    await action();
    results.push({name,pass:true});
    console.log(`PASS ${name}`);
  }
  async function apiAction(action) {
    const waiting=page.waitForResponse(response => response.url().endsWith('/api/molecule') && response.request().method() === 'POST',{timeout:60000});
    await action();
    const response=await waiting, data=await response.json();
    assert(response.ok() && !data.error,data.error || `HTTP ${response.status()}`);
    await expect(page.locator('.computing')).toHaveCount(0,{timeout:60000});
    await expect(page.locator('.formula-display')).toHaveText(data.formula);
    return data;
  }
  async function table() {
    await page.getByTitle('結構建構',{exact:true}).click();
    const details=page.locator('details.connection-table');
    if (await details.getAttribute('open') === null) await details.locator('summary').click();
  }
  async function selectAtom(id) {await table();await page.getByLabel('依編號選取原子',{exact:true}).selectOption(String(id));}
  async function selectBond(id) {await table();await page.getByLabel('依編號選取化學鍵',{exact:true}).selectOption(String(id));}
  async function generate(smiles) {
    await page.getByTitle('結構建構',{exact:true}).click();
    await page.getByRole('button',{name:'選取',exact:true}).click();
    await page.getByLabel('SMILES 分子輸入').fill(smiles);
    return apiAction(() => page.getByRole('button',{name:'生成三維結構',exact:true}).click());
  }
  async function choose(configuration) {
    return apiAction(() => page.getByRole('button',{name:`設定 ${configuration} 構型`,exact:true}).click());
  }
  async function locked() {
    await expect(page.locator('.rotation-status')).toContainText('旋轉已鎖定');
    await expect(page.getByLabel('鍵旋轉角度')).toHaveCount(0);
  }
  async function screenshot(name) {
    const folder=process.env.ORBITAL_SCREENSHOT_DIR;
    if (!folder) return;
    fs.mkdirSync(folder,{recursive:true});
    await expect(page.locator('.toast.success')).toHaveCount(0,{timeout:6000});
    await page.screenshot({path:path.join(folder,name),fullPage:true});
  }
  async function exportProject() {
    await page.getByRole('button',{name:'匯出',exact:true}).click();
    const waiting=page.waitForEvent('download');
    await page.locator('.dropdown').getByRole('button',{name:/工作專案/}).click();
    const file=await waiting, stream=await file.createReadStream(), chunks=[];
    for await (const chunk of stream) chunks.push(chunk);
    return {name:file.suggestedFilename(),mimeType:'application/json',buffer:Buffer.concat(chunks)};
  }
  let model, cis, trans;
  try {
    await apiAction(() => page.goto(URL,{waitUntil:'domcontentloaded'}));
    await step('build four carbons one at a time and turn the middle bond into C=C', async () => {
      model=await apiAction(() => page.getByRole('button',{name:'從單一原子開始',exact:true}).click());
      await page.getByRole('button',{name:'選擇碳元素',exact:true}).click();
      for (let i=1;i<4;i++) {
        await selectAtom(heavy(model).at(-1).id);
        model=await apiAction(() => page.getByRole('button',{name:'接上 C 原子',exact:true}).click());
        assert.equal(heavy(model).length,i+1);
      }
      const ids=heavy(model).map(atom => atom.id);
      await selectBond(bondBetween(model,ids[1],ids[2]).id);
      model=await apiAction(() => page.locator('.right-panel').getByRole('button',{name:'雙鍵',exact:true}).click());
      const central=doubleBonds(model)[0];
      assert.equal(central.stereoControl.editable,true);
      assert.equal(central.stereoControl.current,'unspecified');
      assert.equal(central.stereoControl.cisTrans,true);
      await selectBond(central.id);
      await expect(page.getByRole('button',{name:'設定 Z 構型',exact:true})).toContainText('順式');
      await expect(page.getByRole('button',{name:'設定 E 構型',exact:true})).toContainText('反式');
    });
    await step('set cis Z and verify actual 3D geometry while pi rotation stays locked', async () => {
      cis=await choose('Z');
      const bond=assertButene(cis,'Z');
      await selectBond(bond.id);await locked();
      await expect(page.getByRole('button',{name:'設定 Z 構型',exact:true})).toHaveAttribute('aria-pressed','true');
      await screenshot('stereo-cis.png');
    });
    await step('set trans E and verify actual 3D geometry while pi rotation stays locked', async () => {
      trans=await choose('E');
      const bond=assertButene(trans,'E');
      await selectBond(bond.id);await locked();
      await expect(page.getByRole('button',{name:'設定 E 構型',exact:true})).toHaveAttribute('aria-pressed','true');
      await screenshot('stereo-trans.png');
    });
    await step('undo and redo retain explicit E/Z configurations', async () => {
      await page.getByRole('button',{name:'復原',exact:true}).click();
      await expect(page.getByLabel('SMILES 分子輸入')).toHaveValue(cis.smiles);
      await selectBond(doubleBonds(cis)[0].id);
      await expect(page.getByRole('button',{name:'設定 Z 構型',exact:true})).toHaveAttribute('aria-pressed','true');
      await page.getByRole('button',{name:'重做',exact:true}).click();
      await expect(page.getByLabel('SMILES 分子輸入')).toHaveValue(trans.smiles);
      await selectBond(doubleBonds(trans)[0].id);
      await expect(page.getByRole('button',{name:'設定 E 構型',exact:true})).toHaveAttribute('aria-pressed','true');
    });
    await step('E survives JSON export/import, reload and force-field optimization', async () => {
      const project=await exportProject();
      assert.equal(JSON.parse(project.buffer.toString('utf8')).smiles,trans.smiles);
      await generate('O');
      model=await apiAction(() => page.locator('input[type=file]').setInputFiles(project));assertButene(model,'E');
      model=await apiAction(() => page.reload({waitUntil:'domcontentloaded'}));assertButene(model,'E');
      await page.getByTitle('計算設定',{exact:true}).click();
      model=await apiAction(() => page.getByRole('button',{name:'最佳化目前構象',exact:true}).click());assertButene(model,'E');
    });
    await step('clear stereo assignment without coordinates silently assigning it again', async () => {
      await selectBond(doubleBonds(model)[0].id);
      model=await apiAction(() => page.getByRole('button',{name:'清除雙鍵構型指定',exact:true}).click());
      assert.equal(doubleBonds(model)[0].stereoControl.current,'unspecified');
      assert(model.warnings.some(text => text.includes('未指定')));
      assert(!/[\\/]/.test(model.smiles));
      model=await apiAction(() => page.reload({waitUntil:'domcontentloaded'}));
      assert.equal(doubleBonds(model)[0].stereoControl.current,'unspecified');
      await page.getByTitle('計算設定',{exact:true}).click();
      model=await apiAction(() => page.getByRole('button',{name:'最佳化目前構象',exact:true}).click());
      assert.equal(doubleBonds(model)[0].stereoControl.current,'unspecified');
    });
    await step('terminal, identical-substituent and small-ring double bonds cannot be assigned E/Z', async () => {
      for (const smiles of ['C=CC','CC(C)=CC','C1=CCCCC1']) {
        model=await generate(smiles);
        const bond=doubleBonds(model)[0];
        assert.equal(bond.stereoControl.editable,false,smiles);
        assert(bond.stereoControl.reason,`${smiles} lacks an explanation`);
        await selectBond(bond.id);
        for (const stereo of ['E','Z']) {
          const button=page.getByRole('button',{name:`設定 ${stereo} 構型`,exact:true});
          if (await button.count()) await expect(button).toBeDisabled();
        }
        await locked();
      }
    });
    await step('fully substituted alkene uses E/Z wording, not unconditional cis/trans labels', async () => {
      model=await generate('CC(Cl)=C(Br)C');
      const bond=doubleBonds(model)[0];
      assert.equal(bond.stereoControl.editable,true);
      assert.equal(bond.stereoControl.cisTrans,false);
      await selectBond(bond.id);
      for (const stereo of ['E','Z']) {
        const button=page.getByRole('button',{name:`設定 ${stereo} 構型`,exact:true});
        await expect(button).not.toContainText(/順式|反式/);
      }
      model=await choose('Z');assert.equal(doubleBonds(model)[0].stereoControl.current,'Z');
    });
    await step('editing one double bond retains the other E/Z bond and remote chiral center', async () => {
      const original=await generate('C[C@H](F)C/C=C/C/C=C/C');
      const bonds=doubleBonds(original), centers=original.stereoSummary.centers;
      assert.equal(bonds.length,2);assert.equal(centers.length,1);
      const changed=bonds[0], other=bonds[1];
      await selectBond(changed.id);
      const desired=changed.stereoControl.current === 'E' ? 'Z' : 'E';
      model=await choose(desired);
      assert.equal(bondBetween(model,changed.a,changed.b).stereoControl.current,desired);
      assert.equal(bondBetween(model,other.a,other.b).stereoControl.current,other.stereoControl.current);
      assert.deepEqual(model.stereoSummary.centers,centers);
    });
    await step('controls stay usable at 390px with 20px text, with no page overflow or browser errors', async () => {
      model=await generate('CC=CC');await selectBond(doubleBonds(model)[0].id);
      await page.getByRole('button',{name:'文字大小與顯示設定',exact:true}).click();
      await page.getByLabel('介面字級').selectOption('1.25');
      await page.setViewportSize({width:390,height:844});
      await selectBond(doubleBonds(model)[0].id);
      await page.getByRole('button',{name:'設定 Z 構型',exact:true}).scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
      model=await choose('Z');assertButene(model,'Z');
      await screenshot('stereo-mobile-large.png');
      assert.deepEqual(errors,[]);
    });
    console.log(JSON.stringify({total:results.length,passed:results.length,results},null,2));
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
