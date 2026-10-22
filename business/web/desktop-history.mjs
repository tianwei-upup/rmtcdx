import { DesktopLive } from './desktop-live.mjs';
import { markdown,copyText } from './markdown.mjs';
import { mergeDesktopQueue } from './desktop-merge.mjs';
export function mountDesktopHistory({host,route,api,onUpdate=()=>{},onError=()=>{},queueRow} ){
 const status=document.createElement('p');status.className='history-scope desktop-status';status.setAttribute('role','status');
 const transcript=document.createElement('section');transcript.className='desktop-transcript';transcript.setAttribute('aria-label','桌面历史与实时执行');
 const approvals=document.createElement('section');approvals.className='desktop-approvals';approvals.setAttribute('aria-label','待处理审批');
 host.append(status,transcript,approvals);const rows=new Map(),responses=new Map();let closed=false,itemCount=0,current,receipts=[];
 function render(state){
  if(closed)return;current=state;status.textContent=!state.available?'桌面同步暂不可用，审批已禁用':state.historyComplete?'完整桌面文字历史 · 原生增量同步':'桌面历史正在补齐…';
  if(state.unsupported.length)status.textContent+=' · 部分附件或特殊消息类型尚未展示';
  status.dataset.available=String(state.available);status.dataset.complete=String(state.historyComplete);transcript.setAttribute('aria-busy',String(Boolean(state.activeTurnId)));
  const list=mergeDesktopQueue(state.list(),receipts);itemCount=list.length;
  for(const [index,item]of list.entries()){
   if(item.kind==='queue'&&queueRow){const root=queueRow(item.receipt);root.dataset.mergedIntent=item.receipt.intentId;root.dataset.queueCorrelated=String(item.correlated===true);root.dataset.turnId=item.turnId??'';if(transcript.children[index]!==root)transcript.insertBefore(root,transcript.children[index]??null);continue;}
   let row=rows.get(item.id);if(!row){const root=document.createElement('article');root.className='message';root.dataset.nativeId=item.id;const body=document.createElement('div');body.className='message-content';const actions=document.createElement('div');actions.className='message-actions';const copy=document.createElement('button');copy.className='text-button';copy.textContent='复制';copy.type='button';actions.append(copy);root.append(body,actions);row={root,body,actions,copy,text:null};copy.onclick=()=>void copyText(row.text??'',copy);rows.set(item.id,row);}
   row.root.className='message '+(item.kind==='user'?'user':item.kind==='tool'?'desktop-tool':'assistant');row.root.dataset.status=item.status;row.root.dataset.kind=item.kind;row.root.dataset.turnId=item.turnId;row.root.dataset.toolType=item.type??'';
   const signature=JSON.stringify(item);if(row.signature!==signature){row.signature=signature;
    if(item.kind==='tool'){
     // Keep the same details element while output changes, preserving open state.
     if(!row.details){row.details=document.createElement('details');row.summary=document.createElement('summary');row.pre=document.createElement('pre');row.details.append(row.summary,row.pre);row.body.replaceChildren(row.details);}
     const labels={running:'执行中',inProgress:'执行中',completed:'已完成',failed:'失败',declined:'已拒绝'};row.summary.textContent=item.title+' · '+(labels[item.status]??item.status);row.text=[item.detail,item.output,item.error].filter(Boolean).join('\n\n');row.pre.textContent=row.text;
    }else{row.text=item.text;if(row.bodyText!==item.text){row.body.replaceChildren(item.kind==='user'?document.createTextNode(item.text):markdown(item.text));row.bodyText=item.text;}row.body.classList.toggle('native-streaming',item.status==='running');}
    row.actions.hidden=!row.text;
   }
   if(transcript.children[index]!==row.root)transcript.insertBefore(row.root,transcript.children[index]??null);
  }
  const visible=new Set(list.map(i=>i.id));for(const [id,row]of rows)if(!visible.has(id)){row.root.remove();rows.delete(id);}const queueIds=new Set(receipts.map(r=>r.intentId));for(const root of transcript.querySelectorAll('[data-merged-intent]'))if(!queueIds.has(root.dataset.mergedIntent))root.remove();
  renderApprovals();onUpdate({itemCount,available:state.available,revision:state.revision});
 }
 function renderApprovals(){
  const pending=new Set(current.approvals.map(a=>a.id)),cards=current.approvals.map(a=>{
   const card=document.createElement('article');card.className='approval-card';card.dataset.approvalId=a.id;const title=document.createElement('strong');title.textContent=a.title;const detail=document.createElement('pre');detail.textContent=[a.detail,a.reason].filter(Boolean).join('\n');card.append(title,detail);
   const receipt=responses.get(a.id),info=document.createElement('p');info.className='message-state';
   info.textContent=receipt?(receipt.state==='unknown'?'提交结果不明，不会自动重发。请在电脑核对。':receipt.state==='rejected'?'请求已失效，请在电脑核对。':'选择已提交，等待桌面处理。'):a.status==='unknown'?'之前的提交结果不明，不会自动重发。请在电脑核对。':['queued','claimed','submitted'].includes(a.status)?'之前的选择已提交，等待桌面处理。':a.canRespond?'仅处理这一次请求，不授予长期权限。':'此类型请在电脑处理。';card.append(info);
   if(a.canRespond)for(const [decision,label]of [['accept','允许一次'],['decline','拒绝']]){
    const button=document.createElement('button');button.type='button';button.textContent=label;button.disabled=!current.available||Boolean(receipt);button.onclick=async()=>{
     if(!current.available||responses.has(a.id))return;const intentId=crypto.randomUUID();responses.set(a.id,{state:'unknown',intentId});renderApprovals();
     try{const value=await api(route+'/approvals',{approvalId:a.id,decision,intentId});responses.set(a.id,value);}
     catch(error){onError(error);}renderApprovals();
    };card.append(button);
   }return card;
  });
  for(const [id,receipt]of responses)if(!pending.has(id)){const p=document.createElement('p');p.className='message-state';p.textContent=current.available?'电脑已处理该审批。':'审批状态待电脑核对。';p.dataset.approvalId=id;cards.push(p);}
  approvals.replaceChildren(...cards);
 }
 const live=new DesktopLive({route,api,onChange:render,onError}).start();
 return {get itemCount(){return itemCount;},get available(){return current?.available===true;},get capabilities(){return current?.capabilities??{};},get pendingCount(){return current?.approvals.length??0;},setQueue(value){receipts=value;if(current)render(current);},refresh(){void live.refresh();},close(){closed=true;live.close();host.replaceChildren();}};
}
