import test from 'node:test';import assert from 'node:assert/strict';
import {historyLoader}from'../src/desktop-history-loader.mjs';
import {HISTORY_QUEUE_TEST_ID,RN_HISTORY_PROJECT}from'../src/native-history-queue.mjs';
const rn='01a133ec-0862-7f91-bc8b-7246c2ca8b9d';
function fixture(){let now=1000,archived=0,member=true,running=true,version='0.163.0-alpha.10.2';const calls=[];const load=historyLoader({enabled:true,membership:{projectId:RN_HISTORY_PROJECT,projectName:'壳工程RN UI相关',stateFile:'/state'},metadata:()=>({cwd:'/rn',archived}),projects:()=>[{id:RN_HISTORY_PROJECT,name:'壳工程RN UI相关',threadIds:member?[rn]:[],paths:['/rn']}],now:()=>now,readVersion:()=>version,run:async(file,args)=>{calls.push({file,args});return {stdout:running?`${process.getuid()} 42 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n`:''};}});return{load,calls,chat:{id:rn,cwd:'/rn',mobileReceive:true},set:v=>{({now=now,archived=archived,member=member,running=running,version=version}=v);}};}
test('unloaded read demand opens only a no-prompt native URL, with serialized cooldown',async()=>{
 const f=fixture();await Promise.all([f.load(f.chat),f.load(f.chat)]);assert.equal(f.calls.filter(c=>c.file==='/usr/bin/open').length,1);assert.deepEqual(f.calls[1].args,['-g','-a','/Applications/ChatGPT.app','codex://threads/'+rn]);f.set({now:32000});await f.load(f.chat);assert.equal(f.calls.filter(c=>c.file==='/usr/bin/open').length,2);
});
test('read entry rechecks archive, membership, build and existing desktop; never starts the application',async()=>{
 for(const change of [{archived:1},{member:false},{version:'new-build'},{running:false}]){const f=fixture();f.set(change);await assert.rejects(f.load(f.chat));assert.equal(f.calls.filter(c=>c.file==='/usr/bin/open').length,0);}
 const f=fixture();await f.load({...f.chat,archived:true});await f.load({...f.chat,mobileReceive:false});await assert.rejects(f.load({...f.chat,id:'not-allowed'}));assert.equal(f.calls.length,0);
});
test('view loading stays disabled without explicit local opt in',async()=>{let called=false;await historyLoader({run:async()=>{called=true;}})({id:HISTORY_QUEUE_TEST_ID,mobileReceive:true});assert.equal(called,false);});
test('verified alpha.11.1 build can load the original view without starting another desktop',async()=>{
 const f=fixture();f.set({version:'0.163.0-alpha.11.1'});await f.load(f.chat);
 assert.equal(f.calls.filter(c=>c.file==='/usr/bin/open').length,1);
 assert.deepEqual(f.calls[1].args,['-g','-a','/Applications/ChatGPT.app','codex://threads/'+rn]);
});
