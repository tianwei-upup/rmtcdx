import crypto from 'node:crypto';
export class QueuePublisher {
  constructor({adapter,call,log=()=>{}}){this.adapter=adapter;this.call=call;this.log=log;this.epoch=crypto.randomUUID();this.states=new Map();this.stopped=false;this.lastLog=0;}
  async start(){const conversationIds=this.adapter.queueIds();await this.call('/api/agent/queue/hello',{epoch:this.epoch,conversationIds},true,5000);this.unsubscribe=this.adapter.subscribeQueue(id=>this.dirty(id));this.timer=setInterval(()=>void this.tick(),1000);for(const id of this.adapter.liveQueueIds?.()??conversationIds)this.dirty(id);}
  dirty(id){
    if(this.stopped)return;const s=this.states.get(id)??{revision:0,pending:[],bytes:0};this.states.set(id,s);
    // Capture now, independently of a blocked upload. Only immutable public
    // projections are buffered; business tasks and approval intents never retry here.
    const captured=Promise.resolve().then(()=>this.adapter.snapshotQueue(id)).then(snapshot=>({hash:JSON.stringify(snapshot)}),error=>({error}));
    s.captures=(s.captures??Promise.resolve()).then(async()=>{
      const result=await captured;if(result.error)throw result.error;const {hash}=result;if(this.stopped||this.states.get(id)!==s||hash===s.hash)return;
      const value={...JSON.parse(hash),epoch:this.epoch,revision:++s.revision},bytes=Buffer.byteLength(hash);
      s.hash=hash;s.pending.push({value,bytes});s.bytes+=bytes;
      // Bound RAM during prolonged outages. Preserve the in-flight head and
      // newest state, and report overload rather than silently growing forever.
      let coalesced=0;while(s.pending.length>2&&(s.pending.length>64||s.bytes>8*1024*1024)){s.bytes-=s.pending.splice(1,1)[0].bytes;coalesced++;}
      if(coalesced)this.log({event:'queue.projection.backpressure',conversationId:id,coalesced});
      this.log({event:'queue.projection.captured',conversationId:id,revision:value.revision,pending:s.pending.length,at:Date.now(),outputs:value.receipts.map(r=>({intentId:r.intentId,state:r.state,seq:r.progress?.seq,chars:(r.progress?.text??r.result??'').length}))});
      if(!s.running){clearTimeout(s.timer);s.timer=setTimeout(()=>void this.flush(id,s),0);}
    }).catch(error=>this.error(error));
  }
  async flush(id,s){if(this.stopped||s.running||this.states.get(id)!==s)return;s.running=true;
    try{while(s.pending.length&&!this.stopped&&this.states.get(id)===s){const head=s.pending[0];await this.call('/api/agent/queue/projection',head.value,true,5000);s.pending.shift();s.bytes-=head.bytes;this.log({event:'queue.projection.sent',conversationId:id,revision:head.value.revision,at:Date.now()});}}
    catch(error){this.error(error);}finally{s.running=false;if(s.pending.length&&!this.stopped&&this.states.get(id)===s)s.timer=setTimeout(()=>void this.flush(id,s),500);}
  }
  error(error){if(Date.now()-this.lastLog<30000)return;this.lastLog=Date.now();this.log({event:'queue.projection.unavailable',code:error.code??'network_unavailable'});}
  async tick(){if(this.stopped||this.ticking)return;this.ticking=true;try{const conversationIds=this.adapter.queueIds();await this.call('/api/agent/queue/ping',{epoch:this.epoch,conversationIds},true,5000);for(const[id,s]of this.states)if(!conversationIds.includes(id)){clearTimeout(s.timer);this.states.delete(id);}for(const id of this.adapter.liveQueueIds?.()??conversationIds)this.dirty(id);}catch(error){this.error(error);try{await this.call('/api/agent/queue/hello',{epoch:this.epoch,conversationIds:this.adapter.queueIds()},true,5000);for(const s of this.states.values())s.hash=null;}catch{}}finally{this.ticking=false;}}
  stop(){this.stopped=true;clearInterval(this.timer);this.unsubscribe?.();for(const s of this.states.values())clearTimeout(s.timer);}
}
