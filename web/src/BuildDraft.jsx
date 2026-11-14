import React, {useEffect, useRef, useState} from 'react';
import {ELEMENTS, ION_CHARGES, atomSymbol} from './chemistryExamples.js';

export default function BuildDraft({draft, element, order, busy, error, retryConnection, onAppend, onRetry, onClose}) {
  const dialog = useRef(null);
  const [parent, setParent] = useState(draft.parent);
  const [symbol, setSymbol] = useState(element);
  const [bondOrder, setBondOrder] = useState(order);
  useEffect(() => {
    const node = dialog.current;
    node.showModal();
    return () => node.close();
  }, []);
  const atomName = id => {
    const atom = draft.graph.atoms.find(item => item.id === id);
    return atomSymbol(atom) + (id + 1);
  };
  return <dialog className="build-draft" ref={dialog} aria-labelledby="draft-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2 id="draft-title">接原子草稿</h2>
    <p role="status">目前的連接尚未產生三維模型。可繼續接原子，引擎驗證通過後會套用並儲存。</p>
    <p className="compact-note">{draft.reason}</p>
    {error&&<p className="draft-error" role="alert">{error}</p>}
    {retryConnection}
    <p className="draft-bonds" aria-label="草稿鍵結">{draft.graph.bonds.length
      ? draft.graph.bonds.map(b => atomName(b.a) + ({1:'—',2:'＝',3:'≡'}[b.order] || '·') + atomName(b.b)).join('、')
      : atomName(draft.graph.atoms[0].id)}</p>
    <label>連接位置<select value={parent} onChange={e => setParent(+e.target.value)} disabled={busy}>
      {draft.graph.atoms.filter(atom => atom.element!=='H'&&!ION_CHARGES[atom.element]).map(atom => <option key={atom.id} value={atom.id}>{atomName(atom.id)}</option>)}
    </select></label>
    <label>接上的元素<select value={symbol} onChange={e => setSymbol(e.target.value)} disabled={busy}>
      {ELEMENTS.filter(([symbol]) => !ION_CHARGES[symbol]).map(([symbol, name]) => <option key={symbol} value={symbol}>{symbol} · {name}</option>)}
    </select></label>
    <label>新鍵鍵級<select value={bondOrder} onChange={e => setBondOrder(+e.target.value)} disabled={busy}>
      <option value={1}>單鍵</option><option value={2}>雙鍵</option><option value={3}>三鍵</option>
    </select></label>
    <button className="primary full" disabled={busy} onClick={() => onAppend(parent, symbol, bondOrder)}>接上並驗證</button>
    <div className="draft-actions">
      <button className="text-button" disabled={busy} onClick={onRetry}>重新驗證草稿</button>
      <button className="text-button" disabled={busy} onClick={onClose}>取消草稿</button>
    </div>
  </dialog>;
}
