import test from 'node:test';
import assert from 'node:assert/strict';
import {editableBond, replaceAtom, touchGraph} from '../src/graphEditing.js';

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
