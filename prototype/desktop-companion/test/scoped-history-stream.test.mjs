import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ScopedHistoryStream,mergeHistory} from '../src/scoped-history-stream.mjs';
import {desktopView} from '../src/desktop-view.mjs';
const turn=(turnId,text,status='completed')=>({turnId,status,completionObserved:status==='completed',items:[{type:'agentMessage',id:turnId+'-answer',text}],completedItemIds:status==='completed'?[turnId+'-answer']:[]});
class Native extends EventEmitter{async start(){}close(){this.closed=true;}request(...a){return a;}}
function fixture(t){
 const chat={archived:false,workspaceAvailable:true},file={id:'chat',turns:[turn('old','older'),turn('recent','persisted')],turnsPagination:{hasMore:false},requests:[]};
 let signature='one';const native=new Native(),s=new ScopedHistoryStream({conversationId:'chat',scope:{check:()=>chat},history:{read:()=>({signature,state:file,chat})},streamFactory:()=>native});
 t.after(()=>s.close());return{chat,file,native,s,changed:()=>signature+='x',emit:(turns,complete=false)=>{native.ready=true;native.owner='owner';native.epoch='native';native.revision=(native.revision??0)+1;native.state={id:'chat',turns,turnsPagination:{hasMore:!complete},requests:[]};native.emit('state');}};
}
test('live partial history retains the complete file prefix and publishes real text updates',async t=>{
 const f=fixture(t);Object.assign(f.file.turns[1],{status:'inProgress',completionObserved:false});await f.s.start();f.emit([turn('recent','streaming','inProgress')]);let v=desktopView(f.s);assert(v.historyComplete);assert.deepEqual(v.items.map(i=>i.text),['older','streaming']);const revision=f.s.revision;
 f.file.turns.push(turn('from-file','new persisted'));f.changed();f.s.refresh();v=desktopView(f.s);assert(v.items.some(i=>i.text==='new persisted'));assert(f.s.revision>revision);
});
test('file completion cannot be resurrected by an older in-progress follower snapshot',async t=>{
 const f=fixture(t);await f.s.start();f.emit([turn('recent','old partial','inProgress')]);assert.equal(desktopView(f.s).activeTurnId,null);
 f.emit([turn('fresh','real live','inProgress')]);assert.equal(desktopView(f.s).activeTurnId,'fresh');assert(desktopView(f.s).historyComplete);
});
test('archive and owner disconnect immediately discard approvals and native write routing',async t=>{
 const f=fixture(t);await f.s.start();f.emit([turn('recent','live')]);f.native.state.requests=[{id:'approval',method:'item/commandExecution/requestApproval',params:{command:'test'}}];f.native.emit('state');
 f.chat.archived=true;f.changed();f.s.refresh();assert(f.native.closed);assert.equal(f.s.capabilities.archived,true);assert.equal(desktopView(f.s).approvals.length,0);assert.throws(()=>f.s.request('x'),{code:'desktop_unavailable'});
});
test('canonical islands, object completion maps and legacy synthetic IDs merge in native order without duplicate messages',()=>{
 const old=turn('old','same');old.items[0].id='agent:10';const file={id:'chat',turns:[old,turn('last','end')],turnsPagination:{hasMore:false}};
 const nativeOld=turn('old','same');nativeOld.completedItemIds={'old-answer':true};const state={id:'chat',turnHistory:{kind:'canonical',history:{isComplete:false,islands:[{entries:[{value:'first'},{value:'middle'},{value:'last'}]}],entitiesByKey:{first:nativeOld,middle:turn('middle','between'),last:turn('last','end')}}}};
 const merged=mergeHistory(file,state);assert.deepEqual(merged.turns.map(t=>t.turnId),['old','middle','last']);assert.equal(merged.turns[0].items.length,1);assert(desktopView({ready:true,state:merged}).historyComplete);
});
