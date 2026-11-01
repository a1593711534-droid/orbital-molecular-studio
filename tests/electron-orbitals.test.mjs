import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {alignedPiOrbitals} from '../src/electronGeometry.js';

function fixture(points,bonds,atoms=[]) {
  const positions=new Map(points.map((p,id)=>[id,new THREE.Vector3(...p)]));
  const neighbors=new Map(points.map((_,id)=>[id,[]]));
  bonds.forEach(b=>{neighbors.get(b.a).push(b.b);neighbors.get(b.b).push(b.a);});
  return {positions,neighbors,bonds,atoms};
}
const orbitals=f=>alignedPiOrbitals(f.bonds,f.positions,f.neighbors,f.atoms);
const parallel=(a,b)=>Math.abs(a.dot(b))>1-1e-8;
function formic() {
  // NIST CCCBDB formic-acid experimental planar coordinates, in angstrom.
  // Atom order here: C, carbonyl O, hydroxyl O, C-H, O-H.
  return fixture([[0,.422,0],[1.1587,.1022,0],[-1.0338,-.4353,0],[-.3512,1.4612,0],[-.6482,-1.3276,0]],
    [{a:0,b:1,order:2,conjugated:true},{a:0,b:2,order:1,conjugated:true},{a:0,b:3,order:1},{a:2,b:4,order:1}],
    [{id:0,lonePairs:[]},{id:1,lonePairs:[{kind:'localized',direction:[1,1,0]},{kind:'localized',direction:[1,-1,0]}]},
      {id:2,lonePairs:[{kind:'delocalized',direction:[0,0,-1]},{kind:'localized',direction:[-1,0,0]}]}]);
}

test('formic acid includes the hydroxyl donor p orbital as well as carbonyl C and O',()=>{
  const result=orbitals(formic());
  assert.equal(result.length,3);
  assert.deepEqual(result.map(r=>r.atomId).sort(),[0,1,2]);
  for(const r of result)assert(Math.abs(r.direction.length()-1)<1e-8);
});

test('hydroxyl donor p axis is perpendicular to both sigma bonds and parallel to the planar carbonyl p axes',()=>{
  const f=formic(),result=orbitals(f),donor=result.find(r=>r.atomId===2);
  for(const neighbor of [0,4]){
    const bond=f.positions.get(neighbor).clone().sub(f.positions.get(2)).normalize();
    assert(Math.abs(donor.direction.dot(bond))<1e-8);
  }
  for(const r of result)assert(parallel(donor.direction,r.direction));
});

test('rotating the hydroxyl group retains its own p axis instead of forcing false conjugated alignment',()=>{
  const f=formic();
  const axis=f.positions.get(0).clone().sub(f.positions.get(2)).normalize();
  const rotation=new THREE.Quaternion().setFromAxisAngle(axis,Math.PI/2);
  const center=f.positions.get(2),hydrogen=f.positions.get(4).clone().sub(center).applyQuaternion(rotation).add(center);
  f.positions.set(4,hydrogen);
  const expected=new THREE.Vector3(0,0,-1).applyQuaternion(rotation).normalize();
  f.atoms.find(a=>a.id===2).lonePairs[0].direction=expected.toArray();
  const result=orbitals(f),donor=result.find(r=>r.atomId===2),carbonyl=result.find(r=>r.atomId===0);
  assert(parallel(donor.direction,expected));
  assert(Math.abs(donor.direction.dot(carbonyl.direction))<1e-8);
  assert(Math.abs(donor.direction.dot(hydrogen.clone().sub(center).normalize()))<1e-8);
});

test('water and an alcohol with localized lone pairs do not acquire fictional p orbitals',()=>{
  for(const f of [
    fixture([[0,0,0],[.75,.6,0],[-.75,.6,0]],[{a:0,b:1,order:1},{a:0,b:2,order:1}],
      [{id:0,lonePairs:[{kind:'localized',direction:[0,-.6,.8]},{kind:'localized',direction:[0,-.6,-.8]}]}]),
    fixture([[0,0,0],[1.5,0,0],[2.2,1,.2],[2.8,1,.9]],[{a:0,b:1,order:1},{a:1,b:2,order:1},{a:2,b:3,order:1}],
      [{id:2,lonePairs:[{kind:'localized',direction:[0,1,-1]},{kind:'localized',direction:[1,-1,0]}]}]),
  ]) assert.equal(orbitals(f).length,0);
});

test('a triple bond retains two perpendicular p components at each endpoint',()=>{
  const f=fixture([[0,0,0],[1.16,0,0],[-1.06,0,0]],[{a:0,b:1,order:3},{a:0,b:2,order:1}],
    [{id:1,lonePairs:[{kind:'localized',direction:[1,0,0]}]}]);
  const result=orbitals(f);
  assert.equal(result.length,4);
  for(const id of [0,1]){
    const pair=result.filter(r=>r.atomId===id);assert.equal(pair.length,2);
    assert(Math.abs(pair[0].direction.dot(pair[1].direction))<1e-8);
    for(const r of pair)assert(Math.abs(r.direction.x)<1e-8);
  }
});

test('an aromatic donor does not receive duplicate overlapping p orbitals',()=>{
  const points=Array.from({length:5},(_,i)=>[Math.cos(i*2*Math.PI/5),Math.sin(i*2*Math.PI/5),0]);
  const bonds=points.map((_,i)=>({a:i,b:(i+1)%5,order:1.5,aromatic:true,conjugated:true}));
  const f=fixture(points,bonds,[{id:0,lonePairs:[{kind:'delocalized',direction:[0,0,1]}]}]);
  const result=orbitals(f);assert.equal(result.length,5);
  for(const id of [0,1,2,3,4])assert.equal(result.filter(r=>r.atomId===id).length,1);
});
