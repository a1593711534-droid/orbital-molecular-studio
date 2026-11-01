import {proxyChemistry} from '../../../lib/chemistry-proxy';
export const dynamic='force-dynamic';
export async function GET(request:Request){return proxyChemistry(request,'/api/health');}
