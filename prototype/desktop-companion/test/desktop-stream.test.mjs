import test from 'node:test';import assert from 'node:assert/strict';
import {DesktopStream,applyDesktopPatches} from '../src/desktop-stream.mjs';
import {desktopView,DesktopApprovals} from '../src/desktop-view.mjs';
import {activationPrompt} from '../src/history-receiver.mjs';
const id='dedicated',cwd='/dedicated';
function observer(){const o=new DesktopStream({endpoint:'/unused',conversationId:id,expectedCwd:cwd});o.owner='owner';o.follow=()=>{};return o;}
function snapshot(o,state,revision=1){o.message({type:'broadcast',version:11,method:'thread-stream-state-changed',sourceClientId:'owner',params:{hostId:'local',conversationId:id,change:{type:'snapshot',revision,conversationState:{id,cwd,...state}}}});}
function patch(o,patches,baseRevision=1,revision=2){o.message({type:'broadcast',version:11,method:'thread-stream-state-changed',sourceClientId:'owner',params:{hostId:'local',conversationId:id,change:{type:'patches',baseRevision,revision,patches}}});}
test('long complete-history responses use their own budget; approval timeouts remain short',async()=>{
 const o=observer();o.timeoutMs=10;const messages=[];o.send=m=>{messages.push(m);setTimeout(()=>o.message({type:'response',requestId:m.requestId,resultType:'success',result:{ok:true}}),30);};
 await o.request('thread-follower-load-complete-history',{conversationId:id},'owner',1,100);
 await assert.rejects(o.request('thread-follower-command-approval-decision',{conversationId:id},'owner'),{code:'desktop_request_unknown'});
 assert.deepEqual(messages.map(m=>m.timeoutMs),[100,10]);
});
test('native archive lifecycle invalidates the old follower binding',()=>{
 const o=observer();snapshot(o,{turns:[],requests:[]});
 o.message({type:'broadcast',method:'thread-archived',sourceClientId:'foreign',params:{hostId:'local',conversationId:id}});assert(o.ready);
 o.message({type:'broadcast',method:'thread-archived',sourceClientId:'owner',params:{hostId:'local',conversationId:id}});assert(!o.ready);assert.equal(o.unavailable,'desktop_conversation_reloaded');
});
test('only exact receiver control messages become a concise phone connection card',()=>{
 const o=observer(),prompt=activationPrompt('f3abfb6e-bb66-452e-bf14-54df3feef080');
 snapshot(o,{turns:[{turnId:'t',status:'completed',items:[{type:'userMessage',id:'entry',content:[{type:'text',text:prompt}]},{type:'userMessage',id:'real',content:[{type:'text',text:prompt+' actual user content'}]}]}],requests:[]});
 const v=desktopView(o);assert.equal(v.items[0].type,'mobileReceiver');assert.equal(v.items[1].kind,'user');assert.equal(v.items[1].text,prompt+' actual user content');
});
test('native patches are atomic, ordered and cannot traverse prototypes',()=>{
 const source={a:[{text:'one'}]};const result=applyDesktopPatches(source,[{op:'replace',path:['a',0,'text'],value:'two'},{op:'add',path:['a',1],value:{text:'three'}}]);assert.deepEqual(result.a.map(x=>x.text),['two','three']);assert.equal(source.a[0].text,'one');
 assert.throws(()=>applyDesktopPatches(source,[{op:'replace',path:['a',0,'text'],value:'bad'},{op:'add',path:['__proto__','polluted'],value:true}]));assert.equal(source.a[0].text,'one');assert.equal({}.polluted,undefined);
 assert.throws(()=>applyDesktopPatches(source,[{op:'replace',path:['a',4],value:'bad'}]));
});
test('scope/source fences, missing revisions and disconnect invalidate approval readiness',()=>{
 const o=observer();snapshot(o,{turns:[],requests:[]});assert(o.ready);
 o.message({type:'broadcast',method:'thread-stream-state-changed',sourceClientId:'foreign',params:{hostId:'local',conversationId:id,change:{type:'patches',baseRevision:1,revision:2,patches:[]}}});assert.equal(o.revision,1);
 patch(o,[],9,10);assert(!o.ready);assert.equal(desktopView(o).available,false);
 snapshot(o,{turns:[],requests:[]},11);assert(o.ready);
 o.message({type:'broadcast',method:'client-status-changed',params:{clientId:'owner',status:'disconnected'}});assert(!o.ready);
 assert.throws(()=>snapshot(o,{cwd:'/other',turns:[]}));
});
test('canonical history preserves order and full public text but excludes reasoning and native private fields',()=>{
 const o=observer(),turn={turnId:'t',status:'completed',params:{input:[{type:'text',text:'question'}],permissions:{secret:'never-expose'}},items:[{type:'agentMessage',id:'m',text:'x'.repeat(80000)},{type:'reasoning',id:'r',text:'private-reasoning'},{type:'commandExecution',id:'c',status:'completed',command:'pwd',aggregatedOutput:cwd,exitCode:0}]};
 snapshot(o,{turnHistory:{kind:'canonical',history:{isComplete:true,entitiesByKey:{k:turn},islands:[{entries:[{key:'k',value:'k'}]}]}},requests:[],authToken:'private-auth'});
 const v=desktopView(o);assert(v.historyComplete);assert.equal(v.items[0].text,'question');assert.equal(v.items[1].text.length,80000);assert.equal(v.items[2].exitCode,0);assert(!JSON.stringify(v).includes('private-'));assert(!JSON.stringify(v).includes('never-expose'));
 patch(o,[{op:'replace',path:['turnHistory','history','entitiesByKey','k','items',0,'text'],value:'native increment'}]);assert.equal(desktopView(o).items[1].text,'native increment');
});
test('approval responses require exact native request, explicit opt-in, one-shot intent and never replay unknown',async()=>{
 const o=observer();snapshot(o,{turns:[],requests:[{id:42,method:'item/commandExecution/requestApproval',params:{threadId:id,turnId:'t',itemId:'c',command:'pwd'}}]});
 let calls=0;o.request=async(method,params,owner)=>{calls++;assert.equal(method,'thread-follower-command-approval-decision');assert.equal(params.requestId,42);assert.equal(owner,'owner');};
 const approvalId=desktopView(o).approvals[0].id;
 await assert.rejects(new DesktopApprovals(o).respond({approvalId,decision:'accept',intentId:'i'}));
 const a=new DesktopApprovals(o,{enabled:true});assert.equal((await a.respond({approvalId,decision:'decline',intentId:'i'})).state,'submitted');await a.respond({approvalId,decision:'decline',intentId:'i'});assert.equal(calls,1);
 await assert.rejects(a.respond({approvalId,decision:'accept',intentId:'i'}));await assert.rejects(a.respond({approvalId,decision:'accept',intentId:'other'}));
 snapshot(o,{turns:[],requests:[]},2);await assert.rejects(a.respond({approvalId,decision:'accept',intentId:'stale'}));
 snapshot(o,{turns:[],requests:[{id:'r2',method:'item/fileChange/requestApproval',params:{threadId:id,turnId:'t2',itemId:'file'}}]},3);
 o.request=async()=>{calls++;throw Error('lost ACK');};const unknownId=desktopView(o).approvals[0].id;const receipt=await a.respond({approvalId:unknownId,decision:'decline',intentId:'unknown'});assert.equal(receipt.state,'unknown');await a.respond({approvalId:unknownId,decision:'decline',intentId:'unknown'});assert.equal(calls,2);
 o.epoch='reconnected';const restored=new DesktopApprovals(o,{enabled:true,ledger:new Map(a.ledger)});await assert.rejects(restored.respond({approvalId:desktopView(o).approvals[0].id,decision:'decline',intentId:'after-reconnect'}));assert.equal(calls,2);
});
test('unsupported approval types never expose native auth fields or gain response capability',()=>{
 const o=observer();snapshot(o,{turns:[],requests:[{id:'auth',method:'mcpServer/elicitation/request',params:{mode:'openai/userVerification',clientSecret:'do-not-project-secret',url:'https://private.invalid/?token=secret'}}]});const v=desktopView(o);assert(!v.approvals[0].canRespond);assert(!JSON.stringify(v).includes('do-not-project-secret'));assert(!JSON.stringify(v).includes('private.invalid'));
});
test('queue correlations come from exact MCP identities and redact lease credentials',()=>{
 const o=observer();snapshot(o,{turns:[{turnId:'t',status:'completed',items:[{type:'mcpToolCall',id:'take',tool:'rmt_queue_listen',server:'test',arguments:{waitMs:10},result:{content:[{type:'text',text:JSON.stringify({status:'job',intentId:'job-a',leaseToken:'PRIVATE-LEASE',sessionId:'session'})}]}},{type:'mcpToolCall',id:'reply',tool:'rmt_queue_reply',server:'test',arguments:{intentId:'job-a',leaseToken:'PRIVATE-LEASE',result:'answer'},result:{structuredContent:{receipt:{intentId:'job-a'},next:{status:'job',intentId:'job-b',leaseToken:'PRIVATE-LEASE'}}}}]}],requests:[]});
 const v=desktopView(o);assert(!JSON.stringify(v).includes('PRIVATE-LEASE'));assert.deepEqual(v.items[0].queueLinks,[{intentId:'job-a',phase:'received'}]);assert.deepEqual(v.items[1].queueLinks,[{intentId:'job-a',phase:'reply'},{intentId:'job-b',phase:'received'}]);
});
