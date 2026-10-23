import path from 'node:path';
import {failure} from './app-tools.mjs';

const exists=(db,name)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const pending=db=>Boolean(db.prepare("SELECT 1 FROM jobs WHERE state IN ('queued','leased','unknown')").get());
const same=(a,b)=>a.projectId===b.projectId&&a.cwd===b.cwd&&a.binding===b.binding;
const synchronous=(value,code)=>{if(value&&typeof value.then==='function')throw failure(code);return value;};
function currentScope(inbox,checkScope){
 const chat=synchronous(checkScope(inbox.threadId,{write:true}),'native_delivery_async_scope');
 if(!chat||chat.id!==inbox.threadId||typeof chat.projectId!=='string'||!chat.projectId||!path.isAbsolute(chat.cwd??'')||typeof chat.binding!=='string'||!chat.binding)throw failure('native_delivery_scope_required');
 if(chat.archived!==false&&chat.archived!==0)throw failure('archived_conversation_readonly');
 if(chat.workspaceAvailable===false)throw failure('workspace_unavailable');
 return{threadId:inbox.threadId,projectId:chat.projectId,cwd:chat.cwd,binding:chat.binding};
}
function idle(checkNativeIdle,scope){
 if(synchronous(checkNativeIdle(scope.threadId,scope),'native_delivery_async_idle')!==true)throw failure('native_delivery_native_busy');
}
function drained(db,allowQueued){
 if(db.prepare("SELECT 1 FROM jobs WHERE state IN ('leased','unknown')"+(allowQueued?'':" OR state='queued'")).get())throw failure('native_delivery_jobs_pending');
 if(db.prepare("SELECT 1 FROM consumers WHERE state IN ('active','stopping')").get())throw failure('native_delivery_consumer_active');
 if(exists(db,'standby_policy')&&db.prepare('SELECT 1 FROM standby_policy WHERE enabled=1').get())throw failure('native_delivery_standby_enabled');
}
function validateDispatch(db){
 const columns=db.prepare('PRAGMA table_info(native_dispatch)').all().map(c=>c.name);
 if(JSON.stringify(columns)!==JSON.stringify(['intent_id','client_id','admission','turn_id','prepared_at']))throw failure('native_delivery_schema_changed');
}

// The caller holds the runtime owner lock and has stopped this chat's legacy
// receiver, including awaiting its pending admission. This guard cannot cancel
// a native activation which another receiver already submitted.
export function migrateNativeDelivery(inbox,{checkScope,checkNativeIdle,beforeCommit,adoptExisting=false,allowQueued=false}={}){
 if(!inbox?.db||typeof inbox.transaction!=='function'||typeof checkScope!=='function'||typeof checkNativeIdle!=='function'||beforeCommit!==undefined&&typeof beforeCommit!=='function'||typeof adoptExisting!=='boolean'||typeof allowQueued!=='boolean')throw failure('native_delivery_migration_required');
 return inbox.transaction(()=>{
  const db=inbox.db,scope=currentScope(inbox,checkScope);idle(checkNativeIdle,scope);
  const hadDispatch=exists(db,'native_dispatch'),hadMarker=exists(db,'native_delivery');
  let marker;
  if(hadMarker){
   marker=db.prepare('SELECT * FROM native_delivery WHERE singleton=1').get();
   if(!marker||marker.version!==1||!hadDispatch)throw failure('native_delivery_schema_changed');
   if(!same(scope,{projectId:marker.project_id,cwd:marker.cwd,binding:marker.binding}))throw failure(pending(db)?'native_delivery_binding_changed_pending':'native_delivery_binding_changed');
  }
  drained(db,allowQueued);
  if(hadDispatch&&!hadMarker&&!adoptExisting)throw failure('native_delivery_adoption_required');
  if(hadDispatch)validateDispatch(db);
  db.exec(`CREATE TABLE IF NOT EXISTS native_dispatch(intent_id TEXT PRIMARY KEY REFERENCES jobs(intent_id),client_id TEXT NOT NULL UNIQUE,admission TEXT NOT NULL,turn_id TEXT,prepared_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS native_delivery(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL CHECK(version=1),project_id TEXT NOT NULL,cwd TEXT NOT NULL,binding TEXT NOT NULL,migrated_at INTEGER NOT NULL);`);
  if(!marker)db.prepare('INSERT INTO native_delivery VALUES(1,1,?,?,?,?)').run(scope.projectId,scope.cwd,scope.binding,Date.now());
  db.exec(`CREATE TRIGGER IF NOT EXISTS native_delivery_consumer_insert BEFORE INSERT ON consumers
   WHEN NEW.state IN ('active','stopping') BEGIN SELECT RAISE(ABORT,'inbox_native_delivery_only'); END;
   CREATE TRIGGER IF NOT EXISTS native_delivery_consumer_update BEFORE UPDATE ON consumers
   WHEN NEW.state IN ('active','stopping') BEGIN SELECT RAISE(ABORT,'inbox_native_delivery_only'); END;
   CREATE TRIGGER IF NOT EXISTS native_delivery_legacy_lease BEFORE UPDATE OF state ON jobs
   WHEN NEW.state='leased' AND NOT EXISTS(SELECT 1 FROM native_dispatch WHERE intent_id=NEW.intent_id)
   BEGIN SELECT RAISE(ABORT,'inbox_native_delivery_only'); END;`);
  synchronous(beforeCommit?.(scope),'native_delivery_async_commit');
  const finalScope=currentScope(inbox,checkScope);
  if(!same(scope,finalScope))throw failure('native_delivery_binding_changed');
  idle(checkNativeIdle,finalScope);drained(db,allowQueued);
  return{state:hadMarker?'resumed':'migrated',scope};
 });
}
