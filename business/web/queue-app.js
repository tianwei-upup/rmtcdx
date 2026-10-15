import { BusinessClient } from './business-client.mjs';
import { QueueState } from './queue-state.mjs';
const $=id=>document.getElementById(id),client=new BusinessClient({storage:localStorage}),state=new QueueState();
document.documentElement.classList.toggle('android-shell',navigator.userAgent.includes(' CodexRemoteAndroid/'));
let config,route,polling=false,busy=false,timer;
const errorText={device_offline:'电脑暂时离线，稍后刷新核对。',network_unavailable:'网络暂时不可用，已有任务不会重复发送。',precondition_rejected:'任务状态已变化，请刷新核对。',execution_unknown:'交付结果尚未确认，请核对已有任务。',result_expired:'交付回执已过期，正在从电脑重新核对。',queue_scope_rejected:'当前只允许专用测试项目。',intent_conflict:'还有一条发送尚未确认，请先核对。'};
function notice(text=''){$('notice').textContent=text;$('notice').hidden=!text;}
function failure(error){console.warn('queue_request_failed',error.code??'request_failed');if(error.status===401){$('login').hidden=false;$('workspace').hidden=true;clearInterval(timer);$('loginNotice').textContent='登录已过期，请重新登录。';return;}notice(errorText[error.code]??'请求未完成，请稍后刷新核对。');}
function controls(){const pending=route&&client.pending(route);$('enqueue').disabled=busy||!state.online||Boolean(pending);$('recovery').hidden=!pending;$('refresh').disabled=polling;}
function render(){
  const list=state.list().reverse();$('count').textContent=list.length+' 条';$('empty').hidden=list.length>0;
  const cards=list.map(r=>{
    const card=document.createElement('article');card.className='task';card.dataset.intent=r.intentId;card.dataset.state=r.state;card.dataset.uncertain=String(r.outcomeUncertain);
    const head=document.createElement('div');head.className='task-head';const id=document.createElement('span');id.className='task-id';id.textContent=r.intentId.slice(0,12);const badge=document.createElement('span');badge.className='badge';badge.textContent=state.label(r);head.append(id,badge);card.append(head);
    const prompt=document.createElement('p');prompt.className='prompt';prompt.textContent=r.text||state.prompts.get(r.intentId)||'已提交的任务';card.append(prompt);
    if(r.state==='completed'){const result=document.createElement('div');result.className='result';result.textContent=r.result;card.append(result);const footer=document.createElement('div');footer.className='task-footer';const copy=document.createElement('button');copy.textContent='复制结果';copy.onclick=async()=>{try{await navigator.clipboard.writeText(r.result);copy.textContent='已复制';}catch{notice('请长按结果文字复制。');}};footer.append(copy);card.append(footer);}
    if(state.canCancel(r)){const footer=document.createElement('div');footer.className='task-footer';const cancel=document.createElement('button');cancel.textContent=r.state==='queued'?'取消排队':'请求取消';cancel.disabled=!state.online;cancel.onclick=async()=>{cancel.disabled=true;try{const value=await client.job(route+'/cancel',{intentId:r.intentId,expectedRevision:r.revision},{writing:true,scope:r.intentId+':'+r.revision});state.merge([value.receipt]);render();}catch(e){failure(e);await refresh();}};footer.append(cancel);card.append(footer);}
    if(r.outcomeUncertain||r.state==='unknown'||r.cancelRequested&&r.state==='leased'){const hint=document.createElement('p');hint.className='hint';hint.textContent=r.outcomeUncertain||r.state==='unknown'?'执行结果尚未确认，旧任务不会自动重试。需要在电脑端核对。':'等待桌面确认取消；任务可能已部分执行。';card.append(hint);}
    return card;
  });$('queue').replaceChildren(...cards);
  const c=state.consumer,active=c&&c.state==='active';
  $('consumerStatus').textContent=active?'桌面正在领取 · 本窗口已领取 '+c.takenJobs+'/'+c.maxJobs+' 条':c?.state==='stopping'?'桌面正在结束当前任务，后续消息保留排队。':'桌面未开启领取，消息将保留排队。请在电脑的专用测试会话开启领取窗口。';
  $('stopConsumer').hidden=!active;$('stopConsumer').disabled=!state.online||busy;controls();
}
async function refresh(){
  if(!config||polling||document.hidden)return;polling=true;controls();
  try{const devices=await client.api('/api/devices'),device=devices.devices.find(d=>d.id===config.deviceId);state.online=Boolean(device?.online&&device?.ready);$('connection').textContent=state.online?'电脑在线':'电脑离线';
    if(state.online){const value=await client.job(route+'/status',{});state.merge(value.receipts);state.consumer=value.consumer;
      const pending=client.pending(route);if(pending&&state.items.has(pending.id)){const receipt=state.items.get(pending.id);if($('text').value.trim()===(receipt.text||state.prompts.get(pending.id)))$('text').value='';client.clear(route);notice('已核对：消息已入队，没有重复发送。');}
    }render();
  }catch(e){failure(e);}finally{polling=false;controls();}
}
async function init(){config=await client.api('/api/queue/config');route='/api/conversations/'+config.conversationId+'/queue';$('login').hidden=true;$('workspace').hidden=false;$('loginNotice').textContent='';
  const pathDevice=/^\/devices\/([^/]+)\/$/.exec(location.pathname)?.[1];if(pathDevice&&pathDevice!==config.deviceId)throw Object.assign(Error('scope'),{code:'queue_scope_rejected'});
  await refresh();clearInterval(timer);timer=setInterval(()=>void refresh(),3000);
}
$('login').onsubmit=async event=>{event.preventDefault();const button=$('login').querySelector('button');button.disabled=true;try{await client.api('/api/login',{username:'admin',password:$('password').value});$('password').value='';await init();}catch(e){$('loginNotice').textContent=e.code==='invalid_credentials'?'密码不正确，请重试。':'连接失败，请检查网络后重试。';}finally{button.disabled=false;}};
$('composer').onsubmit=async event=>{event.preventDefault();const text=$('text').value.trim();if(!text||busy||client.pending(route))return;busy=true;controls();
  try{const value=await client.job(route,{text},{writing:true,onAccepted:()=>{const p=client.pending(route);if(p)state.prompts.set(p.id,text);}});state.prompts.set(value.receipt.intentId,text);state.merge([value.receipt]);$('text').value='';notice('消息已入队，等待桌面领取。');render();await refresh();}
  catch(e){failure(e);await refresh();}finally{busy=false;controls();}
};
$('refresh').onclick=$('reconcile').onclick=()=>void refresh();
$('stopConsumer').onclick=async()=>{if(!state.consumer)return;busy=true;controls();try{const value=await client.job(route+'/stop',{sessionId:state.consumer.sessionId},{writing:true,scope:state.consumer.sessionId});state.consumer=value.consumer;render();}catch(e){failure(e);}finally{busy=false;controls();}};
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refresh();});
window.addEventListener('online',()=>void refresh());
$('loginButton').disabled=false;
void init().catch(error=>{if(error.status!==401)failure(error);});
