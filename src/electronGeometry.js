import * as THREE from 'three';

export function safePerpendicular(axis) {
  const ref = Math.abs(axis.y) < .8 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  return new THREE.Vector3().crossVectors(axis, ref).normalize();
}

function geometricPlaneNormal(atom, other, positions, neighbors) {
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
  return null;
}

export function planeNormal(atom, other, positions, neighbors) {
  return geometricPlaneNormal(atom, other, positions, neighbors) ||
    safePerpendicular(positions.get(other).clone().sub(positions.get(atom)).normalize());
}

// Linear cumulenes have no local plane at an internal atom. Using the same
// arbitrary normal for every double bond incorrectly collapses its two p axes.
// Propagate perpendicular axes from an end-group plane, or choose an arbitrary
// orthogonal pair for a wholly linear molecule such as CO2. This is a localized
// bonding schematic, not a calculated set of molecular orbitals.
function piBondNormals(bonds, positions, neighbors) {
  const entries = bonds.filter(b => b.order >= 2 || b.aromatic)
    .filter(b => positions.has(b.a) && positions.has(b.b))
    .map(bond => ({bond, normal: geometricPlaneNormal(bond.a, bond.b, positions, neighbors), adjacent: []}))
    .sort((a, b) => Math.min(a.bond.a, a.bond.b) - Math.min(b.bond.a, b.bond.b) || Math.max(a.bond.a, a.bond.b) - Math.max(b.bond.a, b.bond.b));
  const doubles = new Map();
  for (const entry of entries) if (entry.bond.order === 2 && !entry.bond.aromatic) {
    for (const id of [entry.bond.a, entry.bond.b]) {
      if (!doubles.has(id)) doubles.set(id, []);
      doubles.get(id).push(entry);
    }
  }
  for (const [id, pair] of doubles) {
    if (pair.length !== 2 || neighbors.get(id)?.length !== 2) continue;
    const directions = pair.map(({bond}) => positions.get(bond.a === id ? bond.b : bond.a).clone().sub(positions.get(id)).normalize());
    if (directions[0].dot(directions[1]) > -.98) continue;
    pair[0].adjacent.push(pair[1]); pair[1].adjacent.push(pair[0]);
  }
  const propagate = seed => {
    const queue = [seed];
    for (let i = 0; i < queue.length; i++) for (const next of queue[i].adjacent) {
      if (next.normal) continue;
      const axis = positions.get(next.bond.b).clone().sub(positions.get(next.bond.a)).normalize();
      next.normal = new THREE.Vector3().crossVectors(axis, queue[i].normal).normalize();
      queue.push(next);
    }
  };
  for (const entry of entries) if (entry.normal) propagate(entry);
  for (const entry of entries) if (!entry.normal) {
    entry.normal = safePerpendicular(positions.get(entry.bond.b).clone().sub(positions.get(entry.bond.a)).normalize());
    propagate(entry);
  }
  return new Map(entries.map(({bond, normal}) => [bond, normal]));
}

