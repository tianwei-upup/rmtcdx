import crypto from 'node:crypto';
import { streamError } from './desktop-stream.mjs';
import {personalActivationReference,PERSONAL_HELPER} from './personal-activation.mjs';
import { activationReference } from './history-receiver.mjs';
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text=value=>typeof value==='string'?value:Array.isArray(value)?value.map(v=>v.type==='text'||v.type==='input_text'||v.type==='output_text'?v.text??'':'').filter(Boolean).join('\n'):'';
const printable=value=>typeof value==='string'?value:value==null?'':JSON.stringify(value,null,2);
const toolTypes=new Set(['commandExecution','fileChange','mcpToolCall','functionCall','functionCallOutput','webSearch','imageView','toolCall','dynamicToolCall']);
const parsed=v=>{if(typeof v!=='string')return v;try{return JSON.parse(v);}catch{return null;}};
function queuePublic(value){if(typeof value==='string'&&/^[{[]/.test(value)){const v=parsed(value);if(v&&typeof v==='object')return JSON.stringify(queuePublic(v));}if(Array.isArray(value))return value.map(queuePublic);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/token|secret|credential|authorization/i.test(k)).map(([k,v])=>[k,queuePublic(v)]));return value;}
function toolDetail(value){
 const sanitize=(v,k='')=>{if(/^(base64|image_base64|bytes_base64)$/i.test(k))return '[二进制正文已省略]';if(typeof v==='string'&&v.length>8192&&/^[{[]/.test(v)){try{return sanitize(JSON.parse(v));}catch{}}if(Array.isArray(v))return v.map(x=>sanitize(x));if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,k==='data'&&v.type==='image'?'[图片正文已省略]':sanitize(x,k)]));return v;};
 const result=printable(sanitize(value));return result.length>8192?result.slice(0,4096)+'\n[工具详情过长，手机展示首尾摘要；完整详情请在桌面查看]\n'+result.slice(-4096):result;
}
function queueMetadata(item){
  const helper=item.type==='commandExecution'&&String(item.command).includes(PERSONAL_HELPER);
  const helperResult=helper?parsed(item.aggregatedOutput??item.output):null;
  if(helper&&!helperResult)return{links:[],detail:'手机队列兼容工具',output:'队列工具运行中或未返回公开结果。'};
  const name=helper?'rmt_queue_'+helperResult.queueOperation:item.tool??item.name??'',match=/rmt_queue_(\w+)/.exec(name);if(!match)return helper?{links:[],detail:'手机队列兼容工具',output:printable(queuePublic(helperResult))}:null;
  const args=helper?{intentId:helperResult.queueIntentId}:parsed(item.arguments)??{},result=helperResult??item.result?.structuredContent??parsed(text(item.result?.content))??parsed(item.output)??{},links=[];
  const add=(id,phase)=>{if(typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id)&&!links.some(l=>l.intentId===id&&l.phase===phase))links.push({intentId:id,phase});};
  if(args.intentId)add(args.intentId,match[1]==='progress'?'progress':['reply','complete'].includes(match[1])?'reply':'cancel');
  if(result.status==='job')add(result.job?.intentId??result.intentId,'received');
  if(result.next?.status==='job')add(result.next.job?.intentId??result.next.intentId,'received');
  return {links,detail:printable(queuePublic(args)),output:printable(queuePublic(result))};
}
export const approvalMethods={
 'item/commandExecution/requestApproval':'thread-follower-command-approval-decision',
 'item/fileChange/requestApproval':'thread-follower-file-approval-decision'
};
export function nativeTurns(state){
  const h=state.turnHistory;
  if(h?.kind!=='canonical')return {turns:state.turns??[],complete:state.turnsPagination?.hasMore===false};
  const history=h.history,keys=(history.islands??[]).flatMap(i=>i.entries.map(e=>e.value));
  if(new Set(keys).size!==keys.length||keys.some(k=>!Object.hasOwn(history.entitiesByKey,k)))throw streamError('invalid_desktop_history');
  return {turns:keys.map(k=>({...history.entitiesByKey[k],entityKey:k})),complete:history.isComplete===true};
}
export function desktopView(stream,{approvalLedger=new Map()}={}){
  if(!stream.ready)return {conversationId:stream.conversationId,epoch:stream.epoch,revision:stream.revision,available:false,reason:stream.unavailable??'desktop_connecting',items:[],approvals:[],historyComplete:false};
  const {state}=stream,{turns,complete}=nativeTurns(state),items=[],unsupported=new Set();
  for(const [index,turn]of turns.entries()){
    const turnId=turn.turnId??turn.entityKey??'pending:'+index,completed=new Set(Array.isArray(turn.completedItemIds)?turn.completedItemIds:Object.keys(turn.completedItemIds??{}));
    const timestamp=turn.startedAt??turn.createdAt,at=typeof timestamp==='number'?(timestamp<1e12?timestamp*1000:timestamp):/^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(turnId)?parseInt(turnId.replaceAll('-','').slice(0,12),16):null;
    const message=(item,kind,extra)=>({id:turnId+':'+item.id,turnId,itemId:item.id,kind,...(at==null?{}:{at}),status:turn.status==='inProgress'&&!completed.has(item.id)?'running':'completed',...extra});
    const userMessage=(item,value,extra={})=>(activationReference(value)||personalActivationReference(value))?message(item,'tool',{type:'mobileReceiver',title:'从手机继续此会话',detail:'保留原会话与上下文，接收本次手机消息。',output:''}):message(item,'user',{text:value,...extra});
    const nativeItems=turn.items??[];
    // Some native delegated turns have only a functionCallOutput; preserve it
    // as context/tool output, never invent a user message from an assistant.
    if(!nativeItems.some(i=>i.type==='userMessage')){
      const prompt=text(turn.params?.input);if(prompt)items.push(userMessage({id:'input'},prompt));
    }
    for(const item of nativeItems){
      if(item.type==='reasoning')continue;
      if(item.type==='userMessage'||item.type==='steeringUserMessage')items.push(userMessage(item,text(item.content),{...(Array.isArray(item.content)&&item.content.some(c=>c.type!=='text')?{attachmentsUnavailable:true}:{})}));
      else if(item.type==='agentMessage')items.push(message(item,'assistant',{text:item.text??'',phase:item.phase??null,status:turn.status==='inProgress'?'running':turn.status==='failed'||turn.status==='interrupted'?turn.status:'completed'}));
      else if(toolTypes.has(item.type)){
        const queue=queueMetadata(item);
        const detail=item.type==='commandExecution'?item.command:item.type==='fileChange'?printable(item.changes):printable(item.arguments??item.query??item.path??'');
        const output=item.aggregatedOutput??item.output??text(item.result?.content)??'';
        items.push(message(item,'tool',{type:item.type,title:item.type==='commandExecution'?'执行命令':item.type==='fileChange'?'文件变更':item.type==='mcpToolCall'?(item.server+' · '+item.tool):(item.name??item.type),status:item.status??(completed.has(item.id)||turn.status!=='inProgress'?'completed':'running'),detail:queue?.detail??toolDetail(detail),output:queue?.output??toolDetail(output),...(queue?{queueLinks:queue.links}:{}),...(item.exitCode==null?{}:{exitCode:item.exitCode}),...(item.error?{error:printable(item.error)}:{})}));
      }else unsupported.add(item.type);
    }
  }
  const approvals=(state.requests??[]).map(request=>{
    const p=request.params??{},method=request.method,token=hash([stream.epoch,stream.owner,request.id,method,p]);
    const nativeKey=hash([stream.conversationId,stream.owner,request.id,method,p]),receipt=[...approvalLedger.values()].find(r=>r.nativeKey===nativeKey);
    return {id:token,turnId:p.turnId??null,itemId:p.itemId??null,method,title:method==='item/commandExecution/requestApproval'?'允许执行这条命令？':method==='item/fileChange/requestApproval'?'允许这些文件变更？':'需要在电脑处理',detail:method==='item/commandExecution/requestApproval'?p.command??'命令详情请在电脑核对':method==='item/fileChange/requestApproval'?printable(p.changes??'文件变更详情请在电脑核对'):'此审批类型请在电脑查看并处理。',reason:p.reason??'',canRespond:Boolean(approvalMethods[method])&&!receipt,status:receipt?.state??'pending'};
  });
  return {conversationId:state.id,epoch:stream.epoch,revision:stream.revision,available:true,historyComplete:complete,unsupported:[...unsupported],items,approvals,activeTurnId:turns.find(t=>t.status==='inProgress')?.turnId??null,capabilities:{nativeIncrementalText:true,rawTokenBoundaries:false,toolEvents:true,approvals:approvals.some(a=>a.canRespond)}};
}

