import React from 'react';

function ViewIcon({hybrid}) {
  return <svg width="27" height="20" viewBox="0 0 27 20" aria-hidden="true"><circle cx="4" cy="10" r="3" fill="currentColor"/><circle cx="23" cy="10" r="3" fill="currentColor"/><path d="M8 8H19" stroke="currentColor" strokeWidth="1.7"/><path d="M8 12H19" stroke="currentColor" strokeWidth="1.7" strokeDasharray={hybrid?'2 2':undefined}/>{!hybrid&&<><circle cx="2" cy="3" r="1" fill="currentColor"/><circle cx="5" cy="3" r="1" fill="currentColor"/></>}</svg>;
}

export default function ElectronicViewControl({value,onChange}) {
  return <div className="electronic-view-control" role="group" aria-label="電子結構表示法">{[['hybrid','離域示意'],['lewis','Lewis 式']].map(([id,label])=><button key={id} aria-pressed={value===id} onClick={()=>onChange(id)} title={id==='hybrid'?'呈現離域系統與等價鍵；軌域為示意':'以目前的 Lewis 式顯示鍵級、形式電荷與電子對計數'}><ViewIcon hybrid={id==='hybrid'}/><span>{label}</span></button>)}</div>;
}
