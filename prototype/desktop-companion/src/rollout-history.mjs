import fs from 'node:fs';
import path from 'node:path';
import {zstdDecompressSync} from 'node:zlib';

const fail=code=>{throw Object.assign(Error(code),{code});};
const parts=value=>typeof value==='string'?value:Array.isArray(value)?value.filter(p=>['text','Text','input_text','output_text'].includes(p.type)).map(p=>p.text??'').join('\n'):'';
const printable=value=>typeof value==='string'?value:value==null?'':JSON.stringify(value,null,2);
const camel=type=>type==='McpToolCall'?'mcpToolCall':type[0].toLowerCase()+type.slice(1);
function nativeItem(i){
 if(!i||typeof i.type!=='string'||typeof i.id!=='string')return null;
 if(['Reasoning','reasoning','ContextCompaction'].includes(i.type))return null;
 if(i.type==='UserMessage')return{type:'userMessage',id:i.id,content:i.content,clientId:i.client_id};
 if(i.type==='AgentMessage')return{type:'agentMessage',id:i.id,text:parts(i.content),phase:i.phase??null};
 if(i.type==='CommandExecution')return{type:'commandExecution',id:i.id,command:printable(i.command),aggregatedOutput:i.aggregated_output??[i.stdout,i.stderr].filter(Boolean).join('\n'),status:i.status,exitCode:i.exit_code};
 if(i.type==='FileChange')return{type:'fileChange',id:i.id,changes:i.changes,status:i.status,output:i.stdout};
 if(i.type==='McpToolCall')return{type:'mcpToolCall',id:i.id,server:i.server,tool:i.tool,arguments:i.arguments,status:i.status,result:i.result?.Ok??i.result,...(i.result?.Err?{error:printable(i.result.Err)}:{})};
 if(i.type==='Extension')return{type:i.kind==='web.search'?'webSearch':'toolCall',id:i.id,name:i.kind,query:i.query,arguments:i.revisedPrompt??i.input??'',status:i.status??'completed',output:i.kind==='web.search'?printable(i.results):'专有附件内容请在桌面查看。'};
 if(['WebSearch','ImageView','DynamicToolCall','ToolCall','FunctionCall','FunctionCallOutput'].includes(i.type))return{type:camel(i.type),id:i.id,name:i.name,arguments:i.arguments,query:i.query,path:i.path,status:i.status,output:parts(i.output)||printable(i.output)};
 return{type:'unsupported:'+i.type,id:i.id};
}

