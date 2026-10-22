import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export const streamError=code=>Object.assign(new Error(code),{code});
const forbidden=new Set(['__proto__','prototype','constructor']);
// Desktop uses Immer-style array paths. Never apply an unfenced patch or an
// inherited-property traversal, even when the transport is a local owner.
export function applyDesktopPatches(source,patches){
  const root=structuredClone(source);
  for(const patch of patches){
    if(!Array.isArray(patch.path)||!patch.path.length||patch.path.length>100||!['add','replace','remove'].includes(patch.op))throw streamError('invalid_desktop_patch');
    let parent=root;for(const key of patch.path.slice(0,-1)){if(forbidden.has(String(key))||!parent||!Object.hasOwn(parent,key))throw streamError('invalid_desktop_patch');parent=parent[key];}
    const key=patch.path.at(-1);if(forbidden.has(String(key))||!parent||typeof parent!=='object')throw streamError('invalid_desktop_patch');
    if(Array.isArray(parent)){
      if(!Number.isSafeInteger(key)||key<0||key>parent.length||patch.op!=='add'&&key>=parent.length)throw streamError('invalid_desktop_patch');
      if(patch.op==='remove')parent.splice(key,1);else if(patch.op==='add')parent.splice(key,0,structuredClone(patch.value));else parent[key]=structuredClone(patch.value);
    }else if(patch.op==='remove'){if(!Object.hasOwn(parent,key))throw streamError('invalid_desktop_patch');delete parent[key];}
    else {if(patch.op==='replace'&&!Object.hasOwn(parent,key))throw streamError('invalid_desktop_patch');Object.defineProperty(parent,key,{value:structuredClone(patch.value),enumerable:true,writable:true,configurable:true});}
  }
  return root;
}

