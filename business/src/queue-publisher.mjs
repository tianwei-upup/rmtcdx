import crypto from 'node:crypto';
export class QueuePublisher {
  constructor({adapter,call,log=()=>{}}){this.adapter=adapter;this.call=call;this.log=log;this.epoch=crypto.randomUUID();this.states=new Map();this.stopped=false;this.lastLog=0;}
  async start(){const conversationIds=this.adapter.queueIds();await this.call('/api/agent/queue/hello',{epoch:this.epoch,conversationIds},true,5000);this.unsubscribe=this.adapter.subscribeQueue(id=>this.dirty(id));this.timer=setInterval(()=>void this.tick(),1000);for(const id of this.adapter.liveQueueIds?.()??conversationIds)this.dirty(id);}
  dirty(id){if(this.stopped)return;const s=this.states.get(id)??{revision:0};this.states.set(id,s);s.dirty=true;if(!s.running){clearTimeout(s.timer);s.timer=setTimeout(()=>void this.flush(id,s),20);}}
  async flush(id,s){if(this.stopped||s.running)return;s.running=true;
    try{while(s.dirty&&!this.stopped){s.dirty=false;const snapshot=await this.adapter.snapshotQueue(id),hash=JSON.stringify(snapshot);if(s.hash===hash)continue;
      const value={...snapshot,epoch:this.epoch,revision:++s.revision};await this.call('/api/agent/queue/projection',value,true,5000);s.hash=hash;}
    }catch(error){s.dirty=true;this.error(error);}finally{s.running=false;if(s.dirty&&!this.stopped&&this.states.get(id)===s)s.timer=setTimeout(()=>void this.flush(id,s),500);}
  }
  error(error){if(Date.now()-this.lastLog<30000)return;this.lastLog=Date.now();this.log({event:'queue.projection.unavailable',code:error.code??'network_unavailable'});}
  async tick(){if(this.stopped||this.ticking)return;this.ticking=true;try{const conversationIds=this.adapter.queueIds();await this.call('/api/agent/queue/ping',{epoch:this.epoch,conversationIds},true,5000);for(const[id,s]of this.states)if(!conversationIds.includes(id)){clearTimeout(s.timer);this.states.delete(id);}for(const id of this.adapter.liveQueueIds?.()??conversationIds)this.dirty(id);}catch(error){this.error(error);try{await this.call('/api/agent/queue/hello',{epoch:this.epoch,conversationIds:this.adapter.queueIds()},true,5000);for(const s of this.states.values())s.hash=null;}catch{}}finally{this.ticking=false;}}
  stop(){this.stopped=true;clearInterval(this.timer);this.unsubscribe?.();for(const s of this.states.values())clearTimeout(s.timer);}
}
