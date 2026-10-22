import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {desktopProjects} from '../../../business/src/projects.mjs';

const metadataSignature=s=>JSON.stringify([s['local-projects'],s['thread-project-assignments'],s['app-server-project-id-by-legacy-project-id-by-host'],s['thread-titles']]);
export const contextBinding=c=>crypto.createHash('sha256').update(JSON.stringify([c.id,c.projectId,c.cwd])).digest('hex');
export function discoverPersonal({manifest,desktopStateFile,metadataDatabase}){
 const before=fs.readFileSync(desktopStateFile,'utf8'),raw=JSON.parse(before);
 if(!raw['local-projects']||!raw['thread-project-assignments'])throw Error('desktop_catalog_unavailable');
 const projects=desktopProjects(desktopStateFile),db=new DatabaseSync(metadataDatabase,{readOnly:true});let rows,nativeProjects=[],roots=[];
 try{db.exec('BEGIN');const columns=new Set(db.prepare('PRAGMA table_info(threads)').all().map(c=>c.name));rows=new Map(db.prepare('SELECT id,cwd,archived,title'+(columns.has('name')?',name':'')+(columns.has('project_id')?',project_id':'')+(columns.has('updated_at_ms')?',updated_at_ms':'')+' FROM threads').all().map(c=>[c.id,c]));const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t=>t.name));if(tables.has('projects')&&tables.has('project_roots')){nativeProjects=db.prepare('SELECT id,name,metadata FROM projects ORDER BY position,id').all();roots=db.prepare('SELECT project_id,path FROM project_roots ORDER BY position').all();}}finally{db.exec('ROLLBACK');db.close();}
 if(metadataSignature(JSON.parse(fs.readFileSync(desktopStateFile,'utf8')))!==metadataSignature(raw))throw Object.assign(Error('desktop_catalog_changing'),{code:'desktop_catalog_changing'});
 // Preserve existing public project IDs through the desktop's explicit migration
 // aliases. New native projects use their own ID; shared cwd never joins them.
 const aliases=raw['app-server-project-id-by-legacy-project-id-by-host']?.['local:'+path.dirname(metadataDatabase)]??{},legacyByNative=new Map(Object.entries(aliases).map(([old,id])=>[id,old])),nativeToPublic=new Map();
 for(const p of nativeProjects){const id=legacyByNative.get(p.id)??p.id,paths=[...new Set(roots.filter(r=>r.project_id===p.id&&path.isAbsolute(r.path)).map(r=>{try{return fs.realpathSync(r.path);}catch{return path.resolve(r.path);}}))];if(!paths.length)continue;const metadata=JSON.parse(p.metadata);if(metadata.hostId&&metadata.hostId!=='local'||metadata.projectKind&&metadata.projectKind!=='local')continue;
  nativeToPublic.set(p.id,id);const existing=projects.find(p=>p.id===id),value={id,name:String(p.name||existing?.name||'新项目').slice(0,100),paths,path:paths[0],available:paths.some(p=>{try{return fs.statSync(p).isDirectory();}catch{return false;}}),threadIds:existing?.threadIds??[]};if(existing)Object.assign(existing,value);else projects.push(value);
 }
 const overrides=new Map(manifest.chats.filter(c=>c.queueRuntime).map(c=>[c.id,c])),chats=[];
 for(const row of rows.values()){
  const legacy=raw['thread-project-assignments'][row.id],projectId=row.project_id?nativeToPublic.get(row.project_id):legacy?.projectKind==='local'?legacy.projectId:null;if(!projectId||!projects.some(p=>p.id===projectId))continue;if(!path.isAbsolute(row.cwd))throw Error('desktop_catalog_invalid');
  let workspaceAvailable=false;try{workspaceAvailable=fs.statSync(row.cwd).isDirectory();}catch{}
  const id=row.id,c={id,projectId,cwd:row.cwd,title:String(row.name||raw['thread-titles']?.titles?.[id]||row.title||'新会话').slice(0,200),archived:row.archived!==0,workspaceAvailable,...(Number.isSafeInteger(row.updated_at_ms)&&row.updated_at_ms>0?{updatedAt:Math.floor(row.updated_at_ms/1000)}:{}),...(overrides.has(id)?{queueRuntime:overrides.get(id).queueRuntime}:{})};c.binding=contextBinding(c);chats.push(c);
 }
 for(const c of manifest.chats.filter(c=>c.acceptanceOnly))if(!chats.some(x=>x.id===c.id)){chats.push(c);if(!projects.some(p=>p.id===c.projectId))projects.push({...manifest.projects.find(p=>p.id===c.projectId),acceptanceOnly:true});}
 if(projects.length>100||chats.length>5000)throw Error('desktop_catalog_capacity');
 return {projects:projects.map(({threadIds,...p})=>p),chats};
}
export function personalGrant(scope,deviceId){
 scope.refresh();return {mode:'personal-projects',deviceId,autoDiscover:true,projects:[...scope.projects.values()].filter(p=>!p.acceptanceOnly).map(p=>({id:p.id,name:p.name,available:p.available??true,conversations:[...scope.chats.values()].filter(c=>c.projectId===p.id&&!c.acceptanceOnly&&scope.route(c.id)===scope.manifest.runtime).map(c=>({id:c.id,title:c.title,archived:c.archived,workspaceAvailable:c.workspaceAvailable,binding:c.binding,...(c.updatedAt?{updatedAt:c.updatedAt}:{})}))}))};
}
