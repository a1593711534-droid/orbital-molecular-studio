'use client';
import { useEffect, useState } from 'react';
import App from '../src/App.jsx';
import '../src/studio.css';
export default function Studio() {
  const [mounted,setMounted]=useState(false);
  useEffect(()=>setMounted(true),[]);
  return mounted?<App hosted/>:<div className="studio-loading" role="status">ORBITAL · 開啟分子工作室…</div>;
}
