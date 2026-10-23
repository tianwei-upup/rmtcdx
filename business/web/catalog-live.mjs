// Catalog changes never submit model jobs or reload the WebView. SSE is fast;
// the lightweight revision read recovers missed events and background resumes.
export class CatalogLive {
 constructor({revision,api,onChange,onError,eventSource=url=>new EventSource(url)}){Object.assign(this,{revision,api,onChange,onError,eventSource});}
 start(){this.source=this.eventSource('/api/catalog/events');this.source.onmessage=e=>{try{void this.check(JSON.parse(e.data).revision);}catch{}};this.source.onerror=()=>void this.check();this.timer=setInterval(()=>void this.check(),5000);return this;}
 async check(revision){if(this.closed||this.checking)return;this.checking=true;try{revision??=(await this.api('/api/catalog/revision')).revision;if(revision!==this.revision){await this.onChange(revision);this.revision=revision;}}catch(e){this.onError?.(e);}finally{this.checking=false;}}
 close(){this.closed=true;clearInterval(this.timer);this.source?.close();}
}

// Initial catalog GET is safe to retry: it cannot create or replay a phone job.
export async function loadCatalog(api,route,{sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 for(let attempt=0;;attempt++)try{return await api(route,undefined,{timeoutMs:8000});}catch(error){if(error.code!=='network_unavailable'||attempt>=2)throw error;await sleep(1000*(attempt+1));}
}

// Bootstrap retries only initialization reads. It never logs in, submits a
// phone message, or reloads an already-open conversation/draft.
export class CatalogBootstrap {
 constructor({initialize,onError,schedule=(fn,ms)=>globalThis.setTimeout(fn,ms),cancel=id=>globalThis.clearTimeout(id)}){Object.assign(this,{initialize,onError,schedule,cancel});}
 connect(){
  if(this.pending)return this.pending;this.cancel(this.timer);
  this.pending=Promise.resolve().then(()=>this.initialize()).then(()=>true).catch(error=>{
   this.onError(error);if(error.code==='network_unavailable'&&!this.closed)this.timer=this.schedule(()=>void this.connect(),3000);return false;
  }).finally(()=>{this.pending=null;});return this.pending;
 }
 stop(){this.closed=true;this.cancel(this.timer);}
}
