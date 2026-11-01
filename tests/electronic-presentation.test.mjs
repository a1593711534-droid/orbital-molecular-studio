import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { electronicPresentation, displayedLonePairs } from '../src/electronGeometry.js';
import { createTapTracker } from '../src/sceneInteraction.js';

const pair = (direction, kind = 'localized') => ({ direction, kind });
function ozone() {
  return {
    atoms: [
      { id: 0, charge: 0, position: [-1,0,0], lonePairs: [pair([-1,1,0]), pair([-1,-1,0])] },
      { id: 1, charge: 1, position: [0,.7,0], lonePairs: [pair([0,1,0])] },
      { id: 2, charge: -1, position: [1,0,0], lonePairs: [pair([0,0,1],'delocalized'),pair([1,1,0]),pair([1,-1,0])] },
    ],
    bonds: [{ id: 0, a: 0, b: 1, order: 2, conjugated: true }, { id: 1, a: 1, b: 2, order: 1, conjugated: true }],
    resonance: { inputFormStateIndex: 0,
      equivalentBondGroups: [{ bondIds: [0,1], atomIds: [0,1,2], order: 1.5 }],
      groups: [{ id: 0, atomIds: [0,1,2], bondIds: [0,1], piElectrons: 4 }],
      states: [
        { atomCharges: [0,1,-1], bondOrders: [2,1], lonePairCounts: [2,1,3] },
        { atomCharges: [-1,1,0], bondOrders: [1,2], lonePairCounts: [3,1,2] },
      ],
    },
  };
}
function geometry(model) {
  const positions = new Map(model.atoms.map(atom => [atom.id, new THREE.Vector3(...atom.position)]));
  const neighbors = new Map(model.atoms.map(atom => [atom.id, []]));
  for (const b of model.bonds) { neighbors.get(b.a).push(b.b); neighbors.get(b.b).push(b.a); }
  return { positions, neighbors };
}

test('hybrid ozone has equivalent drawing orders without rewriting the editable Lewis graph or geometry', () => {
  const model = ozone(), before = JSON.stringify(model);
  const result = electronicPresentation(model);
  assert.deepEqual([...result.bondOrders.values()], [1.5,1.5]);
  assert.equal(JSON.stringify(model), before);
});

test('Lewis contributors swap formal charges and integral bonds, while preserving total lone-pair count', () => {
  const model = ozone(), {positions,neighbors} = geometry(model);
  for (let index = 0; index < 2; index++) {
    const result = electronicPresentation(model,'lewis',index);
    assert.deepEqual([...result.bondOrders.values()], model.resonance.states[index].bondOrders);
    assert.deepEqual([...result.charges.values()], model.resonance.states[index].atomCharges);
    const pairs = model.atoms.map(atom => displayedLonePairs(atom,result.pairCounts.get(atom.id),'lewis',positions,neighbors));
    assert.equal(pairs.flat().length,6);
    assert.deepEqual(pairs.map(list=>list.length), model.resonance.states[index].lonePairCounts);
    assert.equal(pairs.flat().filter(p=>p.kind==='delocalized').length,1);
  }
});

test('hybrid ozone counts the donor within the pi system, leaving symmetric terminal local pairs', () => {
  const model = ozone(), {positions,neighbors} = geometry(model);
  const pairs = model.atoms.map(atom=>displayedLonePairs(atom,atom.lonePairs.length,'hybrid',positions,neighbors));
  assert.deepEqual(pairs.map(list=>list.length),[2,1,2]);
  assert.equal(model.resonance.groups[0].piElectrons,4);
});

test('unequal carboxylic-acid C=O and C-O bonds are not made equivalent just because conjugation exists', () => {
  const model = ozone(); model.resonance.equivalentBondGroups=[];
  const result = electronicPresentation(model);
  assert.deepEqual([...result.bondOrders.values()],[2,1]);
});

test('partial bonds support nitrate 4/3 drawing order, not only 1.5', () => {
  const model=ozone(); model.resonance.equivalentBondGroups[0].order=4/3;
  assert.deepEqual([...electronicPresentation(model).bondOrders.values()],[4/3,4/3]);
});

test('local lone pairs remain available without resonance metadata and malformed directions are rejected', () => {
  const atom={id:0,lonePairs:[pair([1,0,0]),pair([0,1,0]),pair([NaN,0,0])]};
  const positions=new Map([[0,new THREE.Vector3()]]),neighbors=new Map([[0,[]]]);
  assert.equal(displayedLonePairs(atom,undefined,'hybrid',positions,neighbors).length,2);
  assert.equal(displayedLonePairs(atom,0,'lewis',positions,neighbors).length,0);
});

const pointer = (pointerId,x=10,y=10,timeStamp=0,extra={}) => ({pointerId,clientX:x,clientY:y,timeStamp,button:0,...extra});
test('a single stationary primary tap is recognized', () => {
  const taps=createTapTracker(); taps.start(pointer(1));
  assert(taps.end(pointer(1,12,11,100))); assert.equal(taps.isDown,false);
});
test('pinch or two-finger pan never edits an atom on either finger release', () => {
  for (const releaseOrder of [[1,2],[2,1]]) {
    const taps=createTapTracker(); taps.start(pointer(1)); taps.start(pointer(2,30,10,10,{isPrimary:false}));
    taps.move(pointer(1,9,10,20));
    for(const id of releaseOrder) assert.equal(taps.end(pointer(id,id===1?9:30,10,30)),false);
    taps.start(pointer(3,10,10,40)); assert(taps.end(pointer(3,10,10,80)));
  }
});
test('a drag returning to its original position still does not become a tap', () => {
  const taps=createTapTracker(); taps.start(pointer(1)); taps.move(pointer(1,40,10,100)); taps.move(pointer(1,10,10,200));
  assert.equal(taps.end(pointer(1,10,10,220)),false);
});
test('right click, long press and cancelled touch never edit the molecule', () => {
  const taps=createTapTracker(); taps.start(pointer(1,10,10,0,{button:2})); assert.equal(taps.end(pointer(1,10,10,100,{button:2})),false);
  taps.start(pointer(2)); assert.equal(taps.end(pointer(2,10,10,900)),false);
  taps.start(pointer(3)); taps.cancel(pointer(3)); assert.equal(taps.end(pointer(3,10,10,50)),false);
});
