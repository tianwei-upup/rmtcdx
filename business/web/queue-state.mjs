export const labels = { queued:'排队中', leased:'处理中', completed:'已完成', cancelled:'已取消', unknown:'结果未知' };
export class QueueState {
  constructor() { this.items=new Map(); this.prompts=new Map(); this.consumer=null; this.online=false; }
  merge(receipts) { for(const r of receipts) { const old=this.items.get(r.intentId); if(!old || r.revision>=old.revision) this.items.set(r.intentId,r); } }
  list() { return [...this.items.values()]; }
  label(r) { return r.resolution==='abandoned_unknown' ? '结果未知 · 已停止跟进' : r.cancelRequested && r.state==='leased' ? '等待取消确认' : labels[r.state] || r.state; }
  canCancel(r) { return ['queued','leased'].includes(r.state) && !r.cancelRequested; }
}
