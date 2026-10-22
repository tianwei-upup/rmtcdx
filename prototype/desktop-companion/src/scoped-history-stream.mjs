import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {DesktopStream,streamError} from './desktop-stream.mjs';
// Only the selected history is read. Native following never loads a view or
// starts a turn; archived and missing-workspace histories remain file snapshots.
export class ScopedHistoryStream extends EventEmitter {
 constructor({scope,history,...options}){super();Object.assign(this,options,{scope,history});this.ready=false;this.epoch=crypto.randomUUID();this.revision=0;this.closed=false;}
 async start(){this.refresh();this.timer=setInterval(()=>this.refresh(),1000);return this;}
 refresh(){if(this.closed)return;try{
  const {signature,state,chat}=this.history.read(this.conversationId);
  if(chat.archived||!chat.workspaceAvailable){this.native?.close();this.native=null;}
  if(!this.native?.ready){if(this.mode==='native'){this.epoch=crypto.randomUUID();this.revision=0;}this.mode='snapshot';this.capabilities={historySnapshot:true,nativeIncrementalText:false,approvals:false,archived:chat.archived,workspaceAvailable:chat.workspaceAvailable,mobileReceive:!chat.archived&&chat.workspaceAvailable};
   if(signature!==this.signature||this.lastArchive!==chat.archived||this.lastAvailable!==chat.workspaceAvailable||!this.ready){this.signature=signature;this.lastArchive=chat.archived;this.lastAvailable=chat.workspaceAvailable;this.state=structuredClone(state);if(chat.archived)for(const t of this.state.turns)if(t.status==='inProgress')t.status='interrupted';this.ready=true;this.revision++;this.emit('state');}
  }
  if(!chat.archived&&chat.workspaceAvailable&&!this.native&&Date.now()>(this.retryAfter??0))this.attach();
 }catch(e){this.native?.close();this.native=null;this.invalidate(e.code??'history_unavailable');}}
 attach(){const n=new DesktopStream({endpoint:this.endpoint,conversationId:this.conversationId,expectedCwd:this.expectedCwd});this.native=n;
  n.on('state',()=>{if(this.closed||this.native!==n)return;try{const c=this.scope.check(this.conversationId);if(c.archived)throw streamError('archived_conversation_readonly');this.mode='native';this.ready=n.ready;this.state=n.state;this.owner=n.owner;this.epoch=n.epoch;this.revision=n.revision;this.capabilities={historySnapshot:false,nativeIncrementalText:true,archived:false,workspaceAvailable:c.workspaceAvailable,mobileReceive:c.workspaceAvailable};this.emit('state');}catch(e){n.close();this.invalidate(e.code);}});
  n.on('unavailable',()=>{if(this.native===n){this.native=null;n.close();this.signature=null;this.retryAfter=Date.now()+5000;this.refresh();}});
  void n.start().catch(()=>{if(this.native===n)this.native=null;n.close();this.retryAfter=Date.now()+5000;});
 }
 request(...args){this.scope.check(this.conversationId,{write:true});if(!this.native?.ready||this.mode!=='native')throw streamError('desktop_unavailable');return this.native.request(...args);}
 invalidate(code){const was=this.ready;this.ready=false;this.unavailable=code;if(was)this.emit('unavailable',{code});}
 close(){this.closed=true;clearInterval(this.timer);const n=this.native;this.native=null;n?.close();this.invalidate('desktop_observer_closed');}
}
