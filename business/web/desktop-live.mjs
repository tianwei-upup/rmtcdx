// State snapshots retain stable native item IDs. Incremental text comes from
// desktop owner patches; no timers manufacture characters or token boundaries.
export class DesktopState {
 constructor(){this.items=new Map();this.order=[];this.available=false;this.epoch=null;this.revision=-1;this.approvals=[];this.unsupported=[];this.capabilities={};this.historyComplete=false;}
 snapshot(value){this.items=new Map(value.items.map(i=>[i.id,i]));this.order=value.items.map(i=>i.id);this.applyMeta(value);}
 applyMeta(value){Object.assign(this,{epoch:value.epoch,revision:value.revision,available:value.available,reason:value.reason,historyComplete:value.historyComplete,approvals:value.approvals??[],activeTurnId:value.activeTurnId,unsupported:value.unsupported??[],capabilities:value.capabilities??{}});}
 update(value){if(this.epoch!==value.epoch||this.revision!==value.baseRevision)return false;const next=new Map(this.items);for(const i of value.items)next.set(i.id,i);const ids=new Set(value.order);if(ids.size!==value.order.length||value.order.some(id=>!next.has(id)))return false;for(const id of next.keys())if(!ids.has(id))next.delete(id);this.items=next;this.order=value.order;this.applyMeta(value);return true;}
 list(){return this.order.map(id=>this.items.get(id)).filter(Boolean);}
 invalidate(reason){this.available=false;this.reason=reason;this.approvals=[];}
}
export class DesktopLive {
 constructor({route,api,onChange,onError,eventSource=url=>new EventSource(url)}){Object.assign(this,{route,api,onChange,onError,eventSource});this.state=new DesktopState();this.closed=false;this.buffer=[];this.generation=0;}
 start(){this.source=this.eventSource(this.route+'/events');this.source.onmessage=e=>{try{const value=JSON.parse(e.data);if(value.type==='desktop.reset'){this.generation++;this.state.invalidate(value.reason??'desktop_connecting');this.onChange(this.state);void this.refresh();}else if(value.type==='desktop.update'){if(this.loading){this.buffer.push(value);if(this.buffer.length>1000){this.buffer=[];this.reload=true;}}else if(this.state.update(value))this.onChange(this.state);else void this.refresh();}}catch(error){this.onError(error);}};this.source.onerror=()=>{this.generation++;this.state.invalidate('desktop_disconnected');this.onChange(this.state);};this.source.onopen=()=>void this.refresh();return this;}
 async refresh(){
  if(this.closed)return;if(this.loading){this.reload=true;return;}this.loading=true;this.buffer=[];const generation=this.generation;
  try{let cursor,base,items=[];do{const page=await this.api(this.route+'/history'+(cursor?'?cursor='+encodeURIComponent(cursor):''));if(this.closed)return;if(base&&(page.epoch!==base.epoch||page.revision!==base.revision))throw Error('desktop_page_changed');base??=page;items.push(...page.items);cursor=page.nextCursor;}while(cursor);
   if(generation!==this.generation){this.reload=true;return;}this.state.snapshot({...base,items});for(const update of this.buffer){if(update.epoch===this.state.epoch&&update.revision<=this.state.revision)continue;if(!this.state.update(update)){this.reload=true;this.state.invalidate('desktop_revision_gap');break;}}this.onChange(this.state);
  }catch(error){if(!this.closed){this.state.invalidate('desktop_unavailable');this.onChange(this.state);this.onError(error);}}finally{this.loading=false;if(this.reload&&!this.closed){this.reload=false;void this.refresh();}}
 }
 close(){this.closed=true;this.generation++;this.source?.close();this.buffer=[];}
}
