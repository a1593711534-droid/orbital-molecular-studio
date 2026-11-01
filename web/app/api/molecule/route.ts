import {proxyChemistry} from '../../../lib/chemistry-proxy';
export const dynamic='force-dynamic';
export async function POST(request:Request){return proxyChemistry(request,'/api/molecule');}
