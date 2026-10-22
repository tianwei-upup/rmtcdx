import test from 'node:test';
import assert from 'node:assert/strict';
import {canAutoReceive} from '../web/queue-state.mjs';
test('personal queue remains automatic before desktop history is available',()=>{
  assert.equal(canAutoReceive({config:{mode:'personal-projects'},chat:{archived:false,workspaceAvailable:true}}),true);
});
test('archive, missing workspace and disabled writes never advertise automatic reception',()=>{
  const base={config:{mode:'personal-projects'},chat:{archived:false,workspaceAvailable:true},capabilities:{}};
  for(const value of [{...base,chat:null},{...base,chat:{archived:true}},{...base,chat:{workspaceAvailable:false}},{...base,capabilities:{archived:true}},{...base,capabilities:{workspaceAvailable:false}},{...base,config:{mode:'personal-projects',queueWrites:false}}])assert.equal(canAutoReceive(value),false);
});
test('legacy queues still require their own explicit mobile-receive capability',()=>{
  assert.equal(canAutoReceive({config:{mode:'project-readonly'},chat:{archived:false}}),false);
  assert.equal(canAutoReceive({config:{mode:'project-readonly'},chat:{archived:false},capabilities:{mobileReceive:true}}),true);
});
