/* Full browser integration checks against the locally running production server.
 * Run: node tests/editor-e2e.cjs
 * The browser is isolated; no existing browser profile or user files are used.
 */
const { chromium, expect } = require('@playwright/test');
const assert = require('node:assert/strict');

const URL = process.env.ORBITAL_TEST_URL || 'http://127.0.0.1:8765';
const heavy = m => m.atoms.filter(a => a.element !== 'H');
const heavyBonds = m => m.bonds.filter(b => heavy(m).some(a => a.id === b.a) && heavy(m).some(a => a.id === b.b));
const distance = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));
function dihedral(m, ids) {
  const p = ids.map(id => m.atoms.find(a => a.id === id).position);
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const dot = (a, b) => a.reduce((v, x, i) => v + x * b[i], 0);
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const b0 = sub(p[0],p[1]), b1 = sub(p[2],p[1]), b2 = sub(p[3],p[2]);
  const u = b1.map(x => x/Math.hypot(...b1));
  const v = b0.map((x,i) => x-dot(b0,u)*u[i]), w = b2.map((x,i) => x-dot(b2,u)*u[i]);
  return Math.atan2(dot(cross(u,v),w),dot(v,w))*180/Math.PI;
}

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    headless: true,
    args: ['--enable-webgl','--ignore-gpu-blocklist','--use-angle=swiftshader','--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1540, height: 1100 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [], results = [];
  let latest;
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', async response => {
    if (response.url().endsWith('/api/molecule')) {
      try { const data = await response.json(); if (data.atoms) latest = data; } catch {}
    }
  });
  async function step(name, fn) {
    try { await fn(); results.push({ name, pass: true }); console.log(`PASS ${name}`); }
    catch (error) { results.push({ name, pass: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
  }
  async function ready() {
    await expect(page.locator('.computing')).toHaveCount(0, { timeout: 60000 });
    await expect(page.locator('.formula-display')).not.toHaveText('—');
  }
  async function apiAction(action) {
    const waiting = page.waitForResponse(r => r.url().endsWith('/api/molecule') && r.request().method() === 'POST', { timeout: 60000 });
    await action();
    const response = await waiting;
    const data = await response.json();
    assert(response.ok() && !data.error, data.error || `HTTP ${response.status()}`);
    assert(Array.isArray(data.atoms) && data.atoms.length, 'missing model');
    latest = data;
    await ready();
    await expect(page.locator('.formula-display')).toHaveText(data.formula);
    return data;
  }
  async function buildPanel() { await page.getByTitle('結構建構', { exact: true }).click(); }
  async function selectMode(mode = '選取') { await page.getByRole('button', { name: mode, exact: true }).click(); }
  async function table() {
    await buildPanel();
    const details = page.locator('details.connection-table');
    if (!(await details.getAttribute('open')) && (await details.getAttribute('open')) !== '') await details.locator('summary').click();
  }
  async function selectAtom(id) { await table(); await page.getByLabel('依編號選取原子', { exact: true }).selectOption(String(id)); }
  async function selectBond(id) { await table(); await page.getByLabel('依編號選取化學鍵', { exact: true }).selectOption(String(id)); }
  async function generate(smiles) {
    await buildPanel(); await selectMode();
    if (await page.getByRole('button', { name: '關閉錯誤', exact: true }).count()) await page.getByRole('button', { name: '關閉錯誤', exact: true }).click();
    await page.getByLabel('SMILES 分子輸入').fill(smiles);
    return apiAction(() => page.getByRole('button', { name: '生成三維結構', exact: true }).click());
  }
  async function exportBuffer(buttonName) {
    await page.getByRole('button', { name: '匯出', exact: true }).click();
    const downloading = page.waitForEvent('download');
    await page.locator('.dropdown').getByRole('button', { name: buttonName }).click();
    const file = await downloading, stream = await file.createReadStream(), chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return { name: file.suggestedFilename(), buffer: Buffer.concat(chunks) };
  }
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await ready();

    await step('single carbon → attach carbon → attach oxygen', async () => {
      const methane = await apiAction(() => page.getByRole('button', { name: '從單一原子開始', exact: true }).click());
      assert.equal(methane.formula, 'CH4');
      await selectAtom(heavy(methane)[0].id);
      await page.getByRole('button', { name: '選擇碳元素', exact: true }).click();
      const ethane = await apiAction(() => page.getByRole('button', { name: '接上 C 原子', exact: true }).click());
      assert.equal(ethane.formula, 'C2H6');
      await selectAtom(heavy(ethane).at(-1).id);
      await page.getByRole('button', { name: '選擇氧元素', exact: true }).click();
      const ethanol = await apiAction(() => page.getByRole('button', { name: '接上 O 原子', exact: true }).click());
      assert.equal(ethanol.formula, 'C2H6O');
      assert.equal(heavyBonds(ethanol).length, 2);
    });

    await step('replace oxygen with nitrogen and change formal charge', async () => {
      const ethanol = await generate('CCO');
      await selectAtom(ethanol.atoms.find(a => a.element === 'O').id);
      await page.getByRole('button', { name: '選擇氮元素', exact: true }).click();
      await page.locator('.charge-input > button').nth(1).click();
      const ammonium = await apiAction(() => page.getByRole('button', { name: '套用', exact: true }).click());
      assert.equal(ammonium.charge, 1);
      assert.equal(ammonium.atoms.find(a => a.element === 'N').charge, 1);
      assert.equal(ammonium.atoms.filter(a => a.element === 'O').length, 0);
      assert.equal(ammonium.formula, 'C2H8N+');
    });

    await step('change ethane single bond to ethene double bond and lock rotation', async () => {
      const ethane = await generate('CC');
      await selectBond(heavyBonds(ethane)[0].id);
      const ethene = await apiAction(() => page.locator('.right-panel').getByRole('button', { name: '雙鍵', exact: true }).click());
      assert.equal(ethene.formula, 'C2H4');
      const double = heavyBonds(ethene)[0]; assert.equal(double.order, 2); assert.equal(double.rotatable, false);
      await selectBond(double.id);
      await expect(page.locator('.rotation-status')).toContainText('旋轉已鎖定');
      await expect(page.getByLabel('鍵旋轉角度')).toHaveCount(0);
    });

    await step('butane central-bond rotation preserves geometry and changes dihedral 60°', async () => {
      const butane = await generate('CCCC'), bonds = heavyBonds(butane);
      const degree = id => bonds.filter(b => b.a === id || b.b === id).length;
      const central = bonds.find(b => degree(b.a) === 2 && degree(b.b) === 2);
      assert(central?.rotatable);
      const outer = id => bonds.find(b => (b.a === id || b.b === id) && b.id !== central.id);
      const aBond = outer(central.a), dBond = outer(central.b);
      const ids = [aBond.a === central.a ? aBond.b : aBond.a, central.a, central.b, dBond.a === central.b ? dBond.b : dBond.a];
      await selectBond(central.id);
      await page.getByLabel('鍵旋轉角度').fill('60');
      const rotated = await apiAction(() => page.getByRole('button', { name: '旋轉', exact: true }).click());
      const delta = ((dihedral(rotated, ids)-dihedral(butane, ids)+540)%360)-180;
      assert(Math.abs(Math.abs(delta)-60) < .03, `dihedral change ${delta}`);
      // Serialization recenters the whole molecule. Compare every coordinate
      // against the exact rigid fragment rotation, followed by that translation.
      const moving = new Set([central.b]), queue = [central.b];
      for (let q=0;q<queue.length;q++) for (const b of butane.bonds) {
        const next = b.a===queue[q] ? b.b : b.b===queue[q] ? b.a : null;
        if (next!==null && next!==central.a && !moving.has(next)) {moving.add(next);queue.push(next);}
      }
      const origin = butane.atoms.find(a => a.id===central.a).position;
      const end = butane.atoms.find(a => a.id===central.b).position;
      const axis = end.map((x,i)=>(x-origin[i])/distance(end,origin));
      const theta = Math.PI/3;
      const predicted = butane.atoms.map(atom => {
        if (!moving.has(atom.id)) return [...atom.position];
        const p=atom.position.map((x,i)=>x-origin[i]);
        const dot=p.reduce((s,x,i)=>s+x*axis[i],0);
        const cross=[axis[1]*p[2]-axis[2]*p[1],axis[2]*p[0]-axis[0]*p[2],axis[0]*p[1]-axis[1]*p[0]];
        return p.map((x,i)=>x*Math.cos(theta)+cross[i]*Math.sin(theta)+axis[i]*dot*(1-Math.cos(theta))+origin[i]);
      });
      const centroid=[0,1,2].map(i=>predicted.reduce((s,p)=>s+p[i],0)/predicted.length);
      for (let i=0;i<predicted.length;i++) assert(distance(rotated.atoms[i].position,predicted[i].map((x,j)=>x-centroid[j])) < .0003, `unexpected rotated atom coordinates ${i}`);
      for (const b of rotated.bonds) assert(Math.abs(b.length-butane.bonds.find(x => x.id===b.id).length) < .001, 'bond length changed');
      await expect(page.locator('.rotation-status')).toContainText('可旋轉單鍵');
      await expect(page.getByLabel('鍵旋轉角度')).toHaveValue('60');
    });

    await step('close a six-carbon chain into a ring with connect tool', async () => {
      const chain = await generate('CCCCCC'), bonds = heavyBonds(chain);
      const ends = heavy(chain).filter(a => bonds.filter(b => b.a===a.id || b.b===a.id).length === 1);
      assert.equal(ends.length, 2);
      await selectMode('成鍵');
      await selectAtom(ends[0].id); await selectAtom(ends[1].id);
      const ring = await apiAction(() => page.getByRole('button', { name: /建立 單鍵 · 2\/2/ }).click());
      assert.equal(ring.formula, 'C6H12');
      assert.equal(heavyBonds(ring).length, 6);
      assert(heavyBonds(ring).every(b => !b.rotatable));
    });

    await step('measure two, three and four atoms using actual atom IDs', async () => {
      const m = await generate('CCCC'), ids = heavy(m).map(a => a.id);
      await selectMode('量測');
      await selectAtom(ids[0]); await selectAtom(ids[1]);
      await expect(page.locator('.measurement-card strong')).toContainText('原子間距');
      assert(!/NaN|未定義/.test(await page.locator('.measurement-card').innerText()));
      await selectAtom(ids[2]); await expect(page.locator('.measurement-card strong')).toContainText('鍵角');
      await selectAtom(ids[3]); await expect(page.locator('.measurement-card strong')).toContainText('二面角');
      const value = dihedral(m, ids).toFixed(2);
      await expect(page.locator('.measurement-card strong')).toContainText(value);
      await page.getByRole('button', { name: '清除量測', exact: true }).click();
      await expect(page.locator('.measurement-card strong')).toHaveText('依序點選原子');
    });

    await step('undo and redo restore molecule state', async () => {
      await generate('O'); await generate('N');
      await page.getByRole('button', { name: '復原', exact: true }).click();
      await expect(page.locator('.formula-display')).toHaveText('H2O');
      await page.getByRole('button', { name: '重做', exact: true }).click();
      await expect(page.locator('.formula-display')).toHaveText('H3N');
    });

    await step('export JSON and MOL, import each, and reload saved structure', async () => {
      const original = await generate('C[C@H](O)C(=O)O');
      await page.getByLabel('專案名稱').fill('Editor integration');
      const json = await exportBuffer(/工作專案/), mol = await exportBuffer(/三維結構/);
      const project = JSON.parse(json.buffer.toString('utf8'));
      assert.equal(project.format, 'orbital-project'); assert.equal(project.smiles, original.smiles);
      assert(mol.buffer.toString('utf8').includes('M  END'));
      await generate('C');
      const importedJson = await apiAction(() => page.locator('input[type=file]').setInputFiles({ name: json.name, mimeType: 'application/json', buffer: json.buffer }));
      assert.equal(importedJson.smiles, original.smiles);
      await expect(page.getByLabel('專案名稱')).toHaveValue('Editor integration');
      await generate('O');
      const importedMol = await apiAction(() => page.locator('input[type=file]').setInputFiles({ name: mol.name, mimeType: 'chemical/x-mdl-molfile', buffer: mol.buffer }));
      assert.equal(importedMol.smiles, original.smiles);
      for (const atom of importedMol.atoms) assert(distance(atom.position, original.atoms.find(a => a.id===atom.id).position) < .001);
      const reloaded = await apiAction(() => page.reload({ waitUntil: 'domcontentloaded' }));
      assert.equal(reloaded.smiles, original.smiles);
      assert(reloaded.atoms.some(a => a.cip), 'stereochemistry lost');
    });

    await step('heptane search keeps all candidate conformers after switching', async () => {
      await generate('CCCCCCC');
      await page.getByTitle('計算設定', { exact: true }).click();
      await page.getByLabel('候選構象數', { exact: true }).selectOption('16');
      const searched = await apiAction(() => page.getByRole('button', { name: '搜尋並最佳化', exact: true }).click());
      const count = searched.conformers.length;
      assert(count > 1, 'heptane search produced no alternative candidate');
      await expect(page.locator('.conformer-list button')).toHaveCount(count);
      await apiAction(() => page.locator('.conformer-list button').nth(1).click());
      await expect(page.locator('.conformer-list button')).toHaveCount(count);
      await expect(page.locator('.conformer-list button').nth(1).locator('i')).toHaveClass('active');
      await apiAction(() => page.locator('.conformer-list button').nth(0).click());
      await expect(page.locator('.conformer-list button')).toHaveCount(count);
      await expect(page.locator('.conformer-list button').nth(0).locator('i')).toHaveClass('active');
    });

    await step('actual WebGL atom picking with hydrogens hidden', async () => {
      const methane = await generate('C');
      await page.getByLabel('氫原子', { exact: true }).uncheck();
      await page.getByRole('button', { name: '置中模型', exact: true }).click();
      await page.waitForTimeout(450);
      const canvas = page.locator('.molecule-scene canvas');
      const box = await canvas.boundingBox(); assert(box && box.width > 100 && box.height > 100);
      await canvas.click({ position: { x: box.width/2, y: box.height/2 } });
      await expect(page.locator('.selected-atom > span')).toHaveText('C');
      await expect(page.locator('.selected-atom strong')).toHaveText(`原子 ${heavy(methane)[0].id+1}`);
      await page.getByLabel('氫原子', { exact: true }).check();
    });

    await step('browser runtime has no uncaught errors', async () => assert.deepEqual(errors, []));
    console.log(JSON.stringify({ total: results.length, passed: results.filter(r => r.pass).length, results }, null, 2));
    if (results.some(r => !r.pass)) process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
