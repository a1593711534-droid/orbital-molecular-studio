import type { Metadata, Viewport } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title:'ORBITAL — 分子工作室',
  description:'從原子建立分子，觀察三維形狀、立體異構與電子結構。',
  icons:{icon:'/favicon.svg'},
  appleWebApp:{capable:true,title:'ORBITAL',statusBarStyle:'default'},
};
export const viewport: Viewport={width:'device-width',initialScale:1,viewportFit:'cover',themeColor:'#f7f9f6'};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>) {
  return <html lang="zh-Hant"><body>{children}</body></html>;
}
