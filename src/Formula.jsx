import React from 'react';

// Element counts, isotopic mass numbers and the net charge have distinct positions.
export default function Formula({value='',parts,charge}) {
  const match=String(value).match(/([+-])(\d*)$/);
  const net=Number.isInteger(charge)?charge:match?(match[1]==='+'?1:-1)*Number(match[2]||1):0;
  const body=match?String(value).slice(0,match.index):String(value);
  const units=Array.isArray(parts)&&parts.length?parts:null;
  const suffix=net?(Math.abs(net)===1?'':String(Math.abs(net)))+(net>0?'+':'−'):'';
  return <span className="chemical-formula">{units?units.map((p,i)=><React.Fragment key={i}>{p.isotope>0&&<sup className="isotope">{p.isotope}</sup>}{p.element}{p.count>1&&<sub>{p.count}</sub>}</React.Fragment>):(body||'—').split(/(\d+)/).map((t,i)=>/^\d+$/.test(t)?<sub key={i}>{t}</sub>:<React.Fragment key={i}>{t}</React.Fragment>)}{suffix&&<sup className="formula-charge">{suffix}</sup>}</span>;
}