// One-shot responses with exact provenance. A success ACK means submitted;
// only a subsequent owner state proves that the desktop resolved the request.
export class DesktopApprovals {
  constructor(stream,{enabled=false,ledger=new Map(),save=()=>{}}={}){this.stream=stream;this.enabled=enabled;this.ledger=ledger;this.save=save;}
  async respond({approvalId,decision,intentId}){
    if(!this.enabled||!['accept','decline'].includes(decision)||typeof intentId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(intentId))throw streamError('desktop_approval_rejected');
    const previous=this.ledger.get(intentId);if(previous){if(previous.approvalId!==approvalId||previous.decision!==decision)throw streamError('desktop_approval_conflict');return previous;}
    if(!this.stream.ready)throw streamError('desktop_unavailable');
    const view=desktopView(this.stream),publicRequest=view.approvals.find(a=>a.id===approvalId),nativeRequest=(this.stream.state.requests??[]).find(r=>hash([this.stream.epoch,this.stream.owner,r.id,r.method,r.params??{}])===approvalId);
    if(!publicRequest?.canRespond||!nativeRequest)throw streamError('desktop_approval_stale');
    const nativeKey=hash([this.stream.conversationId,this.stream.owner,nativeRequest.id,nativeRequest.method,nativeRequest.params??{}]);
    if([...this.ledger.values()].some(r=>r.approvalId===approvalId||r.nativeKey===nativeKey))throw streamError('desktop_approval_already_submitted');
    const receipt={approvalId,decision,intentId,nativeKey,state:'unknown',epoch:this.stream.epoch};this.ledger.set(intentId,receipt);this.save(this.ledger);
    try{await this.stream.request(approvalMethods[nativeRequest.method],{conversationId:this.stream.conversationId,requestId:nativeRequest.id,decision},this.stream.owner,1);receipt.state='submitted';}
    catch(error){receipt.code=error.code??'desktop_request_unknown';}
    this.save(this.ledger);return receipt;
  }
}
