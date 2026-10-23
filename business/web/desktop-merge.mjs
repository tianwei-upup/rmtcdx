// Identity-based correlation only. Equal text and sharing a native turn never
// prove two messages are the same (several phone jobs can share that turn).
export function mergeDesktopQueue(items,receipts){
  const pending=new Map(receipts.map(r=>[r.intentId,r])),placed=new Set(),list=[];
  const linked=new Set(items.flatMap(i=>(i.queueLinks??[]).map(l=>l.intentId)));
  const unlinked=receipts.filter(r=>!linked.has(r.intentId)).sort((a,b)=>(a.timing?.enqueuedAt??0)-(b.timing?.enqueuedAt??0));
  const place=r=>{list.push({kind:'queue',id:'queue:'+r.intentId,receipt:r,turnId:r.consumerTurnId});placed.add(r.intentId);};
  for(const item of items){
    while(unlinked.length&&item.at!=null&&(unlinked[0].timing?.enqueuedAt??0)<=item.at)place(unlinked.shift());
    const links=(item.queueLinks??[]).filter(l=>pending.has(l.intentId));
    for(const link of links)if(!placed.has(link.intentId)){
      list.push({kind:'queue',id:'queue:'+link.intentId,receipt:pending.get(link.intentId),turnId:item.turnId,correlated:true,...(item.kind==='user'?{native:true,hasNativeReply:items.some(i=>i.kind==='assistant'&&i.turnId===item.turnId&&i.text)}:{})});placed.add(link.intentId);
    }
    // Only suppress a queue transport row if its jobs are represented. Other
    // native tools, commentary and uncorrelated history are always retained.
    if(!links.length||item.queueLinks.some(l=>!pending.has(l.intentId)))list.push(item);
  }
  for(const r of receipts)if(!placed.has(r.intentId))place(r);
  return list;
}
