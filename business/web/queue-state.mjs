export const labels = { queued:'排队中', leased:'处理中', completed:'已完成', cancelled:'已取消', unknown:'结果未知' };
export class QueueState {
  constructor() { this.items=new Map(); this.prompts=new Map(); this.consumer=null; this.online=false; }
  merge(receipts) { for(const r of receipts) { const old=this.items.get(r.intentId); if(!old || r.revision>old.revision || r.revision===old.revision&&(r.progress?.seq??0)>=(old.progress?.seq??0)) this.items.set(r.intentId,r); } }
  sending(intentId,text,now=Date.now()) { const old=this.items.get(intentId); this.prompts.set(intentId,text); if(!old||old.local)this.items.set(intentId,{intentId,text,state:'sending',revision:0,local:true,timing:{enqueuedAt:old?.timing?.enqueuedAt??now}}); }
  deliveryFailed(intentId,uncertain) { const old=this.items.get(intentId); if(old?.local)this.items.set(intentId,{...old,state:uncertain?'unconfirmed':'failed'}); }
  removeLocal(intentId) { if(this.items.get(intentId)?.local)this.items.delete(intentId); }
  list() { return [...this.items.values()].sort((a,b)=>(a.timing?.enqueuedAt??0)-(b.timing?.enqueuedAt??0)); }
  label(r) { return r.resolution==='abandoned_unknown' ? '结果未知 · 已停止跟进' : r.cancelRequested && r.state==='leased' ? '等待取消确认' : labels[r.state] || r.state; }
  canCancel(r) { return ['queued','leased'].includes(r.state) && !r.cancelRequested; }
}
