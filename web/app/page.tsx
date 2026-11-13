import { requireChatGPTUser } from './chatgpt-auth';
import Studio from './studio';
export const dynamic = 'force-dynamic';
export default async function Home() {
  await requireChatGPTUser('/');
  // Only publish the documented public health endpoint to the browser.
  // Other deployment URLs and service credentials stay on the server.
  const publicOrigin = 'https://orbital-molecular-studio.onrender.com';
  const wakeUrl = process.env.CHEMISTRY_API_URL?.replace(/\/+$/, '') === publicOrigin
    ? publicOrigin + '/healthz' : undefined;
  return <Studio wakeUrl={wakeUrl}/>;
}
