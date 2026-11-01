import React, {useEffect, useMemo, useRef, useState} from 'react';
import {ArrowRight, Check, ChevronDown, CornerDownRight, CornerUpRight, GitBranch, Hexagon, LoaderCircle, RotateCcw, Sparkles, Undo2, Redo2, X} from 'lucide-react';
import './structure-input.css';
import Formula from './Formula.jsx';
import {chemistryRequest} from './chemistryClient.js';

const ELEMENTS = [
  ['C','碳','#394b60'], ['N','氮','#2357b5'], ['O','氧','#b93236'], ['F','氟','#23774f'],
  ['Cl','氯','#246a3f'], ['H','氫','#4d6173'], ['S','硫','#816000'], ['P','磷','#9c4c16'],
  ['Br','溴','#934337'], ['I','碘','#65449b'], ['B','硼','#8b4e37'],
];
const NAMES = {...Object.fromEntries(ELEMENTS.map(([symbol,name])=>[symbol,name])),Si:'矽'};
const SYMBOLS = {
  '-':['bond','單鍵'], '=':['bond','雙鍵'], '#':['bond','三鍵'], ':':['bond','芳香鍵'],
  '(' :['branch','支鏈起點'], ')':['branch','回到主鏈'],
  '/':['stereo','雙鍵取代基方向'], '\\':['stereo','雙鍵取代基方向'],
  '@':['stereo','四面體立體標記'], '@@':['stereo','相反的四面體立體標記'],
  '.':['other','分開的片段'],
};

function tokenize(value) {
  const tokens=[];
  const pattern=/\[[^\]]*\]?|Cl|Br|Si|[A-Z][a-z]?|[bcnops]|%\d{0,2}|\d|@@|[^\s]/g;
  let match, atomIndex=0;
  while((match=pattern.exec(value))) {
    const raw=match[0], start=match.index, end=start+raw.length;
    let kind='other', label='尚未辨識的符號', symbol=raw, atom=null;
    if(raw.startsWith('[')) {
      const inner=raw.match(/^\[(\d*)([A-Z][a-z]?|[bcnops]|\*)/);
      if(inner) {
        symbol=inner[2].toUpperCase().slice(0,1)+inner[2].slice(1);
        atom=atomIndex++; kind='atom';
        label=(NAMES[symbol]||symbol)+(inner[1]?' · 同位素 '+inner[1]:'')+' '+(atom+1);
        if(/[+-]/.test(raw))label+=' · 帶電原子';
        if(raw.includes('@'))label+=' · 已指定立體方向';
      } else label='括號內指定元素、電荷或立體方向';
    } else if(/^[A-Z][a-z]?$|^[bcnops]$/.test(raw)) {
      symbol=raw[0].toUpperCase()+raw.slice(1); atom=atomIndex++; kind='atom';
      label=(NAMES[symbol]||symbol)+' '+(atom+1)+(/^[bcnops]$/.test(raw)?' · 芳香原子':'');
    } else if(/^\d$|^%\d{1,2}$/.test(raw)) {
      kind='ring'; label='環的連接點 '+raw.replace('%','');
    } else if(SYMBOLS[raw]) [kind,label]=SYMBOLS[raw];
    tokens.push({raw,start,end,kind,label,atom,symbol});
  }
  return tokens;
}

