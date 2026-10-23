import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {DesktopStream,streamError} from './desktop-stream.mjs';
import {mergeHistory} from './history-merge.mjs';
export {mergeHistory} from './history-merge.mjs';

// Selected file history is the durable prefix; the owner supplies live deltas.
// This observer never loads a view or starts a turn.
export class ScopedHistoryStream extends EventEmitter {
 constructor({scope,history,streamFactory=options=>new DesktopStream(options),...options}){super();Object.assign(this,options,{scope,history,streamFactory});this.ready=false;this.epoch=crypto.randomUUID();this.revision=0;this.closed=false;}
 async start(){this.refresh();this.timer=setInterval(()=>this.refresh(),1000);return this;}
 render(){
  const {signature,state,chat}=this.snapshot,n=this.native?.ready&&!chat.archived&&chat.workspaceAvailable?this.native:null;
  const key=JSON.stringify([signature,chat.archived,chat.workspaceAvailable,n?.epoch,n?.revision]);if(this.key===key&&this.ready)return;
  this.key=key;this.mode=n?'native':'snapshot';this.state=n?mergeHistory(state,n.state):structuredClone(state);this.owner=n?.owner;
  if(chat.archived)for(const t of this.state.turns??[])if(t.status==='inProgress')t.status='interrupted';
  this.capabilities={historySnapshot:!n,nativeIncrementalText:Boolean(n),...(n?{}:{approvals:false}),archived:chat.archived,workspaceAvailable:chat.workspaceAvailable,mobileReceive:!chat.archived&&chat.workspaceAvailable};
  this.ready=true;this.unavailable=null;this.revision++;this.emit('state');
 }
 refresh(){if(this.closed)return;try{
  this.snapshot=this.history.read(this.conversationId);const {chat}=this.snapshot;
  if(chat.archived||!chat.workspaceAvailable){const n=this.native;this.native=null;n?.close();}
  this.render();
  if(!chat.archived&&chat.workspaceAvailable&&!this.native&&Date.now()>(this.retryAfter??0))this.attach();
 }catch(e){const n=this.native;this.native=null;n?.close();this.invalidate(e.code??'history_unavailable');}}
 attach(){const n=this.streamFactory({endpoint:this.endpoint,conversationId:this.conversationId,expectedCwd:this.expectedCwd});this.native=n;
  n.on('state',()=>{if(this.closed||this.native!==n)return;try{const c=this.scope.check(this.conversationId);if(c.archived)throw streamError('archived_conversation_readonly');this.refresh();}catch(e){this.native=null;n.close();this.invalidate(e.code);}});
  n.on('unavailable',()=>{if(this.native===n){this.native=null;n.close();this.key=null;this.retryAfter=Date.now()+5000;this.refresh();}});
  void n.start().catch(()=>{if(this.native===n)this.native=null;n.close();this.retryAfter=Date.now()+5000;this.refresh();});
 }
 request(...args){this.scope.check(this.conversationId,{write:true});if(!this.native?.ready||this.mode!=='native')throw streamError('desktop_unavailable');return this.native.request(...args);}
 invalidate(code){const was=this.ready;this.ready=false;this.unavailable=code;if(was)this.emit('unavailable',{code});}
 close(){this.closed=true;clearInterval(this.timer);const n=this.native;this.native=null;n?.close();this.invalidate('desktop_observer_closed');}
}