// Native persisted public items are already separate from reasoning, provider
// context, permission profiles and credentials. Prefer them over model inputs.
// Older CLI files use response/event records; preserve those without treating
// context instructions as new phone requests or executing any recorded tool.
export function decodeRollout(text,{conversationId,cwd}){
 const lines=text.split('\n'),records=[];
 for(let n=0;n<lines.length;n++){
  if(!lines[n])continue;
  try{records.push({...JSON.parse(lines[n]),line:n});}catch{if(n===lines.length-1&&!text.endsWith('\n'))break;fail('invalid_rollout_history');}
 }
 return decodeRecords(records,{conversationId,cwd});
}
function decodeRecords(records,{conversationId,cwd}){
 const meta=records.find(r=>r.type==='session_meta')?.payload;
 if((meta?.id??meta?.session_id)!==conversationId)fail('rollout_scope_rejected');
 const canonicalTurns=new Set(),userTurns=new Set(),assistantTurns=new Set();let scan='legacy:0';
 for(const r of records){const p=r.payload??{};if(r.type==='turn_context'&&p.turn_id||r.type==='event_msg'&&p.type==='task_started')scan=p.turn_id??scan;if(r.type==='event_msg'&&p.type==='item_completed')canonicalTurns.add(p.turn_id??scan);if(r.type==='event_msg'&&p.type==='user_message')userTurns.add(scan);if(r.type==='response_item'&&p.type==='message'&&p.role==='assistant')assistantTurns.add(scan);}
 const turns=new Map(),calls=new Map();let current='legacy:0';
 const turn=(id=current,at)=>{if(!turns.has(id))turns.set(id,{turnId:id,status:'completed',startedAt:at?Date.parse(at):null,items:[],completedItemIds:[]});return turns.get(id);};
 const add=(t,i)=>{if(!i)return;const old=t.items.findIndex(v=>v.id===i.id);if(old>=0)t.items[old]=i;else t.items.push(i);if(!t.completedItemIds.includes(i.id))t.completedItemIds.push(i.id);};
 for(const r of records){const p=r.payload??{},canonical=canonicalTurns.has(p.turn_id??current),hasUsers=userTurns.has(current),hasAssistant=assistantTurns.has(current);
  if(r.type==='turn_context'&&p.turn_id){current=p.turn_id;turn(current,r.timestamp);continue;}
  if(r.type==='event_msg'){
   if(p.type==='task_started'){for(const t of turns.values())if(t.status==='inProgress'&&t.turnId!==p.turn_id)t.status='interrupted';current=p.turn_id??current;turn(current,r.timestamp).status='inProgress';continue;}
   if(p.type==='task_complete'||p.type==='turn_aborted'){const t=turn(p.turn_id??current,r.timestamp);t.status=p.type==='turn_aborted'?'interrupted':'completed';if(!canonical&&p.last_agent_message&&!t.items.some(i=>i.type==='agentMessage'&&i.phase==='final_answer'))add(t,{type:'agentMessage',id:'final:'+r.line,text:p.last_agent_message,phase:'final_answer'});continue;}
   if(canonical&&p.type==='item_completed'){add(turn(p.turn_id??current,r.timestamp),nativeItem(p.item));continue;}
   if(!canonical&&p.type==='user_message')add(turn(current,r.timestamp),{type:'userMessage',id:'user:'+r.line,content:[{type:'text',text:p.message??''}],clientId:p.client_id});
   if(!canonical&&!hasAssistant&&p.type==='agent_message')add(turn(current,r.timestamp),{type:'agentMessage',id:'agent:'+r.line,text:p.message??'',phase:p.phase??'final_answer'});
  }
  if(canonical||r.type!=='response_item')continue;
  const t=turn(current,r.timestamp);
  if(p.type==='message'&&p.role==='assistant')add(t,{type:'agentMessage',id:p.id??'agent:'+r.line,text:parts(p.content),phase:p.phase??'final_answer'});
  else if(p.type==='message'&&p.role==='user'&&!hasUsers)add(t,{type:'userMessage',id:p.id??'user:'+r.line,content:p.content});
  else if(['function_call','custom_tool_call'].includes(p.type)){const i={type:'functionCall',id:p.call_id??p.id??'call:'+r.line,name:p.name,arguments:p.arguments??p.input,status:'running'};calls.set(p.call_id,{t,i});add(t,i);}
  else if(['function_call_output','custom_tool_call_output'].includes(p.type)){const call=calls.get(p.call_id);if(call){call.i.output=parts(p.output)||printable(p.output);call.i.status='completed';}else add(t,{type:'functionCallOutput',id:p.call_id??'output:'+r.line,output:parts(p.output)||printable(p.output),status:'completed'});}
 }
 return{id:conversationId,cwd,turns:[...turns.values()].filter(t=>t.items.length),turnsPagination:{hasMore:false},requests:[]};
}

