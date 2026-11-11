import test from 'node:test';
import assert from 'node:assert/strict';
import {CHEMISTRY_EXAMPLES, elementInput, exampleMatches, hybridizationLabel} from '../src/chemistryExamples.js';

test('plain text chemical formula searches include charge and return structural isomers separately',()=>{
  const find=query=>CHEMISTRY_EXAMPLES.filter(item=>exampleMatches(item,query)).map(item=>item.name);
  assert.deepEqual(find('NH4+'),['銨離子']);
  assert.deepEqual(find('SO4^2-'),['硫酸根']);
  assert.deepEqual(find('C2H6O').sort(),['乙醇','二甲醚'].sort());
});

test('element palette inserts bracket-only atoms and isolated ion charges as valid SMILES syntax',()=>{
  assert.equal(elementInput('Si'),'[Si]');
  assert.equal(elementInput('Xe'),'[Xe]');
  assert.equal(elementInput('Mg'),'[Mg+2]');
  assert.equal(elementInput('Cl'),'Cl');
});

test('high coordination software types do not imply measured d hybridization',()=>{
  assert.equal(hybridizationLabel({hybridization:'SP3D2'}),'未指定雜化');
  assert.equal(hybridizationLabel({hybridization:'SP2'}),'sp² · 局域模型');
});
