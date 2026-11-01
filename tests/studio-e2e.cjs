/* v1.1.0 studio integration checks. Isolated Edge profile; no user state is read.
 * Run against an already-started app with ORBITAL_TEST_URL (default port 8765).
 * ORBITAL_SCREENSHOT_DIR optionally records release previews and JSON results.
 */
const { chromium, expect } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const URL = process.env.ORBITAL_TEST_URL || 'http://127.0.0.1:8765';
const heavy = model => model.atoms.filter(atom => atom.element !== 'H');
const heavyBonds = model => model.bonds.filter(bond => [bond.a,bond.b].every(id => heavy(model).some(atom => atom.id === id)));
const doubles = model => model.bonds.filter(bond => bond.order === 2);
const bondBetween = (model,a,b) => model.bonds.find(bond => (bond.a === a && bond.b === b) || (bond.a === b && bond.b === a));
const distance = (a,b) => Math.hypot(...a.map((v,i) => v-b[i]));
function dihedral(model, ids) {
  const points = ids.map(id => model.atoms.find(atom => atom.id === id).position);
  const sub = (a,b) => a.map((v,i) => v-b[i]);
  const dot = (a,b) => a.reduce((total,v,i) => total+v*b[i],0);
  const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const b0=sub(points[0],points[1]), b1=sub(points[2],points[1]), b2=sub(points[3],points[2]);
  const unit=b1.map(v => v/Math.hypot(...b1));
  const v=b0.map((x,i) => x-dot(b0,unit)*unit[i]), w=b2.map((x,i) => x-dot(b2,unit)*unit[i]);
  return Math.atan2(dot(cross(unit,v),w),dot(v,w))*180/Math.PI;
}
function verifyButene(model, configuration) {
  assert.equal(model.formula,'C4H8');
  const bond=doubles(model)[0];
  assert.equal(bond.stereoControl.current,configuration);
  assert.equal(bond.rotatable,false,'pi bond became freely rotatable');
  const neighbor = center => model.bonds.filter(b => b.id !== bond.id && (b.a === center || b.b === center))
    .map(b => b.a === center ? b.b : b.a).find(id => model.atoms.find(a => a.id === id).element === 'C');
  const angle=Math.abs(dihedral(model,[neighbor(bond.a),bond.a,bond.b,neighbor(bond.b)]));
  assert(Math.abs(angle-(configuration === 'Z' ? 0 : 180)) < 5,`wrong carbon dihedral: ${angle}`);
  return bond;
}
function requestAction(response) {
  if (!response.url().endsWith('/api/molecule') || response.request().method() !== 'POST') return null;
  try {return response.request().postDataJSON().action || 'generate';} catch {return null;}
}

