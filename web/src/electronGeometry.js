import * as THREE from 'three';

export function safePerpendicular(axis) {
  const ref = Math.abs(axis.y) < .8 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  return new THREE.Vector3().crossVectors(axis, ref).normalize();
}

export function planeNormal(atom, other, positions, neighbors) {
  const axis = positions.get(other).clone().sub(positions.get(atom)).normalize();
  for (const n of neighbors.get(atom) || []) {
    if (n === other) continue;
    const delta = positions.get(n).clone().sub(positions.get(atom)).normalize();
    const cross = new THREE.Vector3().crossVectors(axis, delta);
    if (cross.lengthSq() > .015) return cross.normalize();
  }
  for (const n of neighbors.get(other) || []) {
    if (n === atom) continue;
    const delta = positions.get(n).clone().sub(positions.get(other)).normalize();
    const cross = new THREE.Vector3().crossVectors(axis, delta);
    if (cross.lengthSq() > .015) return cross.normalize();
  }
  return safePerpendicular(axis);
}

// Each p axis is geometric. Align its otherwise arbitrary sign across adjacent
// parallel orbitals before choosing lobe colors; these are not calculated MOs.
// Keeping separate orthogonal records also handles triple bonds and cumulenes.
export function alignedPiOrbitals(bonds, positions, neighbors, atoms = []) {
  const records = [], byAtom = new Map();
  for (const bond of bonds) {
    if (!(bond.order >= 2 || bond.aromatic) || !positions.has(bond.a) || !positions.has(bond.b)) continue;
    const axis = positions.get(bond.b).clone().sub(positions.get(bond.a)).normalize();
    const normal = planeNormal(bond.a, bond.b, positions, neighbors);
    const directions = bond.order === 3 ? [normal, new THREE.Vector3().crossVectors(axis, normal).normalize()] : [normal];
    for (const atomId of [bond.a, bond.b]) {
      const existing = byAtom.get(atomId) || [];
      for (const direction of directions) {
        if (existing.some((index) => Math.abs(records[index].direction.dot(direction)) > .94)) continue;
        existing.push(records.length);
        records.push({ atomId, direction: direction.clone(), adjacent: new Set() });
      }
      byAtom.set(atomId, existing);
    }
  }
  // A donor lone pair (e.g. the OH oxygen in a carboxyl group) supplies a p
  // axis even though that atom has no formal double bond. Preserve its actual
  // local axis when the sigma bond is twisted; only phase signs are aligned.
  for (const atom of atoms) {
    if (!positions.has(atom.id)) continue;
    for (const pair of atom.lonePairs || []) {
      if (pair.kind !== 'delocalized' || !Array.isArray(pair.direction) || pair.direction.length !== 3 || !pair.direction.every(Number.isFinite)) continue;
      const direction = new THREE.Vector3(...pair.direction);
      if (direction.lengthSq() < 1e-10) continue;
      direction.normalize();
      const existing = byAtom.get(atom.id) || [];
      if (existing.some(index => Math.abs(records[index].direction.dot(direction)) > .94)) continue;
      existing.push(records.length);
      records.push({ atomId: atom.id, direction, adjacent: new Set() });
      byAtom.set(atom.id, existing);
    }
  }
  for (const bond of bonds) {
    if (!(bond.order >= 2 || bond.aromatic || bond.conjugated)) continue;
    const a = byAtom.get(bond.a) || [], b = byAtom.get(bond.b) || [];
    // Match both orthogonal components of a triple bond independently. At an
    // orthogonal conjugated junction there is no defined overlap to sign-align.
    for (const [first, second] of [[a, b], [b, a]]) {
      for (const i of first) {
        let best = -1, overlap = .50;
        for (const j of second) {
          const dot = Math.abs(records[i].direction.dot(records[j].direction));
          if (dot > overlap) { overlap = dot; best = j; }
        }
        if (best !== -1) { records[i].adjacent.add(best); records[best].adjacent.add(i); }
      }
    }
  }
  const visited = new Set();
  for (let seed = 0; seed < records.length; seed++) {
    if (visited.has(seed)) continue;
    const seedDirection = records[seed].direction;
    const coordinates = seedDirection.toArray();
    const dominant = coordinates.reduce((best, value, i) => Math.abs(value) > Math.abs(coordinates[best]) ? i : best, 0);
    if (coordinates[dominant] < 0) seedDirection.negate();
    const queue = [seed]; visited.add(seed);
    for (let q = 0; q < queue.length; q++) {
      const i = queue[q];
      for (const j of records[i].adjacent) {
        if (visited.has(j)) continue;
        if (records[i].direction.dot(records[j].direction) < 0) records[j].direction.negate();
        visited.add(j); queue.push(j);
      }
    }
  }
  return records;
}

// Rendering a Lewis contributor must never rewrite the editable molecule or
// its coordinates. Hybrid orders below are drawing conventions, not force-field
// bond orders or a quantum-mechanical population analysis.
export function electronicPresentation(model, view = 'hybrid', stateIndex = null) {
  const states = model?.resonance?.states || [];
  const requested = stateIndex ?? model?.resonance?.inputFormStateIndex ?? 0;
  const state = states[Math.max(0, Math.min(states.length - 1, requested))];
  const hybridOrders = new Map();
  if (view === 'hybrid') for (const group of model?.resonance?.equivalentBondGroups || []) {
    if (!Number.isFinite(group.order) || group.order <= 1 || group.order >= 3) continue;
    for (const id of group.bondIds || []) hybridOrders.set(id, group.order);
  }
  const charges = new Map(), pairCounts = new Map(), bondOrders = new Map();
  for (const atom of model?.atoms || []) {
    charges.set(atom.id, view === 'lewis' && Number.isFinite(state?.atomCharges?.[atom.id]) ? state.atomCharges[atom.id] : atom.charge);
    pairCounts.set(atom.id, view === 'lewis' && Number.isFinite(state?.lonePairCounts?.[atom.id]) ? state.lonePairCounts[atom.id] : (atom.lonePairs || []).length);
  }
  for (const bond of model?.bonds || []) {
    const lewisOrder = state?.bondOrders?.[bond.id];
    const order = view === 'lewis' && Number.isFinite(lewisOrder) ? lewisOrder : hybridOrders.get(bond.id) ?? (bond.aromatic ? 1.5 : bond.order);
    bondOrders.set(bond.id, order);
  }
  return { charges, pairCounts, bondOrders, hybridOrders };
}

export function displayedLonePairs(atom, count, view, positions, neighbors) {
  const pairs = (atom.lonePairs || []).filter(pair => Array.isArray(pair.direction) && pair.direction.length === 3 && pair.direction.every(Number.isFinite)).map(pair => ({ ...pair, direction: [...pair.direction] }));
  count = Number.isInteger(count) ? Math.max(0, Math.min(count, 4)) : pairs.length;
  if (view !== 'lewis') return pairs.filter(pair => pair.kind !== 'delocalized');
  // Exchanging terminal atoms in an equivalent contributor transfers the
  // formal p lone pair, while retaining the two in-plane directions.
  const local = pairs.filter(pair => pair.kind !== 'delocalized');
  const donor = pairs.filter(pair => pair.kind === 'delocalized');
  const result = [...local, ...donor].slice(0, count);
  if (result.length < count) {
    const neighbor = (neighbors.get(atom.id) || [])[0];
    const direction = neighbor === undefined ? new THREE.Vector3(0, 0, 1) : planeNormal(atom.id, neighbor, positions, neighbors);
    result.push({ kind: 'delocalized', direction: direction.toArray() });
  }
  return result.slice(0, count);
}

