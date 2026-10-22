import {gzipSync} from 'node:zlib';
// Compress only history JSON. SSE remains unbuffered and unchanged.
export function historyJson(req,value){
 const bytes=Buffer.from(JSON.stringify(value)),history=/^\/api\/conversations\/[A-Za-z0-9_-]+\/desktop\/history(?:\?|$)/.test(req?.url??'');
 const gzip=(req?.headers?.['accept-encoding']??'').split(',').some(value=>{const [name,...params]=value.trim().split(';');const q=params.map(v=>v.trim()).find(v=>v.startsWith('q='));return name.toLowerCase()==='gzip'&&(!q||Number(q.slice(2))>0);});
 return history&&gzip&&bytes.length>=1024?{bytes:gzipSync(bytes,{level:4}),headers:{'content-encoding':'gzip',vary:'Accept-Encoding'}}:{bytes,headers:history?{vary:'Accept-Encoding'}:{}};
}