async function main() {
  const browser=await chromium.launch({
    executablePath:'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',headless:true,
    args:['--enable-webgl','--ignore-gpu-blocklist','--use-angle=swiftshader','--enable-unsafe-swiftshader'],
  });
  const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  const page=await context.newPage();
  page.setDefaultTimeout(18000);
  const errors=[], results=[];
  page.on('pageerror',error => errors.push(error.message));
  async function step(name,action) {
    try {await action();results.push({name,pass:true});console.log(`PASS ${name}`);}
    catch(error){results.push({name,pass:false,error:error.message});console.error(`FAIL ${name}: ${error.message}`);await screenshot('failure.png',false);throw error;}
  }
  async function apiAction(action, expected='generate') {
    const waiting=page.waitForResponse(response => requestAction(response) === expected,{timeout:60000});
    await action();
    const response=await waiting, data=await response.json();
    assert(response.ok() && !data.error,data.error || `HTTP ${response.status()}`);
    assert(data.atoms?.length,'missing model response');
    await page.waitForFunction(molblock => {
      const saved=JSON.parse(localStorage.getItem('orbital-v1-session') || 'null');
      return saved?.molblock === molblock && document.querySelectorAll('.computing').length === 0;
    },data.molblock,{timeout:60000});
    return data;
  }
  async function screenshot(name,waitForNotice=true) {
    const folder=process.env.ORBITAL_SCREENSHOT_DIR;if(!folder)return;
    fs.mkdirSync(folder,{recursive:true});
    if(waitForNotice)await expect(page.locator('.toast.success')).toHaveCount(0,{timeout:7000});
    await page.waitForTimeout(300);
    await page.screenshot({path:path.join(folder,name),fullPage:true});
  }
  const button=name=>page.getByRole('button',{name,exact:true});
  async function closePanel(){if(await button('關閉工具面板').count())await button('關閉工具面板').click();}
  async function mode(name){await button(name).click();}
  async function table(){
    const selector=page.getByLabel('依編號選取原子',{exact:true});
    if(!(await selector.isVisible()))await button('依編號選取').click();
  }
  async function selectAtom(id){await table();await page.getByLabel('依編號選取原子',{exact:true}).selectOption(String(id));}
  async function selectBond(id){await table();await page.getByLabel('依編號選取化學鍵',{exact:true}).selectOption(String(id));}
  async function closeTable(){if(await button('關閉編號選取').isVisible())await button('關閉編號選取').click();}
  async function input(){if(!(await page.getByRole('dialog',{name:'輸入結構',exact:true}).count()))await button('輸入結構').click();}
  async function inspect(smiles){await input();await page.getByLabel('SMILES 分子輸入',{exact:true}).fill(smiles);await expect(page.locator('.structure-input')).toHaveAttribute('data-preview-state','valid',{timeout:15000});}
  async function generate(smiles){await inspect(smiles);const data=await apiAction(()=>button('生成三維結構').click());await expect(page.getByRole('dialog',{name:'輸入結構',exact:true})).toHaveCount(0);return data;}
  async function setStereo(value){return apiAction(()=>button(`設定 ${value} 構型`).click(),'set_stereo');}
  async function exportBuffer(name){
    await button('匯出').click();const waiting=page.waitForEvent('download');
    await page.locator('.export-menu').getByRole('button',{name}).click();
    const file=await waiting,stream=await file.createReadStream(),chunks=[];
    for await(const chunk of stream)chunks.push(chunk);
    return {name:file.suggestedFilename(),buffer:Buffer.concat(chunks)};
  }
  async function assertNoOverflow(){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'whole page has horizontal overflow');}
  let model,cis,trans;
  try {
    await page.goto(URL,{waitUntil:'domcontentloaded'});
    await step('new users start from an empty model without an examples gallery',async()=>{
      await expect(button('放下第一個原子')).toBeEnabled();
      await expect(page.locator('.inspector')).toHaveCount(0);
      await screenshot('studio-empty.png');
      model=await apiAction(()=>button('放下第一個原子').click());
      assert.equal(model.formula,'CH4');
    });
    await step('actual WebGL atom click attaches carbon in build mode',async()=>{
      await button('顯示設定').click();await page.getByLabel('氫原子',{exact:true}).uncheck();await closePanel();
      await button('置中模型').click();await page.waitForTimeout(350);
      const canvas=page.locator('.molecule-scene canvas'),box=await canvas.boundingBox();
      assert(box&&box.width>200&&box.height>200);
      model=await apiAction(()=>canvas.click({position:{x:box.width/2,y:box.height/2}}));
      assert.equal(model.formula,'C2H6');
      await button('顯示設定').click();await page.getByLabel('氫原子',{exact:true}).check();await closePanel();
    });
    await step('continuous append retains the new chain end and all twelve element tools',async()=>{
      for(let count=3;count<=4;count++){
        await expect(button('接上 C 原子')).toBeEnabled();
        model=await apiAction(()=>button('接上 C 原子').click());
        assert.equal(heavy(model).length,count);
      }
      await button('更多元素').click();
      for(const name of ['碳','氮','氧','氫','硫','氯','磷','氟','溴','碘','硼','矽'])await expect(button(`選擇${name}元素`)).toBeVisible();
      await button('選擇碳元素').click();
      const bonds=heavyBonds(model),degree=id=>bonds.filter(b=>b.a===id||b.b===id).length;
      assert.equal(bonds.filter(b=>degree(b.a)===2&&degree(b.b)===2).length,1,'append produced a branch instead of a chain');
    });
    await step('middle bond changes to double and explicit cis/trans alter real 3D geometry',async()=>{
      const bonds=heavyBonds(model),degree=id=>bonds.filter(b=>b.a===id||b.b===id).length;
      const middle=bonds.find(b=>degree(b.a)===2&&degree(b.b)===2);
      await selectBond(middle.id);
      model=await apiAction(()=>page.locator('.inspector').getByRole('button',{name:'雙鍵',exact:true}).click());
      await closeTable();await expect(button('設定 Z 構型')).toContainText('順式');
      cis=await setStereo('Z');verifyButene(cis,'Z');
      await expect(page.locator('.rotation-status')).toContainText('旋轉已鎖定');
      await expect(page.getByLabel('鍵旋轉角度')).toHaveCount(0);
      await screenshot('studio-cis.png');
      trans=await setStereo('E');verifyButene(trans,'E');
      await screenshot('studio-trans.png');model=trans;
    });
    await step('actual WebGL double-bond picking opens its E/Z editor',async()=>{
      await mode('選取');await closeTable();await button('置中模型').click();await page.waitForTimeout(350);
      const canvas=page.locator('.molecule-scene canvas'),box=await canvas.boundingBox();assert(box);
      let picked=false;
      for(const [dx,dy] of [[0,0],[4,0],[-4,0],[0,4],[0,-4],[8,0],[-8,0]]){
        await canvas.click({position:{x:box.width/2+dx,y:box.height/2+dy}});
        if(await button('設定 E 構型').isVisible()){picked=true;break;}
      }
      assert(picked,'central double bond could not be selected on the rendered molecule');
      await expect(button('設定 E 構型')).toHaveAttribute('aria-pressed','true');
    });
    await step('undo and redo preserve E/Z plus new-project undo restores the molecule',async()=>{
      await button('復原').click();await selectBond(doubles(cis)[0].id);
      await expect(button('設定 Z 構型')).toHaveAttribute('aria-pressed','true');
      await button('重做').click();await selectBond(doubles(trans)[0].id);
      await expect(button('設定 E 構型')).toHaveAttribute('aria-pressed','true');
      await closeTable();await button('新建').click();await expect(button('放下第一個原子')).toBeVisible();
      await button('復原').click();await expect(page.locator('.formula-display')).toHaveText('C4H8');
      await selectBond(doubles(trans)[0].id);await expect(button('設定 E 構型')).toHaveAttribute('aria-pressed','true');
    });
    await step('JSON/MOL/SDF import and JSON/MOL/XYZ/PNG exports preserve structure and stereo',async()=>{
      await page.getByLabel('專案名稱').fill('Studio stereochemistry');
      const json=await exportBuffer(/工作專案/),mol=await exportBuffer(/三維結構/),xyz=await exportBuffer(/原子座標/),png=await exportBuffer(/模型影像/);
      assert.equal(JSON.parse(json.buffer.toString('utf8')).format,'orbital-project');
      assert(mol.buffer.toString('utf8').includes('M  END'));
      assert.equal(Number(xyz.buffer.toString('utf8').split(/\r?\n/)[0]),trans.atoms.length);
      assert.equal(png.buffer.subarray(1,4).toString(),'PNG');
      await generate('O');
      model=await apiAction(()=>page.locator('input[type=file]').setInputFiles({...json,mimeType:'application/json'}),'analyze');verifyButene(model,'E');
      await expect(page.getByLabel('專案名稱')).toHaveValue('Studio stereochemistry');
      model=await apiAction(()=>page.locator('input[type=file]').setInputFiles({...mol,mimeType:'chemical/x-mdl-molfile'}),'analyze');verifyButene(model,'E');
      model=await apiAction(()=>page.locator('input[type=file]').setInputFiles({name:'structure.sdf',mimeType:'chemical/x-mdl-sdfile',buffer:Buffer.concat([mol.buffer,Buffer.from('\n$$$$\n')])}),'analyze');verifyButene(model,'E');
      model=await apiAction(()=>page.reload({waitUntil:'domcontentloaded'}),'analyze');verifyButene(model,'E');
      await button('計算設定').click();model=await apiAction(()=>button('最佳化目前構象').click(),'optimize');verifyButene(model,'E');
    });
    await step('clearing stereo stays unspecified after reload and optimization',async()=>{
      await selectBond(doubles(model)[0].id);
      model=await apiAction(()=>button('清除雙鍵構型指定').click(),'set_stereo');
      assert.equal(doubles(model)[0].stereoControl.current,'unspecified');
      model=await apiAction(()=>page.reload({waitUntil:'domcontentloaded'}),'analyze');assert.equal(doubles(model)[0].stereoControl.current,'unspecified');
      await button('計算設定').click();model=await apiAction(()=>button('最佳化目前構象').click(),'optimize');assert.equal(doubles(model)[0].stereoControl.current,'unspecified');
    });
    await step('incomplete and invalid input explain the problem without changing the existing 3D model',async()=>{
      const before=await page.evaluate(()=>localStorage.getItem('orbital-v1-session'));
      await input();await page.getByLabel('SMILES 分子輸入').fill('CC(');
      await expect(page.locator('.structure-input')).toHaveAttribute('data-preview-state','invalid');
      await expect(page.locator('.si-preview-status')).toContainText(/支鏈|括號/);await expect(button('生成三維結構')).toBeDisabled();
      await page.getByLabel('SMILES 分子輸入').fill('C(C)(C)(C)(C)C');
      await expect(page.locator('.structure-input')).toHaveAttribute('data-preview-state','invalid');await expect(button('生成三維結構')).toBeDisabled();
      await expect(page.getByLabel('SMILES 分子輸入')).toHaveValue('C(C)(C)(C)(C)C');
      assert.equal(await page.evaluate(()=>localStorage.getItem('orbital-v1-session')),before);
      await screenshot('studio-input-invalid.png');await button('關閉結構輸入').click();
    });
    await step('symbol tools construct branched input with live 2D, undo and redo without typing syntax',async()=>{
      await input();await button('清除輸入').click();
      await button('插入碳元素').click();await button('插入碳元素').click();await button('新增支鏈').click();await button('插入氧元素').click();await button('回到主鏈').click();await button('插入碳元素').click();
      await expect(page.getByLabel('SMILES 分子輸入')).toHaveValue('CC(O)C');
      await expect(page.locator('.structure-input')).toHaveAttribute('data-preview-state','valid');await expect(page.locator('.si-svg svg')).toBeVisible();
      await button('復原輸入').click();await expect(page.getByLabel('SMILES 分子輸入')).toHaveValue('CC(O)');
      await button('重做輸入').click();await expect(page.getByLabel('SMILES 分子輸入')).toHaveValue('CC(O)C');
      await expect(page.locator('.structure-input')).toHaveAttribute('data-preview-state','valid');
      await expect(button('生成三維結構')).toBeEnabled();
      await button('關閉結構輸入').focus();await page.keyboard.press('Shift+Tab');await expect(button('生成三維結構')).toBeFocused();
      await page.keyboard.press('Tab');await expect(button('關閉結構輸入')).toBeFocused();
      await screenshot('studio-input.png');await page.getByLabel('SMILES 分子輸入').focus();model=await apiAction(()=>page.keyboard.press('Control+Enter'));assert.equal(model.formula,'C3H8O');
    });
    await step('live preview follows the latest input and generating uses that same structure',async()=>{
      await input();const field=page.getByLabel('SMILES 分子輸入',{exact:true});
      await field.fill('CCCCCCCCCC');await field.fill('O');await field.fill('N');
      await expect(page.locator('.structure-input')).toHaveAttribute('data-preview-state','valid');
      await expect(page.locator('.si-preview-status')).toContainText('NH3');
      model=await apiAction(()=>button('生成三維結構').click());assert.equal(model.formula,'H3N');assert.equal(heavy(model)[0].element,'N');
    });
    await step('ring tools insert paired closures and immediate preview matches the ring',async()=>{
      await input();await button('清除輸入').click();await button('插入碳元素').click();await button('標記環起點').click();
      for(let i=0;i<5;i++)await button('插入碳元素').click();await button('閉合環 1').click();
      await expect(page.getByLabel('SMILES 分子輸入')).toHaveValue('C1CCCCC1');await expect(page.locator('.structure-input')).toHaveAttribute('data-preview-state','valid');
      model=await apiAction(()=>button('生成三維結構').click());assert.equal(model.formula,'C6H12');assert(heavyBonds(model).every(b=>b.inRing));
    });
    await step('atom replacement and charge editing, followed by deletion, remain available',async()=>{
      model=await generate('CCO');await mode('選取');await selectAtom(model.atoms.find(a=>a.element==='O').id);
      await page.getByLabel('替換元素',{exact:true}).selectOption('N');await button('增加電荷').click();
      model=await apiAction(()=>button('套用原子變更').click());assert.equal(model.formula,'C2H8N+');assert.equal(model.charge,1);
      model=await apiAction(()=>page.locator('.delete-button').filter({hasText:'刪除原子'}).click());assert.equal(model.formula,'C2H6');
    });
    await step('third bond order is available and ring-closing connection needs only the second atom',async()=>{
      const bond=heavyBonds(model)[0];await selectBond(bond.id);model=await apiAction(()=>page.locator('.inspector').getByRole('button',{name:'三鍵',exact:true}).click());assert.equal(model.formula,'C2H2');assert.equal(heavyBonds(model)[0].rotatable,false);
      model=await generate('CCCCCC');const bonds=heavyBonds(model),ends=heavy(model).filter(a=>bonds.filter(b=>b.a===a.id||b.b===a.id).length===1);
      await mode('成鍵');await selectAtom(ends[0].id);model=await apiAction(()=>selectAtom(ends[1].id));assert.equal(model.formula,'C6H12');assert(heavyBonds(model).every(b=>b.inRing));
      await selectBond(heavyBonds(model)[0].id);model=await apiAction(()=>page.locator('.delete-button').filter({hasText:'刪除化學鍵'}).click());assert.equal(model.formula,'C6H14');assert(heavyBonds(model).every(b=>!b.inRing));
    });
    await step('single-bond rotation changes actual torsion while retaining every bond length',async()=>{
      const original=await generate('CCCC'),bonds=heavyBonds(original),degree=id=>bonds.filter(b=>b.a===id||b.b===id).length,middle=bonds.find(b=>degree(b.a)===2&&degree(b.b)===2);
      const outer=id=>{const b=bonds.find(b=>b.id!==middle.id&&(b.a===id||b.b===id));return b.a===id?b.b:b.a;};const ids=[outer(middle.a),middle.a,middle.b,outer(middle.b)];
      await selectBond(middle.id);await page.getByLabel('鍵旋轉角度').fill('60');model=await apiAction(()=>button('旋轉').click(),'rotate');
      const delta=((dihedral(model,ids)-dihedral(original,ids)+540)%360)-180;assert(Math.abs(Math.abs(delta)-60)<.03,`rotation delta ${delta}`);
      for(const b of model.bonds)assert(Math.abs(b.length-original.bonds.find(x=>x.id===b.id).length)<.001);
    });
    await step('imported atom ordering keeps the chosen carbon bond selected after rotation',async()=>{
      const project=path.resolve(__dirname,'..');
      const fixture=execFileSync(path.join(project,'runtime','python.exe'),['-c',[
        'from chemistry import process',
        'from rdkit import Chem',
        "base=process({'action':'generate','smiles':'CCCC','samples':1})",
        "mol=Chem.MolFromMolBlock(base['molblock'],removeHs=False)",
        'first=[4,0,5,1,6,2,7,3]',
        'order=first+[i for i in range(mol.GetNumAtoms()) if i not in first]',
        'print(Chem.MolToMolBlock(Chem.RenumberAtoms(mol,order)))',
      ].join('\n')],{cwd:project});
      model=await apiAction(()=>page.locator('input[type=file]').setInputFiles({name:'interleaved-atoms.mol',mimeType:'chemical/x-mdl-molfile',buffer:fixture}),'analyze');
      assert.deepEqual(model.graph.atoms.map(a=>a.id),[1,3,5,7]);
      const chosen=heavyBonds(model)[0];await selectBond(chosen.id);
      const title=await page.locator('.bond-title').textContent();
      model=await apiAction(()=>button('旋轉').click(),'rotate');
      assert.deepEqual([model.bonds.find(b=>b.id===chosen.id).a,model.bonds.find(b=>b.id===chosen.id).b],[chosen.a,chosen.b]);
      await expect(page.locator('.bond-title')).toHaveText(title);
      await expect(page.locator('.rotation-status')).toContainText('可旋轉單鍵');
      await expect(page.getByLabel('鍵旋轉角度')).toBeVisible();
    });
    await step('two, three and four atom measurements update with selected identifiers',async()=>{
      await mode('量測');const ids=heavy(model).map(a=>a.id);await selectAtom(ids[0]);await selectAtom(ids[1]);await expect(page.locator('.measurement-value')).toContainText(/距離.*Å/);
      await selectAtom(ids[2]);await expect(page.locator('.measurement-value')).toContainText(/鍵角.*°/);await selectAtom(ids[3]);await expect(page.locator('.measurement-value')).toContainText(dihedral(model,ids).toFixed(2));
      await button('清除量測').click();await expect(page.locator('.measurement-value')).toContainText('2–4');
    });
    await step('invalid E/Z cases are unavailable and general alkenes use proper E/Z labels',async()=>{
      for(const smiles of ['C=CC','CC(C)=CC','C1=CCCCC1']){model=await generate(smiles);const b=doubles(model)[0];assert.equal(b.stereoControl.editable,false);await selectBond(b.id);await expect(button('設定 Z 構型')).toHaveCount(0);await expect(page.locator('.stereo-control')).toContainText(b.stereoControl.reason);}
      model=await generate('CC(Cl)=C(Br)C');await selectBond(doubles(model)[0].id);await expect(button('設定 Z 構型')).not.toContainText(/順式|反式/);model=await setStereo('Z');assert.equal(doubles(model)[0].stereoControl.current,'Z');
    });
    await step('editing one E/Z bond preserves the other double bond and remote chiral center',async()=>{
      const original=await generate('C[C@H](F)C/C=C/C/C=C/C'),bonds=doubles(original),target=bonds[0],other=bonds[1];await selectBond(target.id);
      const desired=target.stereoControl.current==='E'?'Z':'E';model=await setStereo(desired);
      assert.equal(bondBetween(model,target.a,target.b).stereoControl.current,desired);assert.equal(bondBetween(model,other.a,other.b).stereoControl.current,other.stereoControl.current);assert.deepEqual(model.stereoSummary.centers,original.stereoSummary.centers);
    });
    await step('conformer search and switching retain all candidates and calculation controls',async()=>{
      model=await generate('CCCCCCC');await button('計算設定').click();
      for(const value of ['1','8','16','32'])await expect(page.getByLabel('候選構象數').locator(`option[value="${value}"]`)).toHaveCount(1);
      await page.getByLabel('候選構象數').selectOption('16');model=await apiAction(()=>button('搜尋並最佳化').click());const count=model.conformers.length;assert(count>1);
      await expect(page.locator('.conformer-list button')).toHaveCount(count);await apiAction(()=>page.locator('.conformer-list button').nth(1).click(),'analyze');await expect(page.locator('.conformer-list button')).toHaveCount(count);await expect(page.locator('.conformer-list button').nth(1)).toHaveAttribute('aria-pressed','true');
      await apiAction(()=>page.locator('.conformer-list button').nth(0).click(),'analyze');await expect(page.locator('.conformer-list button')).toHaveCount(count);
    });
    await step('all representations, display layers, camera presets and info remain available',async()=>{
      await button('顯示設定').click();for(const name of ['空間填充','細棒模型','球棍模型']){const option=page.locator('.representation-options button').filter({hasText:name});await option.click();await expect(option).toHaveAttribute('aria-pressed','true');}
      for(const name of ['氫原子','孤電子對','π 軌域示意','原子標籤']){const item=page.getByLabel(name,{exact:true}),old=await item.isChecked();await item.setChecked(!old);await expect(item).toBeChecked({checked:!old});await item.setChecked(old);}
      for(const name of ['正視','俯視','側視','置中模型'])await button(name).click();
      await button('分子資訊').click();await expect(page.locator('.inspector')).toContainText('分子量');await expect(page.locator('.inspector')).toContainText('孤電子對');await page.locator('.inspector details').filter({hasText:'計算方法與注意事項'}).locator('summary').click();await expect(page.locator('.inspector')).toContainText(/ETKDG|MMFF|UFF/);
      await closePanel();await button('方法與使用說明').click();await expect(page.getByRole('dialog')).toContainText('適用範圍');await button('關閉說明').click();
    });
    await step('large text persists and 1440/1024/390px layouts remain usable without overflow',async()=>{
      model=await generate('CC=CC');await selectBond(doubles(model)[0].id);model=await setStereo('Z');await closeTable();await closePanel();
      await screenshot('studio-main.png');
      await page.setViewportSize({width:1024,height:900});await assertNoOverflow();await screenshot('studio-tablet.png');
      await button('顯示設定').click();await page.getByLabel('介面字級').selectOption('1.25');await page.setViewportSize({width:390,height:844});await assertNoOverflow();
      model=await apiAction(()=>page.reload({waitUntil:'domcontentloaded'}),'analyze');await expect(page.locator('[data-ui-scale]')).toHaveAttribute('data-ui-scale','1.25');
      await selectBond(doubles(model)[0].id);await button('設定 E 構型').scrollIntoViewIfNeeded();model=await setStereo('E');verifyButene(model,'E');await closeTable();await assertNoOverflow();await screenshot('studio-mobile.png');
      await button('分子資訊').click();await page.getByLabel('資訊面板專案名稱',{exact:true}).fill('手機順反構型');
      await page.waitForFunction(()=>JSON.parse(localStorage.getItem('orbital-v1-session')||'null')?.name==='手機順反構型');
      model=await apiAction(()=>page.reload({waitUntil:'domcontentloaded'}),'analyze');await button('分子資訊').click();await expect(page.getByLabel('資訊面板專案名稱',{exact:true})).toHaveValue('手機順反構型');await closePanel();
      await input();await expect(page.locator('.structure-input')).toHaveAttribute('data-preview-state','valid');await assertNoOverflow();await screenshot('studio-input-mobile.png');await button('關閉結構輸入').click();
      await page.setViewportSize({width:1440,height:1000});await button('顯示設定').click();await page.getByLabel('介面字級').selectOption('1');await closePanel();
    });
    await step('failed session restoration preserves the saved project for a later retry',async()=>{
      const recoveryContext=await browser.newContext({viewport:{width:1024,height:900}});
      const saved=JSON.stringify({name:'Saved recovery structure',molblock:model.molblock,graph:model.graph});
      try{
        await recoveryContext.addInitScript(value=>{
          if(!sessionStorage.getItem('recovery-fixture-loaded')){
            localStorage.setItem('orbital-v1-session',value);
            sessionStorage.setItem('recovery-fixture-loaded','1');
          }
        },saved);
        const recovery=await recoveryContext.newPage();
        await recovery.route('**/api/molecule',route=>route.abort('failed'));
        await recovery.goto(URL,{waitUntil:'domcontentloaded'});
        await expect(recovery.getByRole('alert')).toBeVisible();
        await recovery.waitForTimeout(300);
        assert.equal(await recovery.evaluate(()=>localStorage.getItem('orbital-v1-session')),saved);
        await recovery.unroute('**/api/molecule');
        await recovery.reload({waitUntil:'domcontentloaded'});
        await expect(recovery.locator('.formula-display')).toHaveText(model.formula);
        await expect(recovery.getByLabel('專案名稱')).toHaveValue('Saved recovery structure');
      }finally{await recoveryContext.close();}
    });
    await step('browser runtime has no uncaught errors',async()=>assert.deepEqual(errors,[]));
    console.log(JSON.stringify({total:results.length,passed:results.filter(r=>r.pass).length,results,errors},null,2));
  } finally {
    if(process.env.ORBITAL_SCREENSHOT_DIR) {
      fs.mkdirSync(process.env.ORBITAL_SCREENSHOT_DIR,{recursive:true});
      fs.writeFileSync(path.join(process.env.ORBITAL_SCREENSHOT_DIR,'studio-report.json'),JSON.stringify({total:results.length,passed:results.filter(r=>r.pass).length,results,errors},null,2));
    }
    await browser.close();
  }
}
main().catch(error => {console.error(error);process.exitCode=1;});
