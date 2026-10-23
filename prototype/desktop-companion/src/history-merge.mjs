import {nativeTurns} from './desktop-view.mjs';

const messageText=i=>i.text??(Array.isArray(i.content)?i.content.map(v=>v.text??'').join('\n'):'');
const completedIds=t=>Array.isArray(t.completedItemIds)?t.completedItemIds:Object.keys(t.completedItemIds??{});
function mergeTurn(file,live){
 if(file.completionObserved&&live.status==='inProgress')return file;
 // A terminal native turn is canonical in full. Legacy JSONL tool records may
 // use different IDs/types for the same call; combining both would duplicate
 // the tools. File-only turns still supply the missing older prefix.
 if(file.status!=='inProgress'&&live.status!=='inProgress')return live;
 const items=[...(file.items??[])],ids=new Map(items.map((i,n)=>[i.id,n])),used=new Set();
 for(const item of live.items??[]){
  let index=ids.get(item.id);
  // Old response records have synthetic message IDs; native canonical items
  // have real IDs. Match those messages once, rather than display duplicates.
  if(index===undefined&&['userMessage','agentMessage'].includes(item.type))index=items.findIndex((old,n)=>!used.has(n)&&/^(user|agent|final):\d+$/.test(old.id)&&old.type===item.type&&messageText(old)===messageText(item));
  if(index===undefined||index<0){index=items.length;items.push(item);}else items[index]=item;
  ids.set(item.id,index);used.add(index);
 }
 return {...file,...live,items,completedItemIds:[...new Set([...completedIds(file),...completedIds(live)])]};
}
export function mergeHistory(file,live){
 const normalize=t=>({...t,turnId:t.turnId??t.entityKey}),persisted=nativeTurns(file),native=nativeTurns(live),byId=new Map(persisted.turns.map(t=>{const v=normalize(t);return[v.turnId,v];})),order=[...byId.keys()],latest=native.turns.map(normalize);
 for(const [i,t]of latest.entries()){
  if(byId.has(t.turnId))byId.set(t.turnId,mergeTurn(byId.get(t.turnId),t));
  else{const anchor=latest.slice(i+1).find(v=>byId.has(v.turnId)),at=anchor?order.indexOf(anchor.turnId):order.length;order.splice(at,0,t.turnId);byId.set(t.turnId,t);}
 }
 // Flatten canonical islands only for the public projection. The actual native
 // stream/owner, approval requests and write routing are never replaced.
 const {turnHistory,...state}=live;
 return {...state,turns:order.map(id=>byId.get(id)),turnsPagination:{hasMore:!(persisted.complete||native.complete)}};
}
