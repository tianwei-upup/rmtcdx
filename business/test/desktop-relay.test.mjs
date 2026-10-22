import test from 'node:test';import assert from 'node:assert/strict';
import {DesktopRelay} from '../src/desktop-relay.mjs';import {mergeDesktopQueue} from '../web/desktop-merge.mjs';
const queueScopes=[{mode:'dedicated-test',deviceId:'mac',projectId:'project',conversationId:'chat'}],scopes=[{deviceId:'mac',projectId:'project',conversations:[{id:'chat',approvals:true}]}];
const view=(revision=1)=>({conversationId:'chat',epoch:'native',revision,available:true,historyComplete:true,items:[{id:'text',kind:'assistant',text:'PRIVATE-TEXT'}],approvals:[{id:'approval',canRespond:true}]});
test('switching histories releases old RAM and late inactive projections cannot refill it; active viewers remain demanded',()=>{
 const chats=['a','b'].map(id=>({id,approvals:false}));const r=new DesktopRelay({scopes:[{deviceId:'mac',projectId:'project',conversations:chats}],queueScopes:[{mode:'project-readonly',deviceId:'mac',projectId:'project',projectName:'P',conversations:chats.map(c=>({...c,title:c.id,archived:false}))}]});
 r.projection.maxBytes=2200;r.hello('mac',{epoch:'p',conversationIds:['a','b']});
 const put=id=>r.update('mac',{publisherEpoch:'p',view:{...view(),conversationId:id,approvals:[],items:[{id:'large',kind:'assistant',text:'x'.repeat(1200)}]}});
 assert.throws(()=>r.read('a'));put('a');assert.equal(r.read('a').items[0].text.length,1200);
 assert.throws(()=>r.read('b'));put('b');assert.equal(r.projection.states.get('a').items.length,0);assert.equal(r.read('b').items[0].text.length,1200);
 put('a');assert.equal(r.projection.states.get('a').items.length,0);assert.deepEqual(r.ping('mac','p').conversationIds,['b']);
 const close=r.subscribe('a',()=>{});assert.deepEqual(r.ping('mac','p').conversationIds,['a']);assert.deepEqual(r.ping('mac','p').resyncIds,['a']);
 const close2=r.subscribe('b',()=>{});assert.deepEqual(r.ping('mac','p').conversationIds,['a','b']);close();close2();r.close();
});
test('exact grant, publisher fencing, one-shot approval, owner resolution and expiry',()=>{
 let now=0;const r=new DesktopRelay({scopes,queueScopes,now:()=>now});assert.throws(()=>r.hello('other',{epoch:'one',conversationIds:['chat']}));r.hello('mac',{epoch:'one',conversationIds:['chat']});
 assert.throws(()=>r.hello('mac',{epoch:'two',conversationIds:['chat']}));assert.throws(()=>r.update('mac',{publisherEpoch:'one',view:{...view(),conversationId:'foreign'}}));
 r.update('mac',{publisherEpoch:'one',view:view()});const intent={approvalId:'approval',decision:'decline',intentId:'intent'};assert.equal(r.submit('chat',intent).state,'queued');assert.equal(r.submit('chat',intent).state,'queued');assert.throws(()=>r.submit('chat',{...intent,decision:'accept'}));assert.throws(()=>r.submit('chat',{...intent,intentId:'second'}));
 assert.equal(r.claim('mac','one').intentId,'intent');assert.equal(r.claim('mac','one'),null);now=31000;r.prune();assert.equal(r.receipt('chat','intent').state,'unknown');assert.equal(r.claim('mac','one'),null);
 r.ping('mac','one');r.update('mac',{publisherEpoch:'one',view:{...view(2),approvals:[]}});assert.equal(r.receipt('chat','intent').state,'resolved');assert.equal(r.submit('chat',intent).state,'resolved');
 now+=9000;r.prune();assert.equal(r.read('chat').available,false);r.hello('mac',{epoch:'two',conversationIds:['chat']});assert.throws(()=>r.update('mac',{publisherEpoch:'one',view:view(3)}));r.close();assert.equal(r.intents.size,0);
});
test('unknown or read-only scope never gets approval privileges',()=>{
 assert.throws(()=>new DesktopRelay({scopes:[{...scopes[0],projectId:'other'}],queueScopes}));
 const r=new DesktopRelay({scopes:[{...scopes[0],conversations:[{id:'chat',approvals:false}]}],queueScopes});r.hello('mac',{epoch:'one',conversationIds:['chat']});r.update('mac',{publisherEpoch:'one',view:view()});assert.equal(r.read('chat').approvals[0].canRespond,false);assert.throws(()=>r.submit('chat',{intentId:'intent',approvalId:'approval',decision:'decline'}));
});
test('queue merge uses exact identity, retains native tools and identical distinct messages',()=>{
 const receipts=[{intentId:'a',text:'same',consumerTurnId:'turn'},{intentId:'b',text:'same',consumerTurnId:'turn'}];
 const items=[{id:'old',kind:'user',text:'same'},{id:'take',kind:'tool',queueLinks:[{intentId:'a',phase:'received'}]},{id:'cmd',kind:'tool',type:'commandExecution'},{id:'reply',kind:'tool',queueLinks:[{intentId:'a',phase:'reply'},{intentId:'b',phase:'received'}]}];
 assert.deepEqual(mergeDesktopQueue(items,receipts).map(i=>i.id),['old','queue:a','cmd','queue:b']);assert.deepEqual(mergeDesktopQueue(items,[]),items);assert.equal(mergeDesktopQueue([],[{intentId:'local',state:'sending'}])[0].receipt.state,'sending');
});
test('old unclaimed phone receipts never displace the newest desktop answer',()=>{
 const native=[{id:'old',kind:'assistant',at:100},{id:'new',kind:'assistant',at:300}],receipts=[{intentId:'cancelled',state:'cancelled',timing:{enqueuedAt:200}},{intentId:'sending',state:'sending',timing:{enqueuedAt:400}}];assert.deepEqual(mergeDesktopQueue(native,receipts).map(i=>i.id),['old','queue:cancelled','new','queue:sending']);
});

test('desktop execution display is an explicit scope setting and never grants itself approvals',()=>{
 const r=new DesktopRelay({scopes:[{...scopes[0],executionMode:'desktop',conversations:[{id:'chat',approvals:false}]}],queueScopes});
 assert.equal(r.executionMode('mac'),'desktop');assert.equal(r.executionMode('other'),'readonly');
 r.hello('mac',{epoch:'one',conversationIds:['chat']});r.update('mac',{publisherEpoch:'one',view:view()});assert.equal(r.read('chat').approvals[0].canRespond,false);r.close();
 assert.throws(()=>new DesktopRelay({scopes:[{...scopes[0],executionMode:'full-access-bypass'}],queueScopes}));
});
