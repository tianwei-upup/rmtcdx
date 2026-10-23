import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const reject=code=>{throw Object.assign(Error(code),{code});};

// Current paginated rollouts reference an immutable older prefix in Codex's
// public-item projection. Read only this exact thread and ordinal boundary.
export class HistoryBase {
 constructor(root,{maxBytes=512*1024*1024}={}){this.file=path.join(root,'thread_history_1.sqlite');this.maxBytes=maxBytes;this.cache=new Map();}
 read(id,base,cwd){
  if(base.thread_id!==id)reject('history_base_scope_rejected');
  if(!Number.isSafeInteger(base.end_ordinal_exclusive)||base.end_ordinal_exclusive<0||!Number.isSafeInteger(base.end_byte_offset)||base.end_byte_offset<0)reject('invalid_history_base');
  let st;try{st=fs.lstatSync(this.file);}catch{reject('history_base_unavailable');}
  if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid())reject('unsafe_history_base');
  const db=new DatabaseSync(this.file,{readOnly:true});
  try{
   db.exec('BEGIN');
   const progress=db.prepare('SELECT next_rollout_ordinal,next_rollout_byte_offset FROM thread_history_projection_state WHERE thread_id=?').get(id),stats=db.prepare('SELECT COUNT(*) AS count,MAX(updated_at_ordinal) AS revision,SUM(length(item_json)) AS bytes FROM thread_items WHERE thread_id=? AND rollout_ordinal<?').get(id,base.end_ordinal_exclusive);
   if(stats.bytes>this.maxBytes)reject('history_base_too_large');
   const complete=Boolean(progress&&progress.next_rollout_ordinal>=base.end_ordinal_exclusive&&progress.next_rollout_byte_offset>=base.end_byte_offset),signature=JSON.stringify([st.ino,base,stats.count,stats.revision,complete]);
   const old=this.cache.get(id);if(old?.signature===signature)return old;
   const turns=db.prepare('SELECT turn_id,status,started_at,completed_at FROM thread_turns WHERE thread_id=? AND rollout_ordinal<? ORDER BY rollout_ordinal,turn_id').all(id,base.end_ordinal_exclusive).map(r=>({turnId:r.turn_id,status:r.status,startedAt:r.started_at,completionObserved:r.completed_at!=null,items:[],completedItemIds:[]})),byId=new Map(turns.map(t=>[t.turnId,t]));
   for(const r of db.prepare('SELECT turn_id,item_id,item_type,item_json FROM thread_items WHERE thread_id=? AND rollout_ordinal<? ORDER BY rollout_ordinal,item_id').all(id,base.end_ordinal_exclusive)){
    if(['reasoning','contextCompaction'].includes(r.item_type))continue;
    const item=JSON.parse(r.item_json);if(item.id!==r.item_id||typeof item.type!=='string')reject('invalid_history_base_item');if(['reasoning','contextCompaction'].includes(item.type))continue;
    const turn=byId.get(r.turn_id);if(!turn)reject('invalid_history_base_turn');turn.items.push(item);if(turn.status!=='inProgress')turn.completedItemIds.push(item.id);
   }
   const value={signature,state:{id,cwd,turns,turnsPagination:{hasMore:!complete},requests:[]}};this.cache.set(id,value);while(this.cache.size>2)this.cache.delete(this.cache.keys().next().value);return value;
  }finally{db.close();}
 }
}
