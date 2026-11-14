import test from 'node:test';
import assert from 'node:assert/strict';
import {appendGraphAtom, editableBond, replaceAtom, touchGraph} from '../src/graphEditing.js';

test('changing just the hydrogen policy preserves tetrahedral and alkene descriptors', () => {
  const graph={atoms:[{id:0,element:'C',charge:0,chiralTag:2,explicitHs:1,noImplicit:true}],
    bonds:[{a:0,b:1,stereo:3,stereoAtoms:[2,3],bondDir:4}]};
  const bonds=structuredClone(graph.bonds);
  replaceAtom(graph,0,'C',0,'auto');
  assert.equal(graph.atoms[0].chiralTag,2);
  assert.deepEqual(graph.bonds,bonds);
  assert.equal(graph.atoms[0].noImplicit,false);
  replaceAtom(graph,0,'C',0,'1');
  assert.equal(graph.atoms[0].chiralTag,2);
  assert.deepEqual(graph.bonds,bonds);
});

test('a new draft bond preserves the last validated graph and supports noncontiguous IDs', () => {
  const saved={atoms:[{id:2,element:'P'},{id:4,element:'F'}],bonds:[{a:2,b:4,order:1}]};
  const before=structuredClone(saved);
  const draft=appendGraphAtom(saved,2,'F',1);
  assert.deepEqual(saved,before);
  assert.deepEqual(draft.atoms.at(-1),{id:5,element:'F',charge:0});
  assert.deepEqual(draft.bonds.at(-1),{a:2,b:5,order:1});
  assert.throws(()=>appendGraphAtom(saved,99,'F',1),/連接原子/);
});

test('replacing labelled carbon does not create an unintended isotope of another element', () => {
  const graph = {atoms:[{id:7,element:'C',isotope:13,charge:0,explicitHs:4,noImplicit:true}],bonds:[]};
  replaceAtom(graph,7,'N',1);
  assert.equal(graph.atoms[0].element,'N');
  assert.equal(graph.atoms[0].isotope,0);
  assert.equal(graph.atoms[0].charge,1);
  assert.equal(graph.atoms[0].explicitHs,0);
  assert.equal(graph.atoms[0].noImplicit,false);
});

test('a charge-only edit preserves the isotope', () => {
  const graph = {atoms:[{id:2,element:'N',isotope:15,charge:0}],bonds:[]};
  replaceAtom(graph,2,'N',1);
  assert.equal(graph.atoms[0].isotope,15);
});

test('changing a bond on a bracket oxygen never turns implicit hydrogens back on', () => {
  const graph = {atoms:[{id:0,element:'O',charge:-1,explicitHs:0,noImplicit:true}],bonds:[]};
  touchGraph(graph,[0]);
  assert.equal(graph.atoms[0].noImplicit,true);
  assert.equal(graph.atoms[0].explicitHs,0);
});

test('explicit hydrogen policy survives charge-only edits and only an explicit auto selection releases it', () => {
  const graph = {atoms:[{id:3,element:'O',charge:0,explicitHs:2,noImplicit:true,isotope:18}],bonds:[]};
  replaceAtom(graph,3,'O',1);
  assert.equal(graph.atoms[0].explicitHs,2);
  assert.equal(graph.atoms[0].noImplicit,true);
  replaceAtom(graph,3,'O',1,'3');
  assert.equal(graph.atoms[0].explicitHs,3);
  assert.equal(graph.atoms[0].noImplicit,true);
  replaceAtom(graph,3,'O',-1,'0');
  assert.equal(graph.atoms[0].explicitHs,0);
  assert.equal(graph.atoms[0].noImplicit,true);
  replaceAtom(graph,3,'O',-1,'auto');
  assert.equal(graph.atoms[0].noImplicit,false);
  assert.equal(graph.atoms[0].isotope,18);
});

test('auto-added hydrogen bonds reject editing instead of crashing or reporting a no-op success', () => {
  const graph = {atoms:[{id:0,element:'C'},{id:3,element:'O'}],bonds:[{a:0,b:3,order:1}]};
  const before=structuredClone(graph);
  assert.throws(()=>editableBond(graph,[0,5]),/氫原子依價態自動補足/);
  assert.deepEqual(graph,before);
  assert.equal(editableBond(graph,[3,0]),graph.bonds[0]);
});

test('explicit isotope hydrogen atoms remain represented and unaffected by editing another site', () => {
  const graph={atoms:[{id:0,element:'C',explicitHs:2,chiralTag:1},{id:1,element:'H',isotope:2},{id:3,element:'C',chiralTag:2}],bonds:[{a:0,b:1,order:1},{a:0,b:3,order:1}]};
  touchGraph(graph,[0],1);
  assert.equal(graph.atoms[0].explicitHs,1);
  assert.equal(graph.atoms[0].chiralTag,undefined);
  assert.equal(graph.atoms[1].isotope,2);
  assert.equal(graph.atoms[2].chiralTag,2);
  assert.equal(editableBond(graph,[0,1]).order,1);
});
