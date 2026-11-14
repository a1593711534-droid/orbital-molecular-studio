// Graph IDs refer to model atoms; automatically added hydrogens need not be
// present in the editable graph. Never treat a missing bond as an edit.
export function editableBond(graph, ends) {
  const bond = graph.bonds.find(b => (b.a === ends[0] && b.b === ends[1]) || (b.a === ends[1] && b.b === ends[0]));
  if (!bond) throw new Error('氫原子依價態自動補足；請修改相連原子的元素、電荷或重原子鍵。');
  return bond;
}

export function touchGraph(graph, ids, consume = 0) {
  const affected = new Set(ids);
  for (const atom of graph.atoms) if (affected.has(atom.id)) {
    atom.explicitHs = Math.max(0, (atom.explicitHs || 0) - consume);
    // Bracket atoms such as [O-] and [C-] explicitly prohibit implicit H.
    // Editing a bond must not silently turn an oxide into hydroxide, or a
    // cyanide carbon into a different hydrogenated species.
    delete atom.chiralTag;
  }
  for (const bond of graph.bonds) if (affected.has(bond.a) || affected.has(bond.b)) {
    delete bond.stereo;
    delete bond.stereoAtoms;
    delete bond.bondDir;
  }
}

export function replaceAtom(graph, id, element, charge, hydrogenMode) {
  const atom = graph.atoms.find(a => a.id === id);
  if (!atom) throw new Error('氫原子依價態自動補足');
  const changesIdentity = atom.element !== element || (atom.charge || 0) !== charge;
  // An isotope belongs to one element. Replacing 13C with N must not silently
  // request radioactive 13N; charge-only changes preserve the selected isotope.
  if (atom.element !== element) {
    atom.isotope = 0;
    atom.explicitHs = 0;
    atom.noImplicit = false;
  }
  atom.element = element;
  atom.charge = charge;
  if (hydrogenMode !== undefined) {
    if (hydrogenMode === 'auto') {
      atom.explicitHs = 0;
      atom.noImplicit = false;
    } else {
      const count = Number(hydrogenMode);
      if (!Number.isInteger(count) || count < 0 || count > 4) throw new Error('請指定 0–4 個氫，或選擇自動補氫。');
      atom.explicitHs = count;
      atom.noImplicit = true;
    }
  }
  // Explicit/automatic H is an editing policy. Keep the stereochemical
  // descriptors on the submitted graph and let the engine check the valence.
  if (changesIdentity) touchGraph(graph, [id]);
}

export function appendGraphAtom(source, parent, element, order) {
  const graph = structuredClone(source);
  if (!graph.atoms.some(atom => atom.id === parent)) throw new Error('請選擇已存在的連接原子。');
  if (graph.atoms.length >= 200 || (element !== 'H' && graph.atoms.filter(atom => atom.element !== 'H').length >= 80))
    throw new Error('結構上限為 80 個重原子、200 個總原子。');
  const id = Math.max(...graph.atoms.map(atom => atom.id)) + 1;
  touchGraph(graph, [parent], order);
  graph.atoms.push({id, element, charge:0});
  graph.bonds.push({a:parent, b:id, order});
  return graph;
}
