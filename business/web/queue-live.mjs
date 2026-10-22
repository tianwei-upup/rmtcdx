// SSE carries changes; reads recover from the RAM projection, never from a task queue.
export class QueueLive {
  constructor({route,api,onUpdate,onHealth,onError,eventSource=url=>new EventSource(url)}){Object.assign(this,{route,api,onUpdate,onHealth,onError,eventSource});this.epoch=null;this.revision=0;this.waiters=new Set();this.closed=false;}
  start(){this.source=this.eventSource(this.route+'/events');this.source.onopen=()=>this.onHealth?.({connected:true});this.source.onmessage=e=>{try{this.message(JSON.parse(e.data));}catch(error){this.onError?.(error);}};this.source.onerror=()=>{if(this.closed)return;this.onHealth?.({connected:false,fresh:false});void this.refresh();};this.timer=setInterval(()=>{if(!this.lastAt||Date.now()-this.lastAt>6000)void this.refresh();},2000);return this;}
  message(value){if(this.closed)return;this.lastAt=Date.now();
    if(value.type==='queue.health'){this.onHealth?.({...value,connected:true});return;}
    if(value.type==='queue.reset'){if(value.epoch&&value.epoch!==this.epoch){this.epoch=value.epoch;this.revision=0;}void this.refresh();return;}
    if(value.type==='queue.update')this.apply({...value,transport:'sse'});
  }
  apply(value){if(this.closed)return;if(this.epoch&&value.epoch!==this.epoch)return;if(!this.epoch)this.epoch=value.epoch;if(value.revision<this.revision)return;this.revision=value.revision;this.onUpdate(value);this.check();}
  async refresh(){if(this.closed||this.refreshing)return;this.refreshing=true;try{const value=await this.api(this.route+'/live');if(!this.closed){this.onHealth?.({...value,connected:Boolean(this.source?.readyState===1)});this.apply({...value,transport:'poll'});}}catch(e){if(!this.closed)this.onError?.(e);}finally{this.refreshing=false;}}
  confirm(check){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;}),w={check,resolve,reject};this.waiters.add(w);this.check();return {promise,close:()=>this.waiters.delete(w)};}
  check(){for(const w of this.waiters){const value=w.check();if(value){this.waiters.delete(w);w.resolve(value);}}}
  close(){this.closed=true;clearInterval(this.timer);this.source?.close();for(const w of this.waiters)w.reject(Object.assign(Error('connection_changed'),{code:'connection_changed'}));this.waiters.clear();}
}