function safeSvg(source) {
  if(!source)return '';
  const parsed=new DOMParser().parseFromString(source,'image/svg+xml');
  const svg=parsed.documentElement;
  if(svg.localName!=='svg'||parsed.querySelector('parsererror'))return '';
  // Only passive drawing content is accepted, even though this SVG is generated
  // by the local RDKit renderer rather than supplied by the user.
  const allowed=new Set(['svg','g','path','rect','circle','ellipse','line','polyline','polygon','text','tspan','defs','clipPath','title','desc']);
  for(const node of [...svg.querySelectorAll('*')])if(!allowed.has(node.localName))node.remove();
  for(const node of [svg,...svg.querySelectorAll('*')])for(const attr of [...node.attributes]) {
    if(/^on/i.test(attr.name)||/href$/i.test(attr.name)||(/style/i.test(attr.name)&&/url\s*\(|expression|@import|javascript:/i.test(attr.value)))node.removeAttribute(attr.name);
  }
  svg.setAttribute('width','100%');svg.setAttribute('height','100%');
  svg.setAttribute('aria-hidden','true');svg.removeAttribute('id');
  return new XMLSerializer().serializeToString(svg);
}

export default function StructureInput({initialValue='',busy=false,hosted=false,onGenerate,onClose}) {
  const [value,setValue]=useState(initialValue||''), [selection,setSelection]=useState([(initialValue||'').length,(initialValue||'').length]);
  const [preview,setPreview]=useState(null),[previewState,setPreviewState]=useState(initialValue?'checking':'empty');
  const [moreElements,setMoreElements]=useState(false),[composing,setComposing]=useState(false),[submitting,setSubmitting]=useState(false);
  const [submitError,setSubmitError]=useState(''),[retry,setRetry]=useState(0),[historyVersion,setHistoryVersion]=useState(0);
  const textarea=useRef(null),valueRef=useRef(value),selectionRef=useRef(selection),requestId=useRef(0),previewHost=useRef(null);
  const history=useRef({past:[],future:[]});
  const tokens=useMemo(()=>tokenize(value),[value]);
  const focusedToken=tokens.find(t=>selection[0]>=t.start&&selection[0]<t.end)||tokens.find(t=>t.end===selection[0]);
  const svg=useMemo(()=>safeSvg(preview?.svg),[preview?.svg]);
  const inputBusy=busy||submitting;
  const canGenerate=previewState==='valid'&&preview?.valid&&preview?.source===value&&!inputBusy&&!composing;
  const openRings=useMemo(()=>{
    const counts=new Map();
    for(const t of tokens)if(t.kind==='ring')counts.set(t.raw,(counts.get(t.raw)||0)+1);
    return [...counts.entries()].filter(([,count])=>count%2).map(([name])=>name);
  },[tokens]);
  const nextRing=openRings[0]||Array.from({length:9},(_,i)=>String(i+1)).find(n=>!tokens.some(t=>t.kind==='ring'&&t.raw===n));
  const branchEnd=useMemo(()=>{
    const position=selection[0], stack=[];
    for(const t of tokens) {
      if(t.start>=position)break;
      if(t.raw==='(')stack.push(t.start);
      else if(t.raw===')')stack.pop();
    }
    if(!stack.length)return -1;
    let depth=0;
    for(const t of tokens.filter(t=>t.start>=stack.at(-1))) {
      if(t.raw==='(')depth++;
      else if(t.raw===')'&&--depth===0)return t.end;
    }
    return -1;
  },[tokens,selection]);

  useEffect(()=>{
    const end=(initialValue||'').length;
    textarea.current?.focus();textarea.current?.setSelectionRange(end,end);
  },[]);

  useEffect(()=>{
    const id=++requestId.current;
    if(!value.trim()){setPreview(null);setPreviewState('empty');return;}
    setPreviewState('checking');
    if(composing)return;
    const controller=new AbortController();
    const timer=setTimeout(async()=>{
      try {
        const data=await chemistryRequest({action:'inspect',smiles:value},{signal:controller.signal,hosted});
        if(requestId.current!==id)return;
        setPreview({...data,source:value});setPreviewState(data.valid?'valid':'invalid');
      } catch(error) {
        if(error.name==='AbortError'||requestId.current!==id)return;
        setPreview({valid:false,source:value,message:error.message==='Failed to fetch'?(hosted?'無法連線至雲端預覽，請稍後重試。':'無法連線至本機預覽，請確認 App 已啟動。'):error.message});
        setPreviewState('error');
      }
    },350);
    return ()=>{clearTimeout(timer);controller.abort();};
  },[value,composing,retry]);

  useEffect(()=>{
    const host=previewHost.current;
    if(!host)return;
    const atom=focusedToken?.atom;
    host.classList.toggle('has-atom-focus',Number.isInteger(atom)&&preview?.source===value);
    for(const node of host.querySelectorAll('[class]')) {
      if(node===host)continue;
      const focused=Number.isInteger(atom)&&node.classList.contains('atom-'+atom)&&preview?.source===value;
      node.classList.toggle('si-focused-atom',focused);
    }
  },[focusedToken?.atom,svg,value,preview?.source]);

  useEffect(()=>{
    const drawing=previewHost.current?.querySelector('svg');
    if(!drawing||!svg||preview?.source!==value)return;
    // Fit actual bonds and atom labels; RDKit's full canvas contains excess
    // whitespace for small molecules, especially in the compact mobile preview.
    const boxes=[...drawing.querySelectorAll('path,text,circle,ellipse,line,polyline,polygon')]
      .map(node=>node.getBBox()).filter(b=>b.width||b.height);
    if(!boxes.length)return;
    const left=Math.min(...boxes.map(b=>b.x)),top=Math.min(...boxes.map(b=>b.y));
    const right=Math.max(...boxes.map(b=>b.x+b.width)),bottom=Math.max(...boxes.map(b=>b.y+b.height));
    const width=Math.max(180,right-left+32),height=Math.max(90,bottom-top+32);
    drawing.setAttribute('viewBox',`${(left+right-width)/2} ${(top+bottom-height)/2} ${width} ${height}`);
  },[svg,value,preview?.source]);

  function moveCursor(start,end=start) {
    selectionRef.current=[start,end];setSelection([start,end]);
    requestAnimationFrame(()=>{textarea.current?.focus();textarea.current?.setSelectionRange(start,end);});
  }
  function update(next,{cursor,focus=false}={}) {
    if(next!==valueRef.current) {
      history.current.past.push({value:valueRef.current,selection:selectionRef.current});
      history.current.past=history.current.past.slice(-100);history.current.future=[];
      valueRef.current=next;setValue(next);setSubmitError('');setHistoryVersion(n=>n+1);
    }
    if(cursor){selectionRef.current=cursor;setSelection(cursor);if(focus)moveCursor(...cursor);}
  }
  function insert(text,inside=null) {
    if(inputBusy)return;
    const [start,end]=selectionRef.current;
    const next=valueRef.current.slice(0,start)+text+valueRef.current.slice(end);
    const cursor=start+(inside===null?text.length:inside);
    update(next,{cursor:[cursor,cursor],focus:true});
  }
  function branch() {
    const [start,end]=selectionRef.current,content=valueRef.current.slice(start,end);
    insert('('+content+')',content?content.length+2:1);
  }
  function travelHistory(direction) {
    if(inputBusy)return;
    const from=history.current[direction==='undo'?'past':'future'],to=history.current[direction==='undo'?'future':'past'];
    const snapshot=from.pop();if(!snapshot)return;
    to.push({value:valueRef.current,selection:selectionRef.current});
    valueRef.current=snapshot.value;setValue(snapshot.value);setSubmitError('');setHistoryVersion(n=>n+1);moveCursor(...snapshot.selection);
  }
  async function generate(event) {
    event?.preventDefault();if(!canGenerate)return;
    setSubmitting(true);setSubmitError('');
    try {const result=await onGenerate(value);if(result===null||result===false)setSubmitError('三維生成未完成。請確認結構或查看錯誤訊息。');}
    catch(error){setSubmitError(error.message||'三維生成未完成，輸入內容已保留。');}
    finally{setSubmitting(false);}
  }
  function keyDown(event) {
    if(event.nativeEvent.isComposing)return;
    if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();generate();}
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'){event.preventDefault();travelHistory(event.shiftKey?'redo':'undo');}
    if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='y'){event.preventDefault();travelHistory('redo');}
  }
  const description=branchEnd>=0&&selection[0]===selection[1]&&value[selection[0]]===')'?'在支鏈加入原子，完成後點「回主鏈」':focusedToken?
    focusedToken.kind==='atom'?focusedToken.label+(focusedToken.raw.startsWith('[')?'':' · 相鄰原子自動接成單鍵'):
    focusedToken.kind==='ring'?focusedToken.label+' · 相同編號相連':focusedToken.label:
    '點選元素開始，或貼上已有的 SMILES';

  return <section className="structure-input" data-preview-state={previewState} aria-labelledby="si-title">
    <header className="si-header"><div><h2 id="si-title">輸入結構</h2><span>點選符號，立即看見連接方式</span></div><button type="button" className="si-icon-button" onClick={onClose} aria-label="關閉結構輸入" title="關閉"><X size={22}/></button></header>
    <div className="si-workspace">
      <form className="si-editor" onSubmit={generate}>
        <div className="si-section-label"><strong>原子</strong><button type="button" className="si-text-button" aria-expanded={moreElements} onClick={()=>setMoreElements(v=>!v)}>更多元素<ChevronDown size={15} className={moreElements?'si-flipped':''}/></button></div>
        <div className="si-elements">{ELEMENTS.slice(0,moreElements?ELEMENTS.length:5).map(([symbol,name,color])=><button type="button" key={symbol} aria-label={`插入${name}元素`} title={`${name} · ${symbol}`} disabled={inputBusy} onMouseDown={e=>e.preventDefault()} onClick={()=>insert(symbol==='H'?'[H]':symbol)}><strong style={{color}}>{symbol}</strong><span>{name}</span></button>)}</div>
        <div className="si-connections" aria-label="連接工具">
          <div className="si-bonds">{[['-','—','單鍵'],['=','=','雙鍵'],['#','≡','三鍵']].map(([code,icon,name])=><button type="button" key={code} aria-label={`插入${name}`} title={name} disabled={inputBusy} onMouseDown={e=>e.preventDefault()} onClick={()=>insert(code)}><b>{icon}</b><span>{name}</span></button>)}</div>
          <div className="si-branches"><button type="button" aria-label="新增支鏈" title="在目前位置新增支鏈" disabled={inputBusy} onMouseDown={e=>e.preventDefault()} onClick={branch}><GitBranch size={17}/><span>支鏈</span></button><button type="button" aria-label="回到主鏈" title="跳到支鏈括號外，繼續接主鏈" disabled={inputBusy||branchEnd<0} onMouseDown={e=>e.preventDefault()} onClick={()=>moveCursor(branchEnd)}><CornerUpRight size={17}/><span>回主鏈</span></button><button type="button" aria-label={openRings.length?'閉合環 '+openRings[0].replace('%',''):'標記環起點'} title={openRings.length?'在目前原子與環起點之間建立連接':'在目前原子標記環起點'} disabled={inputBusy||!nextRing} onMouseDown={e=>e.preventDefault()} onClick={()=>insert(nextRing)}><Hexagon size={17}/><span>{openRings.length?'閉環 '+openRings[0].replace('%',''):'環起點'}</span></button></div>
        </div>
        <div className="si-input-label"><label htmlFor="si-value">SMILES</label><div><button type="button" className="si-icon-button" aria-label="復原輸入" title="復原輸入 · Ctrl Z" disabled={inputBusy||!history.current.past.length} onClick={()=>travelHistory('undo')}><Undo2 size={17}/></button><button type="button" className="si-icon-button" aria-label="重做輸入" title="重做輸入 · Ctrl Shift Z" disabled={inputBusy||!history.current.future.length} onClick={()=>travelHistory('redo')}><Redo2 size={17}/></button><button type="button" className="si-text-button" aria-label="清除輸入" disabled={inputBusy||!value} onClick={()=>update('',{cursor:[0,0],focus:true})}>清除</button></div></div>
        <textarea ref={textarea} id="si-value" aria-label="SMILES 分子輸入" spellCheck={false} autoCapitalize="off" autoCorrect="off" placeholder="點上方元素，或在這裡輸入…" value={value} disabled={inputBusy} onCompositionStart={()=>setComposing(true)} onCompositionEnd={()=>setComposing(false)} onChange={e=>update(e.target.value,{cursor:[e.target.selectionStart,e.target.selectionEnd]})} onSelect={e=>{selectionRef.current=[e.target.selectionStart,e.target.selectionEnd];setSelection(selectionRef.current);}} onKeyDown={keyDown}/>
        <div className="si-token-strip" aria-label="逐符號解析">{tokens.length?tokens.map(t=><button type="button" key={t.start} className={'si-token si-token-'+t.kind+(focusedToken?.start===t.start?' active':'')} aria-label={`${t.raw}：${t.label}`} title={t.label} onClick={()=>moveCursor(t.start,t.end)} disabled={inputBusy}><span>{t.kind==='atom'?t.symbol:t.raw}</span>{t.atom!==null&&<small>{t.atom+1}</small>}</button>):<span className="si-token-empty"><CornerDownRight size={16}/>符號會在這裡拆解成原子與連接</span>}</div>
        <p className="si-current-symbol" aria-live="polite">{description}</p>
        <details className="si-advanced"><summary>更多符號<ChevronDown size={15}/></summary><div><span>芳香原子</span><div className="si-advanced-buttons">{[['c','芳香碳'],['n','芳香氮'],['o','芳香氧'],['s','芳香硫']].map(([code,label])=><button type="button" key={code} title={label} aria-label={`插入${label}`} disabled={inputBusy} onClick={()=>insert(code)}><code>{code}</code>{label}</button>)}</div><span>立體方向</span><div className="si-advanced-buttons">{[['/','方向 /'],['\\','方向 \\'],['@','立體 @'],['@@','立體 @@']].map(([code,label])=><button type="button" key={code} disabled={inputBusy} onClick={()=>insert(code)}>{label}</button>)}</div><p>原始輸入完整保留，支援括號原子、電荷、同位素與立體標記。</p></div></details>
      </form>
      <aside className="si-preview" aria-label="結構即時預覽">
        <div className="si-preview-heading"><strong>連接預覽</strong><span>2D</span></div>
        <div className={'si-preview-image '+(previewState==='checking'?'is-checking':'')} ref={previewHost} role="img" aria-label={previewState==='valid'?'目前輸入的二維分子連接圖':'等待完整的分子連接'}>
          {svg&&preview?.source===value&&preview?.valid?<div className="si-svg" dangerouslySetInnerHTML={{__html:svg}}/>:<div className="si-preview-placeholder"><svg viewBox="0 0 160 100" aria-hidden="true"><path d="M28 68 72 40 116 66" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/><circle cx="28" cy="68" r="10"/><circle cx="72" cy="40" r="10"/><circle cx="116" cy="66" r="10"/></svg><span>{previewState==='empty'?'從一個原子開始':previewState==='checking'?'讀取連接中…':'接好符號，就能看見結構'}</span></div>}
        </div>
        <div className={'si-preview-status '+previewState} role="status" aria-live="polite">
          {previewState==='checking'?<><LoaderCircle className="si-spin" size={18}/><span>即時驗證中</span></>:previewState==='valid'?<><Check size={18}/><span><b><Formula value={preview?.displayFormula||preview?.formula} parts={preview?.formulaParts} charge={preview?.charge}/></b><small>{preview?.atomCount} 原子 · {preview?.bondCount} 化學鍵</small></span></>:previewState==='empty'?<><ArrowRight size={18}/><span>加入原子後，預覽會自動更新</span></>:<><span className="si-status-dot"/><span>{preview?.message||'請檢查輸入的連接方式。'}</span>{previewState==='error'&&<button type="button" className="si-icon-button" aria-label="重試結構預覽" title="重試預覽" onClick={()=>setRetry(n=>n+1)}><RotateCcw size={18}/></button>}</>}
        </div>
        {previewState==='valid'&&<p className="si-preview-note">數字對應輸入中的原子。生成後可在 3D 畫面繼續編輯。</p>}
      </aside>
    </div>
    <footer className="si-footer"><span className={submitError?'si-submit-error':''} role={submitError?'alert':undefined}>{submitError||'輸入時不會變更目前模型'}</span><button type="button" className="si-generate" onClick={generate} disabled={!canGenerate}>{inputBusy?<LoaderCircle size={18} className="si-spin"/>:<Sparkles size={18}/>}生成三維結構<ArrowRight size={18}/></button></footer>
  </section>;
}