// Follower only: no owner acquisition, thread resume/start/steer/interrupt, or
// native tools pipe. A disconnected or changed owner always invalidates state.
export class DesktopStream extends EventEmitter {
  constructor({endpoint,conversationId,expectedCwd,timeoutMs=20000,historyTimeoutMs=120000,maxFrame=64*1024*1024}){
    super();Object.assign(this,{endpoint,conversationId,expectedCwd,timeoutMs,historyTimeoutMs,maxFrame});this.pending=new Map();this.buffer=Buffer.alloc(0);this.ready=false;this.revision=-1;this.epoch=crypto.randomUUID();
  }
  async start(){
    const st=fs.lstatSync(this.endpoint);if(!st.isSocket()||st.uid!==process.getuid()||(st.mode&0o077))throw streamError('unsafe_desktop_ipc');
    this.socket=net.createConnection(this.endpoint);this.clientId='initializing-client';
    this.socket.on('data',chunk=>{try{this.consume(chunk);}catch(error){this.invalidate(error.code??'invalid_desktop_frame');this.socket.destroy();}});
    this.socket.on('error',()=>this.invalidate('desktop_disconnected'));this.socket.on('close',()=>{this.invalidate('desktop_disconnected');for(const p of this.pending.values())p.reject(streamError('desktop_disconnected'));this.pending.clear();});
    await new Promise((resolve,reject)=>{this.socket.once('connect',resolve);this.socket.once('error',reject);});
    const init=await this.request('initialize',{clientType:'rmtcdx-dedicated-desktop-follower'},undefined,0);this.clientId=init.clientId;
    const owner=await this.rpc('thread-owner-discovery',{hostId:'local',conversationId:this.conversationId},undefined,1);if(owner.resultType!=='success')throw streamError('desktop_owner_unavailable');this.owner=owner.handledByClientId;
    this.follow(true);await this.request('thread-follower-load-complete-history',{conversationId:this.conversationId},this.owner,1,this.historyTimeoutMs);
    if(!this.ready)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.off('state',done);reject(streamError('desktop_snapshot_timeout'));},this.timeoutMs);const done=()=>{if(this.ready){clearTimeout(timer);this.off('state',done);resolve();}};this.on('state',done);});
    return this;
  }
  send(value){if(!this.socket?.writable)throw streamError('desktop_disconnected');const data=Buffer.from(JSON.stringify(value));if(data.length>this.maxFrame)throw streamError('desktop_frame_limit');const frame=Buffer.alloc(data.length+4);frame.writeUInt32LE(data.length);data.copy(frame,4);this.socket.write(frame);}
  rpc(method,params,targetClientId,version=1,timeoutMs=this.timeoutMs){
    const allowed=['initialize','thread-owner-discovery','thread-follower-load-complete-history','thread-follower-command-approval-decision','thread-follower-file-approval-decision'];
    if(!allowed.includes(method)||method!=='initialize'&&params.conversationId!==this.conversationId)throw streamError('desktop_scope_rejected');
    const requestId=crypto.randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(requestId);reject(streamError('desktop_request_unknown'));},timeoutMs);this.pending.set(requestId,{resolve:v=>{clearTimeout(timer);resolve(v);},reject:e=>{clearTimeout(timer);reject(e);}});this.send({type:'request',requestId,sourceClientId:this.clientId,method,params,targetClientId,version,timeoutMs});});
  }
  async request(...args){const response=await this.rpc(...args);if(response.resultType!=='success')throw streamError('desktop_request_rejected');return response.result;}
  follow(following){this.send({type:'broadcast',method:'thread-stream-following-changed',sourceClientId:this.clientId,targetClientIds:[this.owner],params:{hostId:'local',conversationId:this.conversationId,following},version:1});}
  consume(chunk){
    this.buffer=Buffer.concat([this.buffer,chunk]);
    while(this.buffer.length>=4){const size=this.buffer.readUInt32LE();if(size>this.maxFrame)throw streamError('desktop_frame_limit');if(this.buffer.length<size+4)return;const value=JSON.parse(this.buffer.subarray(4,size+4));this.buffer=this.buffer.subarray(size+4);this.message(value);}
  }
  message(message){
    if(message.type==='response'){this.pending.get(message.requestId)?.resolve(message);this.pending.delete(message.requestId);return;}
    if(message.type==='client-discovery-request'){this.send({type:'client-discovery-response',requestId:message.requestId,response:{canHandle:false}});return;}
    if(message.type!=='broadcast')return;
    if(message.method==='client-status-changed'&&message.params?.clientId===this.owner&&message.params.status==='disconnected'){this.invalidate('desktop_owner_changed');return;}
    if(message.method==='ipc-connection-reset'){this.invalidate('desktop_epoch_changed');return;}
    if(message.params?.conversationId!==this.conversationId||message.params?.hostId!=='local')return;
    if(message.sourceClientId!==this.owner)return;
    if(['thread-archived','thread-unarchived'].includes(message.method)){
      this.invalidate('desktop_conversation_reloaded');this.socket?.destroy();return;
    }
    if(message.method!=='thread-stream-state-changed')return;
    if(message.version!==11)throw streamError('desktop_protocol_unsupported');
    const change=message.params.change;
    if(!Number.isSafeInteger(change?.revision)||change.revision<0)throw streamError('invalid_desktop_revision');
    if(change.type==='snapshot'){
      if(this.ready&&change.revision<this.revision)return;
      const state=change.conversationState;
      if(state?.id!==this.conversationId||state.cwd!==this.expectedCwd)throw streamError('desktop_scope_rejected');
      this.state=structuredClone(state);this.revision=change.revision;this.ready=true;
    }else if(change.type==='patches'){
      if(!this.ready||change.baseRevision!==this.revision||change.revision<=change.baseRevision){this.invalidate('desktop_revision_gap');this.follow(true);return;}
      const state=applyDesktopPatches(this.state,change.patches);
      if(state.id!==this.conversationId||state.cwd!==this.expectedCwd)throw streamError('desktop_scope_rejected');
      this.state=state;this.revision=change.revision;
    }else throw streamError('invalid_desktop_change');
    this.emit('state',{epoch:this.epoch,revision:this.revision,state:this.state,change});
  }
  invalidate(code){const previous=this.ready;this.ready=false;this.unavailable=code;if(previous)this.emit('unavailable',{code});}
  close(){try{if(this.owner&&this.socket?.writable)this.follow(false);}finally{this.invalidate('desktop_observer_closed');this.socket?.destroy();}}
}
