import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {discoverPersonal} from './personal-discovery.mjs';
import {desktopProjects} from '../../../business/src/projects.mjs';

const reject=code=>{throw Object.assign(Error(code),{code});};
// Explicit user-approved project/chat snapshot. Neither shared cwd nor a phone
// request can add a project, move a chat or override native archive status.
export class PersonalScope {
 constructor({manifest,desktopStateFile,metadataDatabase}){
  if(manifest?.version!==1||manifest.enabled!==true||!Array.isArray(manifest.projects)||manifest.projects.length>100||!Array.isArray(manifest.chats)||manifest.chats.length>5000)reject('personal_scope_required');
  this.projects=new Map(manifest.projects.map(p=>[p.id,p]));this.chats=new Map(manifest.chats.map(c=>[c.id,c]));
  if(!path.isAbsolute(manifest.runtime??'')||this.projects.size!==manifest.projects.length||this.chats.size!==manifest.chats.length||manifest.chats.some(c=>!this.projects.has(c.projectId)||!/^[a-zA-Z0-9_-]{1,100}$/.test(c.id)||!path.isAbsolute(c.cwd)||c.acceptanceOnly&&c.id!=='01a13feb-ce80-7ca3-aa1e-17814542b353'))reject('personal_scope_required');
  if(manifest.discovery!==undefined&&manifest.discovery!=='local-projects')reject('personal_scope_required');
  Object.assign(this,{manifest,desktopStateFile,metadataDatabase});this.refresh();
 }
 // Explicit discovery still scans everything. Admission reuses only identical
 // source files/WAL; the exact native row, archive and cwd are checked below.
 sourceStamp(){return JSON.stringify([this.desktopStateFile,this.metadataDatabase,this.metadataDatabase+'-wal'].map(file=>{try{const s=fs.statSync(file,{bigint:true});return [String(s.dev),String(s.ino),String(s.size),String(s.mtimeNs),String(s.ctimeNs)];}catch(error){if(error.code==='ENOENT')return null;throw error;}}));}
 refresh({force=true}={}){if(this.manifest.discovery==='local-projects'){
  const before=this.sourceStamp();if(!force&&before===this.catalogStamp)return this;
  const s=discoverPersonal(this);if(before!==this.sourceStamp())reject('desktop_catalog_changing');
  this.projects=new Map(s.projects.map(p=>[p.id,p]));this.chats=new Map(s.chats.map(c=>[c.id,c]));this.catalogStamp=before;this.chatStamps=new Map();
 }return this;}

 check(id,{write=false}={}){
  if(this.manifest.discovery==='local-projects'){
   const stamp=this.sourceStamp();if(stamp!==this.catalogStamp&&this.chatStamps?.get(id)!==stamp){
    // Other active chats update the shared WAL continuously. Check only this
    // exact chat against current project metadata; periodic discovery still
    // replaces the complete catalog. Never reuse a time-based auth cache.
    const value=discoverPersonal({...this,conversationId:id});if(stamp!==this.sourceStamp())reject('desktop_catalog_changing');
    const current=value.chats.find(c=>c.id===id);if(!current){this.chats.delete(id);reject('personal_scope_rejected');}
    this.projects=new Map(value.projects.map(p=>[p.id,p]));this.chats.set(id,current);this.chatStamps??=new Map();this.chatStamps.set(id,stamp);
   }
  }else this.refresh({force:false});
  const chat=this.chats.get(id);if(!chat)reject('personal_scope_rejected');
  const dynamic=this.manifest.discovery==='local-projects',project=dynamic?this.projects.get(chat.projectId):desktopProjects(this.desktopStateFile).find(p=>p.id===chat.projectId);
  if(!dynamic&&!project?.threadIds.includes(id)&&!chat.acceptanceOnly)reject('personal_membership_changed');
  const db=new DatabaseSync(this.metadataDatabase,{readOnly:true});let row;
  try{row=db.prepare('SELECT cwd,archived,rollout_path,title FROM threads WHERE id=?').get(id);}finally{db.close();}
  if(!row||row.cwd!==chat.cwd)reject('personal_scope_changed');
  const workspaceAvailable=fs.existsSync(row.cwd)&&fs.statSync(row.cwd).isDirectory();
  if(write&&row.archived!==0)reject('archived_conversation_readonly');
  if(write&&!workspaceAvailable)reject('workspace_unavailable');
  return {...chat,...row,...(dynamic?{title:chat.title}:{}),archived:row.archived===1,workspaceAvailable,projectName:project?.name??this.projects.get(chat.projectId).name};
 }
 route(id){const c=this.chats.get(id);if(!c)reject('personal_scope_rejected');return c.queueRuntime??this.manifest.runtime;}
}
