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
    atom.noImplicit = false;
    delete atom.chiralTag;
  }
  for (const bond of graph.bonds) if (affected.has(bond.a) || affected.has(bond.b)) {
    delete bond.stereo;
    delete bond.stereoAtoms;
    delete bond.bondDir;
  }
}

export function replaceAtom(graph, id, element, charge) {
  const atom = graph.atoms.find(a => a.id === id);
  if (!atom) throw new Error('氫原子依價態自動補足');
  // An isotope belongs to one element. Replacing 13C with N must not silently
  // request radioactive 13N; charge-only changes preserve the selected isotope.
  if (atom.element !== element) atom.isotope = 0;
  atom.element = element;
  atom.charge = charge;
  atom.explicitHs = 0;
  touchGraph(graph, [id]);
}