// Each p axis is geometric. Align its otherwise arbitrary sign across adjacent
// parallel orbitals before choosing lobe colors; these are not calculated MOs.
// Keeping separate orthogonal records also handles triple bonds and cumulenes.
export function alignedPiOrbitals(bonds, positions, neighbors, atoms = [], linearPiCenter = null) {
  if (Number.isInteger(linearPiCenter) && neighbors.get(linearPiCenter)?.length === 2) {
    const ends = neighbors.get(linearPiCenter);
    const axis = positions.get(ends[1]).clone().sub(positions.get(ends[0])).normalize();
    const normal = safePerpendicular(axis);
    const transverse = new THREE.Vector3().crossVectors(axis, normal).normalize();
    return [ends[0], linearPiCenter, ends[1]].flatMap(atomId =>
      [normal, transverse].map(direction => ({ atomId, direction: direction.clone() })));
  }
  const records = [], byAtom = new Map();
  const normals = piBondNormals(bonds, positions, neighbors);
  for (const bond of bonds) {
    if (!(bond.order >= 2 || bond.aromatic) || !positions.has(bond.a) || !positions.has(bond.b)) continue;
    const axis = positions.get(bond.b).clone().sub(positions.get(bond.a)).normalize();
    const normal = normals.get(bond);
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
  const equivalentOxygens = new Set();
  const unresolvedAtoms = new Set();
  if (view === 'hybrid') for (const group of model?.resonance?.equivalentBondGroups || []) {
    if (group.basis === 'equivalent-terminal-oxygens') {
      for (const id of group.atomIds) unresolvedAtoms.add(id);
      for (const id of group.terminalAtomIds || []) equivalentOxygens.add(id);
    }
    if (!Number.isFinite(group.order) || group.order <= 1 || group.order >= 3) continue;
    for (const id of group.bondIds || []) hybridOrders.set(id, group.order);
  }
  const charges = new Map(), pairCounts = new Map(), bondOrders = new Map();
  const linearPiBackbone = Number.isInteger(model?.resonance?.linearPiCenter);
  for (const atom of model?.atoms || []) {
    charges.set(atom.id, view === 'lewis' && Number.isFinite(state?.atomCharges?.[atom.id]) ? state.atomCharges[atom.id] : atom.charge);
    pairCounts.set(atom.id, view === 'lewis' && Number.isFinite(state?.lonePairCounts?.[atom.id]) ? state.lonePairCounts[atom.id] : (atom.lonePairs || []).length);
  }
  for (const bond of model?.bonds || []) {
    const lewisOrder = state?.bondOrders?.[bond.id];
    const hybridOrder = linearPiBackbone ? 1 : hybridOrders.get(bond.id) ?? (bond.aromatic ? 1.5 : bond.order);
    const order = view === 'lewis' && Number.isFinite(lewisOrder) ? lewisOrder : hybridOrder;
    bondOrders.set(bond.id, order);
  }
  return { charges, pairCounts, bondOrders, hybridOrders, equivalentOxygens, unresolvedAtoms };
}

export function displayedLonePairs(atom, count, view, positions, neighbors, piOrbitals = [], equivalentOxygen = false) {
  if (view === 'hybrid' && equivalentOxygen) {
    // A double-bonded terminal O has two Lewis lone pairs, a single-bonded
    // O− three. Draw the common two without choosing a localized double bond.
    const center = neighbors.get(atom.id)[0];
    const outward = positions.get(atom.id).clone().sub(positions.get(center)).normalize();
    const normal = planeNormal(atom.id, center, positions, neighbors);
    const side = new THREE.Vector3().crossVectors(outward, normal).normalize();
    return [-1, 1].map(sign => ({kind:'localized', direction:
      outward.clone().multiplyScalar(.5).addScaledVector(side, sign * Math.sqrt(3) / 2).toArray()}));
  }
  const pairs = (atom.lonePairs || []).filter(pair => Array.isArray(pair.direction) && pair.direction.length === 3 && pair.direction.every(Number.isFinite)).map(pair => ({ ...pair, direction: [...pair.direction] }));
  const localPairs = pairs.filter(pair => pair.kind !== 'delocalized');
  const axes = piOrbitals.filter(orbital => orbital.atomId === atom.id);
  // A terminal sp2 atom's two localized pair glyphs share its sigma plane.
  // Rotate that otherwise arbitrary plane with the chosen p axis (notably CO2),
  // preserving the pair count and each glyph's bond angle.
  if (atom.hybridization === 'SP2' && neighbors.get(atom.id)?.length === 1 && localPairs.length === 2 && axes.length === 1) {
    const axis = positions.get(neighbors.get(atom.id)[0]).clone().sub(positions.get(atom.id)).normalize();
    const sideways = new THREE.Vector3().crossVectors(axis, axes[0].direction).normalize();
    if (sideways.lengthSq() > .5) localPairs.forEach((pair, index) => {
      const along = Math.max(-1, Math.min(1, new THREE.Vector3(...pair.direction).normalize().dot(axis)));
      pair.direction = axis.clone().multiplyScalar(along).addScaledVector(sideways, (index ? -1 : 1) * Math.sqrt(1 - along * along)).toArray();
    });
  }
  count = Number.isInteger(count) ? Math.max(0, Math.min(count, 4)) : pairs.length;
  if (view !== 'lewis') return pairs.filter(pair => pair.kind !== 'delocalized');
  // Exchanging terminal atoms in an equivalent contributor transfers the
  // formal p lone pair, while retaining the two in-plane directions.
  const local = pairs.filter(pair => pair.kind !== 'delocalized');
  const donor = pairs.filter(pair => pair.kind === 'delocalized');
  const result = [...local, ...donor].slice(0, count);
  for (const {direction} of axes) {
    if (result.length >= count) break;
    if (!result.some(pair => Math.abs(direction.dot(new THREE.Vector3(...pair.direction))) > .94)) {
      result.push({kind: 'delocalized', direction: direction.toArray()});
    }
  }
  if (result.length < count) {
    const neighbor = (neighbors.get(atom.id) || [])[0];
    const direction = neighbor === undefined ? new THREE.Vector3(0, 0, 1) : planeNormal(atom.id, neighbor, positions, neighbors);
    result.push({ kind: 'delocalized', direction: direction.toArray() });
  }
  return result.slice(0, count);
}

