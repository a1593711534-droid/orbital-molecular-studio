import test from 'node:test';
import assert from 'node:assert/strict';
import {chemistryRequest} from '../src/chemistryClient.js';

test('hosted generation exposes chemical rejection and distinguishes service errors', async t => {
  const fetch=t.mock.method(globalThis,'fetch');
  for (const status of [422,429,503]) {
    fetch.mock.mockImplementation(async()=>Response.json({error:'計算回應'},{status}));
    await assert.rejects(chemistryRequest({action:'generate',graph:{atoms:[{id:0,element:'Xe'}],bonds:[]}},{hosted:true}),
      {message:'計算回應',status});
  }
});