const toolLimit=8192;
function compact(value,key=''){
 if(/^(base64|image_base64|bytes_base64)$/i.test(key))return '[二进制正文已省略]';
 if(typeof value==='string'){
  if(key==='arguments'&&value.length>toolLimit)try{return JSON.stringify(compact(JSON.parse(value)));}catch{}
  return ['arguments','input','output','aggregated_output','stdout','stderr','diff'].includes(key)&&value.length>toolLimit?value.slice(0,4096)+'\n[工具详情过长，手机展示首尾摘要；完整详情请在桌面查看]\n'+value.slice(-4096):value;
 }
 if(Array.isArray(value))return value.map(v=>compact(v));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['raw_content','summary_text','encrypted_content'].includes(k)).map(([k,v])=>[k,k==='data'&&['image','input_image'].includes(value.type)?'[图片正文已省略]':compact(v,k)]));return value;
}
function publicRecord(line,index){
 if(!line.trim())return null;let r;try{r=JSON.parse(line);}catch{fail('invalid_rollout_history');}const p=r.payload??{};
 if(r.type==='session_meta')return{type:r.type,payload:{id:p.id,session_id:p.session_id},line:index};
 if(r.type==='turn_context')return{type:r.type,payload:{turn_id:p.turn_id},timestamp:r.timestamp,line:index};
 if(r.type==='event_msg'&&!['task_started','task_complete','turn_aborted','item_completed','user_message','agent_message'].includes(p.type))return null;
 if(r.type==='event_msg'&&p.type==='item_completed'&&['Reasoning','ContextCompaction'].includes(p.item?.type))return null;
 if(!['event_msg','response_item'].includes(r.type))return null;
 if(r.type==='response_item'&&['reasoning','compaction'].includes(p.type))return null;
 return {...r,payload:compact(p),line:index};
}
function publicRecords(lines){return lines.flatMap((line,n)=>{try{const r=publicRecord(line,n);return r?[r]:[];}catch(e){if(n===lines.length-1)return[];throw e;}});}

export class RolloutHistory {
 constructor(scope,{maxBytes=2*1024*1024*1024}={}){this.scope=scope;this.maxBytes=maxBytes;this.cache=new Map();}
 read(id){
  const chat=this.scope.check(id),root=fs.realpathSync(path.dirname(this.scope.metadataDatabase)),base=chat.rollout_path;
  let file=base,compressed=false;if(!fs.existsSync(file)){file+='.zst';compressed=true;}
  const real=fs.realpathSync(file);if(![path.join(root,'sessions')+path.sep,path.join(root,'archived_sessions')+path.sep].some(prefix=>real.startsWith(prefix)))fail('unsafe_rollout_history');
  const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||st.size>this.maxBytes)fail('unsafe_rollout_history');
  const signature=[real,st.ino,st.size,st.mtimeMs,chat.archived,chat.cwd].join(':');
  let cached=this.cache.get(id);if(cached?.signature!==signature){const previous=cached,append=!compressed&&previous?.real===real&&previous.ino===st.ino&&st.size>=previous.offset;const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let records;
   try{if(compressed){const bytes=zstdDecompressSync(fs.readFileSync(fd),{maxOutputLength:512*1024*1024});records=publicRecords(bytes.toString('utf8').split('\n'));}
   else{records=append?[...previous.records]:[];const buffer=Buffer.alloc(1024*1024);let pending=append?previous.tail:Buffer.alloc(0),line=append?previous.lines:0,n,position=append?previous.offset:0;
    while((n=fs.readSync(fd,buffer,0,buffer.length,position))>0){position+=n;pending=Buffer.concat([pending,buffer.subarray(0,n)]);let start=0,index;while((index=pending.indexOf(10,start))>=0){const record=publicRecord(pending.subarray(start,index).toString('utf8'),line++);if(record)records.push(record);start=index+1;}pending=Buffer.from(pending.subarray(start));if(pending.length>64*1024*1024)fail('rollout_record_too_large');}
    // Native appends can leave one incomplete trailing record.
    var offset=position,tail=pending,lines=line;
   }}finally{fs.closeSync(fd);}let displayRecords=records;if(!compressed&&tail.length)try{const last=publicRecord(tail.toString('utf8'),lines);if(last)displayRecords=[...records,last];}catch{}const state=decodeRecords(displayRecords,{conversationId:id,cwd:chat.cwd});cached={signature,state,...(!compressed?{records,real,ino:st.ino,offset,tail,lines}:{})};this.cache.set(id,cached);}

  // Only selected histories are cached; a shared catalog is not a history dump.
  while(this.cache.size>2)this.cache.delete(this.cache.keys().next().value);
  return{...cached,chat};
 }
}
