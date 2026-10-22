import path from 'node:path';
import crypto from 'node:crypto';
import { DesktopStream } from './desktop-stream.mjs';
import { DesktopApprovals, desktopView } from './desktop-view.mjs';
import { readPrivate, writePrivate, privateDirectory } from './state.mjs';

// A separate observer process; closing it never stops a queue worker or owner.
export class DesktopPublisher {
  constructor({chats,runtime,endpoint,call,lazy=false,isAllowed=()=>true,prepareHistory,log=()=>{},streamFactory=options=>new DesktopStream(options)}){
    Object.assign(this,{chats,runtime,endpoint,call,lazy,isAllowed,prepareHistory,log,streamFactory});privateDirectory(runtime);this.epoch=crypto.randomUUID();this.entries=new Map();this.stopped=false;
  }
  async start(){
    for(let attempt=0;;attempt++){try{await this.hello();break;}catch(e){if(e.code!=='desktop_publisher_busy'||attempt>=4)throw e;await new Promise(r=>setTimeout(r,2500));}}
    if(!this.lazy)for(const chat of this.chats)if(this.isAllowed(chat))this.connect(chat);
    this.timer=setInterval(()=>void this.maintain(),2000);this.loop=this.claims();return this;
  }
  async updateChats(chats){
    const next=new Map(chats.map(c=>[c.id,c]));
    for(const [id,e]of this.entries){const c=next.get(id);if(!c||c.cwd!==e.chat.cwd||c.projectId!==e.chat.projectId||c.archived!==e.chat.archived||c.approvals!==e.chat.approvals){clearTimeout(e.timer);e.stream.close();this.entries.delete(id);}else e.chat=c;}
    this.chats=chats;await this.hello();
  }
  hello(){return this.call('/api/agent/desktop/hello',{epoch:this.epoch,conversationIds:this.chats.map(c=>c.id)});}
  connect(chat){
    if(this.stopped)return;const old=this.entries.get(chat.id);if(old){clearTimeout(old.timer);old.stream.close();}
    const stream=this.streamFactory({endpoint:this.endpoint,conversationId:chat.id,expectedCwd:chat.cwd}),ledgerFile=path.join(this.runtime,chat.id+'-approvals.json');
    const approvals=new DesktopApprovals(stream,{enabled:chat.approvals,ledger:new Map(readPrivate(ledgerFile,[])),save:ledger=>writePrivate(ledgerFile,[...ledger])});
    const e={chat,stream,approvals};this.entries.set(chat.id,e);
    stream.on('state',()=>this.dirty(e));stream.on('unavailable',()=>this.dirty(e));
    e.connecting=true;void stream.start().then(()=>this.log({event:'desktop.observer.ready',conversationId:chat.id})).catch(async error=>{stream.close();e.retryAfter=Date.now()+(error.code==='desktop_owner_unavailable'?2000:30000);this.error(error,chat.id);
      // Reading an unloaded chat must also load its native view. This has no
      // prompt and never starts/steers a turn. Only explicit local opt-ins use it.
      if(error.code==='desktop_owner_unavailable'&&!this.stopped&&this.entries.get(chat.id)===e&&this.isAllowed(chat))try{await this.prepareHistory?.(chat);}catch(failure){this.error(failure,chat.id);}
    }).finally(()=>{e.connecting=false;this.dirty(e);});
  }
  dirty(e){if(this.stopped||!e||this.entries.get(e.chat.id)!==e)return;e.dirty=true;if(!e.sending){clearTimeout(e.timer);e.timer=setTimeout(()=>void this.flush(e),40);}}
  async flush(e){
    if(e.sending||this.stopped||this.entries.get(e.chat.id)!==e)return;e.sending=true;
    try{while(e.dirty&&!this.stopped){e.dirty=false;const view=desktopView(e.stream,{approvalLedger:e.approvals.ledger});view.capabilities={...view.capabilities,...(e.chat.mobileReceive===true?{mobileReceive:true}:{}),...(e.chat.archived===true?{archived:true}:{}),...e.stream.capabilities};if(!e.chat.approvals||e.stream.capabilities?.archived)for(const a of view.approvals)a.canRespond=false;const hash=JSON.stringify(view);if(e.hash===hash)continue;await this.call('/api/agent/desktop/projection',{publisherEpoch:this.epoch,view});e.hash=hash;}}
    catch(error){e.dirty=true;this.error(error,e.chat.id);if(error.status>=400&&error.status<500&&![401,403,409].includes(error.status)){e.stream.invalidate(error.code??'desktop_projection_failed');e.retryAfter=Date.now()+30000;}}
    finally{e.sending=false;if(e.dirty&&!this.stopped)e.timer=setTimeout(()=>void this.flush(e),1000);}
  }
  error(error,conversationId){if(Date.now()-(this.lastError??0)<10000)return;this.lastError=Date.now();this.log({event:'desktop.observer.unavailable',conversationId,code:error.code??'network_unavailable'});}
  async maintain(){if(this.stopped||this.maintaining)return;this.maintaining=true;
    try{const value=await this.call('/api/agent/desktop/ping',{epoch:this.epoch});for(const chat of this.chats){if((!this.lazy||value.conversationIds?.includes(chat.id))&&this.isAllowed(chat)){if(!this.entries.has(chat.id))this.connect(chat);else if(value.resyncIds?.includes(chat.id)&&this.entries.get(chat.id).stream.ready){const e=this.entries.get(chat.id);e.hash=null;this.dirty(e);}}else if(this.entries.has(chat.id)){const e=this.entries.get(chat.id);e.stream.close();clearTimeout(e.timer);const view=desktopView(e.stream);await this.call('/api/agent/desktop/projection',{publisherEpoch:this.epoch,view});this.entries.delete(chat.id);}}}catch(error){this.error(error);try{await this.hello();for(const e of this.entries.values()){e.hash=null;this.dirty(e);}}catch{}}
    finally{for(const e of this.entries.values())if(!e.stream.ready&&!e.connecting&&Date.now()>(e.retryAfter??0))this.connect(e.chat);this.maintaining=false;}
  }
  async claims(){while(!this.stopped){try{
    const {intent}=await this.call('/api/agent/desktop/claim',{epoch:this.epoch},25000);if(!intent||this.stopped)continue;
    // A claimed cloud intent is never replayed. The local durable ledger is
    // written before native effects, even if the ACK or cloud result is lost.
    const e=this.entries.get(intent.conversationId);let result;
    try{if(!e?.chat.approvals||!this.isAllowed(e.chat)||e.stream.epoch!==intent.viewEpoch)throw Object.assign(Error(),{code:'desktop_approval_stale'});result=await e.approvals.respond(intent);}
    catch(error){result={state:'rejected',code:error.code??'desktop_approval_rejected'};}
    await this.call('/api/agent/desktop/result',{epoch:this.epoch,intentId:intent.intentId,state:result.state,...(result.code?{code:result.code}:{})});this.dirty(e);
  }catch(error){if(!this.stopped){this.error(error);await new Promise(r=>setTimeout(r,1000));}}}}
  async stop(){this.stopped=true;clearInterval(this.timer);for(const e of this.entries.values()){clearTimeout(e.timer);e.stream.close();}await this.loop;}
}
