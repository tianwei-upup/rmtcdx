import {control} from './control.mjs';
import {handlingInstructions} from './execution-policy.mjs';
export async function mobileQueueTool({scope,history,threadId,activationId,operation,args,call=control}){
 if(!threadId||!/^[-0-9a-f]{36}$/.test(activationId))throw Object.assign(Error(),{code:'caller_scope_mismatch'});
 const allowed={status:[],listen:['windowMs','maxJobs','waitMs'],take:['sessionId','waitMs'],checkpoint:['intentId','leaseToken'],reply:['sessionId','intentId','leaseToken','result','takeNext','waitMs'],progress:['intentId','leaseToken','seq','text'],ack_cancel:['intentId','leaseToken'],close:['sessionId']};
 if(!allowed[operation]||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!allowed[operation].includes(k)))throw Object.assign(Error(),{code:'invalid_queue_operation'});
 const chat=scope.check(threadId,{write:!['status','checkpoint','reply','ack_cancel','close'].includes(operation)}),{state}=history.read(threadId),active=state.turns.filter(t=>t.status==='inProgress');
 const turn=active.find(t=>t.items.some(i=>i.type==='userMessage'&&i.clientId===activationId));
 if(active.length!==1||!turn)throw Object.assign(Error(),{code:'caller_turn_mismatch'});
 if(args.waitMs!==undefined&&(!Number.isInteger(args.waitMs)||args.waitMs<0||args.waitMs>60000))throw Object.assign(Error(),{code:'invalid_queue_wait'});
 const op=operation==='status'?'status':'inbox_'+operation;
 const value=await call(scope.route(threadId),{...args,threadId,consumerTurnId:turn.turnId,operation:op},Math.max(30000,(args.waitMs??0)+5000));
 const mode=chat.archived?'readonly':'desktop';return{...value,executionMode:mode,handlingInstructions:handlingInstructions(mode),__rmtMobileQueue:'personal-v1',queueOperation:operation,...(args.intentId?{queueIntentId:args.intentId}:{})};
}
