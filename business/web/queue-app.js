import {CatalogLive,loadCatalog} from './catalog-live.mjs';
import { QueueLive } from './queue-live.mjs';
import { BusinessClient } from './business-client.mjs';
import { QueueState, canAutoReceive } from './queue-state.mjs';
import { markdown, copyText } from './markdown.mjs';
const $=id=>document.getElementById(id),client=new BusinessClient({storage:localStorage});
let state=new QueueState(),config,rootConfig,catalog=[],projectId,selectionVersion=0,route,polling=false,busy=false,timer,selected,live,liveAvailable=false,liveConnected=false,follow=true,desktopHistory=null,catalogLive;
let projectPickerOpen=false,composerOffsetFrame=null;
const RECENT_PROJECTS='rmt-recent-projects',RECENT_CHATS='rmt-recent-chats';
const readRecent=key=>{try{const value=JSON.parse(localStorage.getItem(key)||'[]');return Array.isArray(value)?value.filter(x=>x&&typeof x.id==='string'&&Number.isFinite(x.at)):[];}catch{return[];}};
const touchRecent=(key,id)=>{if(!id)return;try{const list=readRecent(key).filter(x=>x.id!==id);list.unshift({id,at:Date.now()});localStorage.setItem(key,JSON.stringify(list.slice(0,8)));}catch{}};
const recentAt=(key,id)=>readRecent(key).find(x=>x.id===id)?.at??0;
// The desktop catalog carries the real last-active time. The phone-side
// recency is only a fallback for catalogs that predate that field.
const chatTime=c=>c.updatedAt?c.updatedAt*1000:recentAt(RECENT_CHATS,c.id);
function relativeTime(at){if(!at)return'';const diff=Date.now()-at;if(diff<60000)return'刚刚';if(diff<3600000)return Math.floor(diff/60000)+' 分钟前';if(diff<86400000)return Math.floor(diff/3600000)+' 小时前';if(diff<2592000000)return Math.floor(diff/86400000)+' 天前';return new Date(at).toLocaleDateString('zh-CN',{month:'numeric',day:'numeric'});}
const traces=new Map(),states=new Map(),drafts=new Map(),rows=new Map();
const normalChats=p=>(p?.conversations??[]).filter(c=>!c.archived);
const allChats=()=>catalog.flatMap(p=>p.conversations.map(c=>({...c,projectId:p.id,workspaceAvailable:c.workspaceAvailable??p.available})));
const chat=()=>allChats().find(c=>c.id===selected);
const autoReceiveEnabled=()=>canAutoReceive({config,chat:chat(),capabilities:desktopHistory?.capabilities});
const projectName=()=>catalog.find(p=>p.id===chat()?.projectId)?.name??config?.projectName??'专用测试项目';
const desktopEnabled=()=>config?.desktopSync&&(!config.desktopConversations||config.desktopConversations.some(c=>c.id===selected));
const errorText={catalog_source_stale:'电脑目录正在重新同步，请稍后发送。',device_offline:'电脑暂时离线，连接恢复后再发送。',network_unavailable:'网络暂时不可用，正在核对消息是否送达。',precondition_rejected:'消息状态已变化，正在重新同步。',execution_unknown:'发送状态还在确认，请先核对已有消息。',result_expired:'正在从电脑重新核对消息。',queue_scope_rejected:'当前会话尚未开放手机访问。',intent_conflict:'上一条消息还在确认，请先核对发送状态。'};
function notice(text=''){$('noticeText').textContent=text;$('notice').hidden=!text;}
function failure(error){console.warn('queue_request_failed',error.code??'request_failed');if(error.status===401||!config){$('login').hidden=false;$('workspace').hidden=true;live?.close();desktopHistory?.close();catalogLive?.close();clearInterval(timer);$('loginNotice').textContent=error.status===401?'登录已过期，请重新登录。':'暂时无法连接，请检查网络后重试。';return;}notice(errorText[error.code]??'请求未完成，请重新连接后核对。');}
function observed(){
  if(document.hidden)return;const currentRoute=route,currentState=state;
  requestAnimationFrame(()=>{if(route!==currentRoute||state!==currentState)return;for(const r of state.items.values()){
    if(r.local)continue;const t=traces.get(r.intentId);if(!t)continue;const now=performance.now();
    const phases=[['enqueueRendered',true,t.start],['claimRendered',Boolean(r.consumerTurnId),t.start],['firstOutputRendered',Boolean(r.progress)||r.state==='completed',t.start],['resultRendered',r.state==='completed',t.start],['cancelRendered',r.cancelRequested,t.cancelAt],['cancelAcknowledged',r.state==='cancelled',t.cancelAt]];
    for(const [phase,condition,start]of phases)if(condition&&start!=null&&!t.seen.has(phase)){t.seen.add(phase);void client.api(currentRoute+'/observations',{observationId:crypto.randomUUID(),intentId:r.intentId,phase,durationMs:now-start,transport:t.transport??(liveConnected?'sse':'poll')}).catch(()=>{});}
  }});
}
function confirmation(check){return liveAvailable?()=>live.confirm(check):undefined;}
function reconcile(){const p=route&&client.pending(route);if(p&&state.items.has(p.id)&&!state.items.get(p.id).local)client.clear(route,'',p.id);}
function stopTarget(){return state.list().find(r=>r.state==='leased'&&state.canCancel(r))??state.list().find(r=>state.canCancel(r));}
function controls(){
  const pending=route&&client.pending(route),archived=Boolean(chat()?.archived||desktopHistory?.capabilities?.archived),autoReceive=autoReceiveEnabled(),hasText=Boolean($('text').value.trim()),target=stopTarget();
  const unavailable=Boolean(selected&&!chat())||chat()?.workspaceAvailable===false||desktopHistory?.capabilities?.workspaceAvailable===false;
  const loadingHistory=desktopEnabled()&&!desktopHistory?.available;
  $('empty').querySelector('h1').textContent=!selected?'当前项目暂无未归档会话':loadingHistory?'正在加载历史记录':'从这段对话继续';
  $('emptyHint').textContent=!selected?'该项目还没有未归档会话。':loadingHistory?'正在连接电脑并读取原会话，首次加载可能需要一些时间。':'发送消息，回答会同步显示在这里。';
  $('enqueue').hidden=!hasText&&Boolean(target);$('stopReply').hidden=hasText||!target;
  $('enqueue').disabled=busy||!state.online||Boolean(pending)||archived||unavailable||!selected||config?.queueWrites===false||!hasText;
  $('stopReply').disabled=busy||!state.online||archived;$('text').disabled=archived||unavailable||!selected;$('text').placeholder=archived?'已归档的会话':unavailable?'项目目录不存在，仅查看历史':!selected?'当前项目暂无未归档会话':'发送消息';
  $('showChats').disabled=$('context').disabled=busy;$('recovery').hidden=!pending;
  if($('projectToggle'))$('projectToggle').disabled=busy;
  $('retryPending').hidden=!pending||!state.prompts.has(pending.id);$('retryPending').disabled=busy||!state.online;
  $('reconcile').disabled=$('refresh').disabled=polling||busy;
  const desktopMode=config?.executionMode==='desktop';
  if($('composerHint'))$('composerHint').textContent=archived?'已归档 · 仅查看':desktopMode?'与电脑使用相同权限 · 回复与执行同步':'只读对话 · 回答与电脑同步';
  $('accessPolicy').textContent=desktopMode?'与桌面权限一致：可改代码、执行命令，需要审批时由你决定。电脑需保持开机联网。':'当前只读：可以提问和分析上下文。电脑需保持开机联网。';
  const c=state.consumer,active=c?.state==='active';$('consumerStatus').dataset.state=c?.state??'closed';
  $('consumerStatus').textContent=!state.online?'电脑暂时离线，等待重新连接':active?'手机接收已开启':c?.state==='stopping'?'正在暂停手机接收':autoReceive?'发送后自动接入原会话':'消息会先排队，接收后开始处理';
  $('stopConsumer').hidden=!active;$('stopConsumer').disabled=!state.online||busy;
  $('connection').dataset.state=state.online&&liveConnected?'ready':'waiting';$('connection').textContent=!state.online?'连接中':liveConnected?'已同步':'同步中';$('connection').title=!state.online?'正在连接电脑':liveConnected?'实时队列已同步':'正在同步最新状态';
  $('composerContext').textContent=archived?'已归档 · 仅查看':!state.online?'等待连接电脑':!active?'等待电脑接收':config.executionMode==='desktop'?'桌面权限':'只读对话';
  if(desktopEnabled()){$('connection').dataset.state=desktopHistory?.available?'ready':'waiting';$('connection').textContent=desktopHistory?.available?'已同步':'连接中';$('connection').title=desktopHistory?.available?(desktopHistory?.capabilities?.historySnapshot?'桌面历史已同步':'桌面实时同步中'):'正在连接桌面';$('composerContext').textContent=archived?'已归档 · 仅查看':desktopHistory?.pendingCount?'有审批等待处理，请查看最新消息':desktopHistory?.available?(config.queueWrites===false?'桌面实时同步 · 仅查看':active?(config.executionMode==='desktop'?'桌面权限 · 手机接收已开启':'桌面实时同步 · 手机接收已开启'):autoReceive?'历史已同步 · 可直接发送':'历史已同步 · 消息将排队'):autoReceive?'发送后接入原会话 · 历史同步中':'等待桌面同步';}
  for(const row of rows.values()){row.cancel.disabled=busy||!state.online;row.retry.disabled=busy||!state.online||Boolean(pending);}
}
function createRow(id){
  const article=document.createElement('article');article.className='task';article.dataset.intent=id;
  const user=document.createElement('div');user.className='user-wrap';const bubble=document.createElement('div');bubble.className='message user';bubble.setAttribute('aria-label','你的消息');const prompt=document.createElement('p');prompt.className='prompt';bubble.append(prompt);
  const delivery=document.createElement('div');delivery.className='delivery';const retry=document.createElement('button');retry.type='button';retry.className='text-button retry-message';retry.textContent='重新发送';user.append(bubble,delivery,retry);
  const assistant=document.createElement('div');assistant.className='message assistant';assistant.setAttribute('aria-label','Codex 的回复');
  const status=document.createElement('div');status.className='reply-status';const dot=document.createElement('span');dot.className='thinking-dot';dot.setAttribute('aria-hidden','true');const statusText=document.createElement('span');status.append(dot,statusText);
  const result=document.createElement('div');result.className='message-content result';const actions=document.createElement('div');actions.className='message-actions';const copy=document.createElement('button');copy.type='button';copy.className='icon-button';copy.setAttribute('aria-label','复制回复');const icon=document.createElement('img');icon.src='/icons/copy.svg';icon.alt='';copy.append(icon);
  const cancel=document.createElement('button');cancel.type='button';cancel.className='text-button cancel-message';actions.append(copy,cancel);assistant.append(status,result,actions);article.append(user,assistant);
  const row={article,prompt,delivery,status,statusText,dot,result,copy,cancel,retry,body:null};
  copy.onclick=()=>void copyText(row.body??'',copy);cancel.onclick=()=>void cancelMessage(row.receipt);retry.onclick=()=>void sendMessage(row.receipt.text,row.receipt.intentId);
  rows.set(id,row);return row;
}
function render(){
  const list=state.list();$('empty').hidden=list.length>0||Boolean(desktopHistory?.itemCount);$('historyScope').hidden=!list.length||Boolean(desktopEnabled());$('queue').hidden=Boolean(desktopHistory?.itemCount);
  list.forEach((r,index)=>{
    const row=rows.get(r.intentId)??createRow(r.intentId);row.receipt=r;row.article.dataset.state=r.state;row.article.dataset.uncertain=String(Boolean(r.outcomeUncertain));
    row.prompt.textContent=r.text||state.prompts.get(r.intentId)||'已发送的消息';row.delivery.dataset.state=r.state;
    row.delivery.textContent=r.state==='sending'?'发送中…':r.state==='unconfirmed'?'正在确认是否送达':r.state==='failed'?'发送失败':'';row.retry.hidden=r.state!=='failed';
    const uncertain=r.state==='unknown'||r.outcomeUncertain;
    const status=uncertain?'需要在电脑确认结果，不会自动重发':r.cancelRequested&&r.state==='leased'?'正在停止回复…':r.state==='queued'?(state.consumer?.state==='active'?'等待电脑回复…':autoReceiveEnabled()?'已排队，等待原会话处理…':'等待电脑开启接收…'):r.state==='leased'?'正在回复…':r.state==='cancelled'?'已停止回复':'';
    row.status.hidden=!status;row.statusText.textContent=status;row.dot.hidden=uncertain||!['queued','leased'].includes(r.state)||Boolean(r.cancelRequested);
    const body=r.state==='completed'?(r.result??''):(r.progress?.text??'');if(body!==row.body){row.result.replaceChildren(markdown(body));row.body=body;}
    row.result.classList.toggle('partial',r.state==='leased');row.result.setAttribute('aria-busy',String(r.state==='leased'));row.copy.hidden=!body;row.cancel.hidden=!state.canCancel(r);row.cancel.textContent=r.state==='queued'?'取消发送':'停止回复';
    const position=$('queue').children[index];if(position!==row.article)$('queue').insertBefore(row.article,position??null);
  });
  for(const [id,row]of rows)if(!state.items.has(id)){row.article.remove();rows.delete(id);}
  desktopHistory?.setQueue(list);
  controls();observed();requestAnimationFrame(()=>{if(follow)$('chatScroll').scrollTop=$('chatScroll').scrollHeight;updateJump();});
}
function updateJump(){const scroll=$('chatScroll');$('jumpBottom').hidden=scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop<100;}
function resizeInput(){const input=$('text');input.style.height='auto';input.style.height=Math.min(input.scrollHeight,170)+'px';scheduleComposerOffset();controls();}
function composerOffset(){const footer=document.querySelector('.composer-footer');if(!footer)return;document.documentElement.style.setProperty('--composer-offset',Math.round(footer.getBoundingClientRect().height+14)+'px');}
function scheduleComposerOffset(){if(composerOffsetFrame)return;composerOffsetFrame=requestAnimationFrame(()=>{composerOffsetFrame=null;composerOffset();});}
function renderChats(){
  const query=$('search').value.trim().toLocaleLowerCase(),chats=normalChats(catalog.find(p=>p.id===projectId));
  if($('projectSelect')){$('projectSelect').replaceChildren(...catalog.map(p=>{const o=document.createElement('option');o.value=p.id;o.textContent=p.name+'（'+normalChats(p).length+'）';return o;}));$('projectSelect').value=projectId;}
  renderProjectPicker();
  const buttons=chats.filter(c=>c.title.toLocaleLowerCase().includes(query)).sort((a,b)=>chatTime(b)-chatTime(a)).map(c=>{const b=document.createElement('button');b.type='button';b.className='session-row';b.dataset.chatId=c.id;b.setAttribute('aria-current',String(c.id===selected));b.disabled=busy;const title=document.createElement('span');title.className='session-title';title.textContent=c.title;b.append(title);const when=relativeTime(chatTime(c));if(when){const meta=document.createElement('span');meta.className='session-meta';meta.textContent=when;b.append(meta);}b.onclick=()=>{if(!busy){selectChat(c.id);$('drawer').close();}};return b;});$('chatList').replaceChildren(...buttons);$('noChats').hidden=buttons.length>0;$('noChats').textContent=query?'没有找到匹配的会话':'当前项目暂无未归档会话';
}
function renderProjectPicker(){
  if(!$('projectToggle'))return;const current=catalog.find(p=>p.id===projectId);
  $('currentProjectName').textContent=current?.name??'选择项目';$('currentProjectCount').textContent=normalChats(current).length+' 个会话';$('projectToggle').setAttribute('aria-label','当前项目：'+(current?.name??'未选择')+'，切换项目');
  if(!projectPickerOpen)return;const query=$('projectSearch').value.trim().toLocaleLowerCase(),projects=catalog.filter(p=>p.name.toLocaleLowerCase().includes(query)),list=$('projectList'),scroll=list.scrollTop,focused=document.activeElement?.closest('.project-option')?.dataset.projectId;
  const projectTime=p=>normalChats(p).reduce((max,c)=>Math.max(max,chatTime(c)),0);
  const recent=query?[]:projects.map(p=>({p,at:Math.max(projectTime(p),recentAt(RECENT_PROJECTS,p.id))})).filter(x=>x.at>0).sort((a,b)=>b.at-a.at).slice(0,3).map(x=>x.p);
  const recentIds=new Set(recent.map(p=>p.id));
  const rest=projects.filter(p=>!recentIds.has(p.id)).sort((a,b)=>a.name.localeCompare(b.name));
  const option=p=>{const row=$('projectOptionTemplate').content.firstElementChild.cloneNode(true);row.dataset.projectId=p.id;row.setAttribute('aria-current',String(p.id===projectId));row.disabled=busy;row.querySelector('.project-option-name').textContent=p.name;row.querySelector('.project-option-meta').textContent=normalChats(p).length+' 个会话'+(p.available===false?' · 目录不可用':'');row.onclick=()=>chooseProject(p.id);return row;};
  const group=(label,rows)=>{const head=document.createElement('p');head.className='project-group-label';head.textContent=label;const wrap=document.createDocumentFragment();wrap.append(head);for(const p of rows)wrap.append(option(p));return wrap;};
  const fragment=document.createDocumentFragment();
  if(recent.length)fragment.append(group('最近使用',recent));
  if(rest.length)fragment.append(group(query?'搜索结果':'全部项目',rest));
  list.replaceChildren(fragment);
  list.hidden=projects.length===0;list.scrollTop=scroll;if(focused)[...list.querySelectorAll('.project-option')].find(row=>row.dataset.projectId===focused)?.focus({preventScroll:true});$('projectMatches').textContent=projects.length+' 个';$('noProjects').hidden=projects.length>0;
}
function setProjectPicker(open){
  if(!$('projectPanel'))return;projectPickerOpen=open;$('drawer').dataset.projectPicker=open?'open':'closed';$('projectPanel').hidden=!open;$('projectToggle').setAttribute('aria-expanded',String(open));
  if(open){$('projectSearch').value='';renderProjectPicker();$('projectList').scrollTop=0;}else $('projectSearch').blur();
}
function chooseProject(id){
  if(busy||!catalog.some(p=>p.id===id))return;const changed=projectId!==id;projectId=id;if(changed)$('search').value='';setProjectPicker(false);renderChats();$('projectToggle')?.focus({preventScroll:true});if(changed)void selectChat(normalChats(catalog.find(p=>p.id===id))[0]?.id);
}
function openDrawer(){if(busy||$('workspace').hidden||$('drawer').open)return;setProjectPicker(false);renderChats();$('drawer').showModal();$('showChats').setAttribute('aria-expanded','true');}
function bindDrawerSwipe(){
  const drawer=$('drawer'),hasSelection=()=>Boolean(window.getSelection()?.toString());
  const bind=(area,direction,enabled,activate,allowButtons=false)=>{let swipe=null;
  area.addEventListener('touchstart',event=>{
    swipe=null;if(event.touches.length!==1||!enabled()||hasSelection())return;
    // Leave controls, code blocks and nested horizontal scrolling to the browser.
    const target=event.target instanceof Element?event.target:event.target.parentElement;
    if(target?.closest('input,textarea,select,label,summary,pre,table,.code-block,[contenteditable]:not([contenteditable="false"])'+(allowButtons?'':',a,button')))return;
    for(let node=target;node&&node!==area;node=node.parentElement){if(node.scrollWidth>node.clientWidth+1&&/auto|scroll/.test(getComputedStyle(node).overflowX))return;}
    const touch=event.touches[0];swipe={id:touch.identifier,x:touch.clientX,y:touch.clientY,at:performance.now(),version:selectionVersion,horizontal:false};
  },{passive:true});
  area.addEventListener('touchmove',event=>{
    if(!swipe)return;
    const touch=event.touches[0];if(event.touches.length!==1||touch.identifier!==swipe.id||!enabled()||hasSelection()||performance.now()-swipe.at>650){swipe=null;return;}
    const dx=(touch.clientX-swipe.x)*direction,dy=Math.abs(touch.clientY-swipe.y);
    if(dx < -12||(dy>12&&dy>=dx)){swipe=null;return;}
    // WebView commits scrolling after the first uncancelled move. Reserve clear
    // horizontal intent immediately; require the full distance only on release.
    if(dx>0&&dx>dy*1.5)swipe.horizontal=true;
    if(swipe.horizontal){if(!event.cancelable){swipe=null;return;}event.preventDefault();}
  },{passive:false});
  area.addEventListener('touchend',event=>{
    const ended=swipe;swipe=null;if(!ended)return;
    const touch=[...event.changedTouches].find(t=>t.identifier===ended.id);if(!touch)return;
    if(ended.horizontal&&event.cancelable)event.preventDefault();
    const dx=(touch.clientX-ended.x)*direction,dy=Math.abs(touch.clientY-ended.y),threshold=Math.max(60,Math.min(96,area.clientWidth*.18));
    if(!event.touches.length&&enabled()&&ended.horizontal&&dx>=threshold&&dx>dy*2&&performance.now()-ended.at<=650&&ended.version===selectionVersion&&!hasSelection())activate();
  },{passive:false});
  area.addEventListener('touchcancel',()=>{swipe=null;},{passive:true});
  };
  bind($('chatScroll'),1,()=>!busy&&!$('workspace').hidden&&!drawer.open,openDrawer);
  // A swipe on a chat row closes the drawer without activating that row.
  bind(drawer,-1,()=>drawer.open,()=>drawer.close(),true);
}
async function refresh(){
  if(!config||!route||polling||document.hidden)return;desktopHistory?.refresh();polling=true;const currentRoute=route,currentState=state;controls();
  try{if(liveAvailable){await live.refresh();return;}const devices=await client.api('/api/devices'),device=devices.devices.find(d=>d.id===config.deviceId);if(route!==currentRoute||state!==currentState)return;state.online=Boolean(device?.online&&device?.ready);
    if(state.online){const value=await client.job(currentRoute+'/status',{});if(route!==currentRoute||state!==currentState||liveAvailable)return;state.merge(value.receipts);state.consumer=value.consumer;reconcile();}render();
  }catch(e){if(route===currentRoute){state.online=false;failure(e);}}finally{polling=false;controls();if(route!==currentRoute)void refresh();}
}
async function selectChat(id){
 const version=++selectionVersion,c=allChats().find(c=>c.id===id);live?.close();desktopHistory?.close();route=null;state.online=false;controls();
 try{const next=c&&c.deviceId!==config.deviceId?await client.api('/api/queue/config?realtime=1&deviceId='+encodeURIComponent(c.deviceId)):config;
 if(version!==selectionVersion)return;config=next;activateChat(id);}
 catch(e){if(version===selectionVersion)failure(e);}
}
function activateChat(id){
  if(route)drafts.set(selected,$('text').value);projectId=allChats().find(c=>c.id===id)?.projectId??projectId;touchRecent(RECENT_PROJECTS,projectId);touchRecent(RECENT_CHATS,id);$('projectName').textContent=$('drawerProject').textContent=catalog.find(p=>p.id===projectId)?.name??'所有项目';desktopHistory?.close();desktopHistory=null;live?.close();liveAvailable=false;liveConnected=false;selected=id;route=id?'/api/conversations/'+id+'/queue':null;state=states.get(id)??new QueueState();states.set(id,state);state.online=false;
  rows.clear();$('queue').replaceChildren();follow=true;$('text').value=drafts.get(id)??'';notice();$('pageTitle').textContent=chat()?.title??(id?'专用测试会话':'暂无会话');$('context').setAttribute('aria-label','当前会话：'+$('pageTitle').textContent+'，项目：'+projectName()+'，切换会话');$('composerLabel').textContent='发送到：'+$('pageTitle').textContent;resizeInput();
  try{if(id)localStorage.setItem('rmt-queue-selected:'+rootConfig.deviceId,id);}catch{}render();if(!id)return;const targetState=state,targetRoute=route;
  if(config.realtime)live=new QueueLive({route,api:(...args)=>client.api(...args),onUpdate:value=>{if(route!==targetRoute||state!==targetState)return;liveAvailable=true;state.online=value.fresh!==false;state.merge(value.receipts);for(const r of value.receipts){const t=traces.get(r.intentId);if(t)t.transport=value.transport;}state.consumer=value.consumer;reconcile();render();},onHealth:value=>{if(route!==targetRoute)return;if(value.available!==undefined)liveAvailable=Boolean(value.available);if(value.connected!==undefined)liveConnected=value.connected;if(value.fresh!==undefined)state.online=Boolean(value.available&&value.fresh);controls();},onError:error=>{if(route!==targetRoute)return;if(error.status===401)failure(error);else if(!['projection_unavailable','network_unavailable'].includes(error.code))failure(error);}}).start();void refresh();
  if(desktopEnabled())void import('./desktop-history.mjs').then(({mountDesktopHistory})=>{if(route!==targetRoute)return;let host=$('desktopHistory');if(!host){host=document.createElement('div');host.id='desktopHistory';$('historyScope').before(host);}desktopHistory=mountDesktopHistory({host,route:'/api/conversations/'+id+'/desktop',api:(...args)=>client.api(...args),queueRow:r=>(rows.get(r.intentId)??createRow(r.intentId)).article,onUpdate:()=>{controls();$('queue').hidden=Boolean(desktopHistory?.itemCount);$('empty').hidden=Boolean(desktopHistory?.itemCount)||state.items.size>0;requestAnimationFrame(()=>{if(follow)$('chatScroll').scrollTop=$('chatScroll').scrollHeight;updateJump();});},onError:error=>{if(route!==targetRoute)return;if(error.status===401)failure(error);else console.warn('desktop_history_unavailable',error.code??'history_loading');}});desktopHistory.setQueue(state.list());});
}
async function refreshCatalog(){
 const fresh=await client.api('/api/queue/config?realtime=1&deviceId='+encodeURIComponent(rootConfig.deviceId));
 if(config.mode==='dedicated-test')return;const previous=chat();rootConfig=fresh;catalog=fresh.projectCatalog??catalog;
 const current=chat(),version=selectionVersion;if(current){const nextConfig=config.deviceId===fresh.deviceId?fresh:await client.api('/api/queue/config?realtime=1&deviceId='+encodeURIComponent(current.deviceId));if(version!==selectionVersion)return;config=nextConfig;
   if(previous?.deviceId!==current.deviceId){await selectChat(selected);return;}
   projectId=current.projectId;$('projectName').textContent=$('drawerProject').textContent=projectName();$('pageTitle').textContent=current.title;$('composerLabel').textContent='发送到：'+current.title;
 }else if(!busy){drafts.set(selected,$('text').value);if(!catalog.some(p=>p.id===projectId))projectId=catalog[0]?.id;await selectChat(normalChats(catalog.find(p=>p.id===projectId))[0]?.id);}
 if($('drawer').open)renderChats();controls();
}
async function init(){
  const requested=/^\/devices\/([^/]+)\/$/.exec(location.pathname)?.[1];config=await loadCatalog((...args)=>client.api(...args),'/api/queue/config?realtime=1'+(requested?'&deviceId='+encodeURIComponent(requested):''));if(requested&&requested!==config.deviceId)throw Object.assign(Error('scope'),{code:'queue_scope_rejected'});
  rootConfig=config;catalog=(config.mode==='dedicated-test'?null:config.projectCatalog)??[{id:config.projectId,name:config.projectName??'专用测试项目',available:true,conversations:(config.conversations??[{id:config.conversationId,title:'专用测试会话',archived:false}]).map(c=>({...c,deviceId:config.deviceId}))}];
  $('login').hidden=true;$('workspace').hidden=false;$('loginNotice').textContent='';let saved;try{saved=localStorage.getItem('rmt-queue-selected:'+rootConfig.deviceId)??localStorage.getItem('rmt-queue-selected:mac-rn-ui-queue');}catch{}
  const chats=allChats().filter(c=>!c.archived),savedProject=allChats().find(c=>c.id===saved)?.projectId,id=chats.some(c=>c.id===saved)?saved:chats.find(c=>c.projectId===savedProject&&c.workspaceAvailable)?.id??chats.find(c=>c.workspaceAvailable)?.id??chats[0]?.id;projectId=chats.find(c=>c.id===id)?.projectId??catalog[0]?.id;await selectChat(id);catalogLive?.close();catalogLive=rootConfig.catalogRevision&&config.mode!=='dedicated-test'?new CatalogLive({revision:rootConfig.catalogRevision,api:(...args)=>client.api(...args),onChange:()=>refreshCatalog(),onError:e=>{if(e.status===401)failure(e);}}).start():null;clearInterval(timer);timer=setInterval(()=>{if(!liveAvailable)void refresh();},3000);
}
async function sendMessage(text=$('text').value.trim(),retryId){
  if(!text||busy||!state.online||chat()?.archived||desktopHistory?.capabilities?.archived||config?.queueWrites===false||chat()?.workspaceAvailable===false||desktopHistory?.capabilities?.workspaceAvailable===false)return;const pending=client.pending(route);if(pending&&pending.id!==retryId)return;busy=true;controls();let sendingId;
  try{const value=await client.job(route,{text},{writing:true,onIntent:id=>{sendingId=id;if(retryId&&retryId!==id)state.removeLocal(retryId);state.sending(id,text);if(!traces.has(id))traces.set(id,{start:performance.now(),seen:new Set()});if($('text').value.trim()===text){$('text').value='';drafts.set(selected,'');resizeInput();}follow=true;notice();render();},confirmation:confirmation(()=>{const r=state.items.get(sendingId);return r&&!r.local&&r.text===text?{receipt:r}:null;})});state.prompts.set(value.receipt.intentId,text);state.merge([value.receipt]);render();}
  catch(e){state.deliveryFailed(sendingId,Boolean(e.uncertain));failure(e);render();void refresh();}finally{busy=false;controls();}
}
async function cancelMessage(r){
  if(!r||busy||!state.online||!state.canCancel(r))return;busy=true;controls();try{const trace=traces.get(r.intentId)??{seen:new Set()};trace.cancelAt=performance.now();traces.set(r.intentId,trace);
    const value=await client.job(route+'/cancel',{intentId:r.intentId,expectedRevision:r.revision},{writing:true,scope:r.intentId+':'+r.revision,confirmation:confirmation(()=>{const current=state.items.get(r.intentId);return current&&(current.state==='cancelled'||current.cancelRequested)?{receipt:current}:null;})});state.merge([value.receipt]);render();
  }catch(e){failure(e);void refresh();}finally{busy=false;controls();}
}
function boot(){
  $('workspace').classList.toggle('native-shell',navigator.userAgent.includes(' CodexRemoteAndroid/'));
  bindDrawerSwipe();
  $('showChats').onclick=$('context').onclick=openDrawer;$('closeDrawer').onclick=()=>$('drawer').close();$('drawer').onclose=()=>{$('showChats').setAttribute('aria-expanded','false');setProjectPicker(false);};$('drawer').onclick=event=>{if(event.target===$('drawer')&&event.clientX>=$('drawer').getBoundingClientRect().right)$('drawer').close();};$('search').oninput=renderChats;if($('projectSelect'))$('projectSelect').onchange=()=>chooseProject($('projectSelect').value);
  if($('projectToggle'))$('projectToggle').onclick=()=>setProjectPicker(!projectPickerOpen);
  $('projectSearch')?.addEventListener('input',renderProjectPicker);
  $('projectPanel')?.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setProjectPicker(false);$('projectToggle').focus();return;}if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)||event.target instanceof HTMLInputElement&&['Home','End'].includes(event.key))return;const buttons=[...$('projectList').querySelectorAll('button:not(:disabled)')];if(!buttons.length)return;const index=buttons.indexOf(document.activeElement),next=event.key==='Home'?0:event.key==='End'?buttons.length-1:event.key==='ArrowDown'?Math.min(index+1,buttons.length-1):Math.max(index-1,0);event.preventDefault();buttons[next].focus();});
  $('dismissNotice').onclick=()=>notice();$('text').oninput=()=>{drafts.set(selected,$('text').value);resizeInput();};$('text').onkeydown=event=>{if(event.key==='Enter'&&!event.isComposing&&!event.shiftKey&&(event.ctrlKey||event.metaKey||!matchMedia('(pointer: coarse)').matches)){event.preventDefault();void sendMessage();}};
  $('composer').onsubmit=event=>{event.preventDefault();void sendMessage();};$('stopReply').onclick=()=>void cancelMessage(stopTarget());$('retryPending').onclick=()=>{const p=client.pending(route);if(p)void sendMessage(state.prompts.get(p.id),p.id);};$('refresh').onclick=$('reconcile').onclick=()=>void refresh();
  $('stopConsumer').onclick=async()=>{if(!state.consumer||busy)return;busy=true;controls();try{const value=await client.job(route+'/stop',{sessionId:state.consumer.sessionId},{writing:true,scope:state.consumer.sessionId,confirmation:confirmation(()=>state.consumer?.state!=='active'?{consumer:state.consumer}:null)});state.consumer=value.consumer;render();}catch(e){failure(e);}finally{busy=false;controls();}};
  $('login').onsubmit=async event=>{event.preventDefault();$('loginButton').disabled=true;try{await client.api('/api/login',{username:'admin',password:$('password').value});$('password').value='';await init();}catch(e){$('loginNotice').textContent=e.code==='invalid_credentials'?'密码不正确，请重试。':'连接失败，请检查网络后重试。';}finally{$('loginButton').disabled=false;}};
  $('chatScroll').onscroll=()=>{const el=$('chatScroll');follow=el.scrollHeight-el.clientHeight-el.scrollTop<100;updateJump();};$('jumpBottom').onclick=()=>{follow=true;$('chatScroll').scrollTop=$('chatScroll').scrollHeight;updateJump();};
  const viewport=()=>{document.documentElement.style.setProperty('--app-height',(window.visualViewport?.height??window.innerHeight)+'px');requestAnimationFrame(()=>{if(follow)$('chatScroll').scrollTop=$('chatScroll').scrollHeight;});};window.visualViewport?.addEventListener('resize',viewport);window.addEventListener('resize',viewport);viewport();
  new ResizeObserver(()=>{$('workspace').style.setProperty('--composer-offset',($('composerFooter').offsetHeight+14)+'px');}).observe($('composerFooter'));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){void refresh();void catalogLive?.check();}});window.addEventListener('online',()=>{void refresh();void catalogLive?.check();});window.addEventListener('offline',()=>{state.online=false;controls();});$('loginButton').disabled=false;void init().catch(failure);
}
// A hot asset update can briefly pair new JavaScript with an old cached page.
if(!$('chatScroll'))location.reload();else boot();
