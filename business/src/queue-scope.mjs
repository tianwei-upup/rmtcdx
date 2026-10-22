import { object, identifier, string, fail, QUEUE_OPERATIONS } from './contracts.mjs';

// Explicit snapshot of one named project's existing chats; never a cwd wildcard.
export function queueTestScope(value) {
  if (value == null) return null;
  if(value.mode==='personal-projects'){
    object(value,['mode','deviceId','projects','autoDiscover'],['mode','deviceId','projects']);identifier(value.deviceId);if(value.autoDiscover!==undefined&&value.autoDiscover!==true)fail('invalid_queue_scope');
    if(!Array.isArray(value.projects)||value.projects.length>100)fail('invalid_queue_scope');
    const projects=value.projects.map(p=>{object(p,['id','name','available','conversations']);identifier(p.id);string(p.name,100);if(typeof p.available!=='boolean'||!Array.isArray(p.conversations)||p.conversations.length>1000)fail('invalid_queue_scope');const g=queueTestScope({mode:'project-readonly',deviceId:value.deviceId,projectId:p.id,projectName:p.name,conversations:p.conversations.length?p.conversations:[{id:'empty-project-placeholder',title:'placeholder',archived:true}]});return Object.freeze({id:p.id,name:p.name,available:p.available,conversations:Object.freeze(p.conversations.length?g.conversations:[])});});
    const ids=projects.flatMap(p=>p.conversations.map(c=>c.id));if(ids.length>5000||new Set(ids).size!==ids.length||new Set(projects.map(p=>p.id)).size!==projects.length)fail('invalid_queue_scope');
    return Object.freeze({mode:value.mode,deviceId:value.deviceId,projects:Object.freeze(projects),...(value.autoDiscover?{autoDiscover:true}:{})});
  }
  if (value.mode === 'project-readonly') {
    object(value, ['mode','deviceId','projectId','projectName','conversations']);
    identifier(value.deviceId); identifier(value.projectId); string(value.projectName,100);
    if (!Array.isArray(value.conversations) || !value.conversations.length || value.conversations.length>5000) fail('invalid_queue_scope');
    const conversations=value.conversations.map(c=>{
      object(c,['id','title','archived','workspaceAvailable','binding'],['id','title','archived']); identifier(c.id); string(c.title,200);
      if(c.workspaceAvailable!==undefined&&typeof c.workspaceAvailable!=='boolean'||c.binding!==undefined&&!/^[0-9a-f]{64}$/.test(c.binding))fail('invalid_queue_scope');
      if(typeof c.archived!=='boolean') fail('invalid_queue_scope');
      return Object.freeze({...c});
    });
    if(new Set(conversations.map(c=>c.id)).size!==conversations.length) fail('invalid_queue_scope');
    return Object.freeze({...value,conversations:Object.freeze(conversations)});
  }
  object(value, ['mode', 'deviceId', 'projectId', 'conversationId']);
  if (value.mode !== 'dedicated-test') fail('dedicated_queue_scope_required');
  for (const key of ['deviceId', 'projectId', 'conversationId']) identifier(value[key]);
  return Object.freeze({ ...value });
}
export const queueConversationAllowed=(scope,id)=>scope.mode==='personal-projects'?scope.projects.some(p=>p.conversations.some(c=>c.id===id)):scope.mode==='dedicated-test'?id===scope.conversationId:scope.conversations.some(c=>c.id===id);
export const queueProjects=scope=>scope.mode==='personal-projects'?scope.projects:[{id:scope.projectId,name:scope.projectName??'专用测试项目',available:true,conversations:scope.conversations??[{id:scope.conversationId,title:'专用测试会话',archived:false}]}];
export const queueChats=scope=>queueProjects(scope).flatMap(p=>p.conversations.map(c=>({...c,projectId:p.id})));
export const queueProjectAllowed=(scope,id)=>queueProjects(scope).some(p=>p.id===id);
export const queueConversationProject=(scope,id)=>queueChats(scope).find(c=>c.id===id)?.projectId;
export const SCOPED_QUEUE_OPERATIONS = ['projects.sync', 'directory.sync', 'sessions.sync', ...QUEUE_OPERATIONS];

// Each entry remains an exact, independently authorized device/project/chat grant.
export function queueScopeList(value){
  if(value==null)return [];
  const values=value.mode==='explicit-queues'?(object(value,['mode','grants']),value.grants):[value];
  if(!Array.isArray(values)||!values.length||values.length>5)fail('invalid_queue_scope');
  const grants=values.map(queueTestScope),devices=new Set(),chats=new Set();
  for(const g of grants){
    if(devices.has(g.deviceId))fail('duplicate_queue_scope');devices.add(g.deviceId);
    for(const id of queueChats(g).map(c=>c.id)){
      if(chats.has(id))fail('duplicate_queue_scope');chats.add(id);
    }
  }
  return grants;
}
