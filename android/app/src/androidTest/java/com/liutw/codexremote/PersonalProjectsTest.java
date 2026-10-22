package com.liutw.codexremote;
import android.app.Activity;import android.content.Intent;import android.webkit.WebView;import android.view.MotionEvent;import java.nio.charset.StandardCharsets;import java.util.concurrent.atomic.AtomicReference;import org.json.JSONObject;
/** Public ECS / real WebView acceptance. Sends only to two verified idle chats. */
@SuppressWarnings("deprecation")
public class PersonalProjectsTest extends DesktopSyncTest {
 private void touch(String expression)throws Exception{
  android.view.accessibility.AccessibilityNodeInfo active=getInstrumentation().getUiAutomation().getRootInActiveWindow();assertNotNull(active);assertEquals("Foreground changed; touch refused","com.liutw.codexremote",String.valueOf(active.getPackageName()));
  js("("+expression+").scrollIntoView({block:'center'});true");JSONObject p=new JSONObject(decode(js("(()=>{const r=("+expression+").getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth})})()")));int[] offset=new int[2];getInstrumentation().runOnMainSync(()->page.getLocationOnScreen(offset));float scale=page.getWidth()/(float)p.getDouble("width"),x=offset[0]+(float)p.getDouble("x")*scale,y=offset[1]+(float)p.getDouble("y")*scale;long now=android.os.SystemClock.uptimeMillis();MotionEvent a=MotionEvent.obtain(now,now,0,x,y,0),b=MotionEvent.obtain(now,now+80,1,x,y,0);try{assertTrue(getInstrumentation().getUiAutomation().injectInputEvent(a,true));assertTrue(getInstrumentation().getUiAutomation().injectInputEvent(b,true));}finally{a.recycle();b.recycle();}
 }
 private void select(String project,String id)throws Exception{
  touch("document.getElementById('showChats')");waitFor("project drawer","document.getElementById('drawer').open",10000);
  js("(()=>{const s=document.getElementById('projectSelect');s.value="+JSONObject.quote(project)+";s.dispatchEvent(new Event('change',{bubbles:true}));})() ;true");
  // The native select change follows the same UI handler; only existing IDs are selected.
  waitFor("project list","localStorage.getItem('rmt-queue-selected:mac-personal')!==null",10000);
  touch("[...document.querySelectorAll('.session-row')].find(b=>b.dataset.chatId==="+JSONObject.quote(id)+")");
  waitFor("selected exact ID","localStorage.getItem('rmt-queue-selected:mac-personal')==="+JSONObject.quote(id)+"&&!document.getElementById('drawer').open",15000);
  waitFor("complete original history","document.querySelector('.desktop-status')?.dataset.available==='true'&&document.querySelector('.desktop-status')?.dataset.complete==='true'",90000);
 }
 private String send(String prompt)throws Exception{
  waitFor("ready to send","!document.getElementById('text').disabled",30000);js("document.getElementById('text').value="+JSONObject.quote(prompt)+";document.getElementById('text').dispatchEvent(new Event('input',{bubbles:true}));true");waitFor("send enabled","!document.getElementById('enqueue').disabled",30000);touch("document.getElementById('enqueue')");
  waitFor("exact message delivered","[...document.querySelectorAll('.task')].some(e=>e.querySelector('.prompt')?.textContent==="+JSONObject.quote(prompt)+")",15000);
  return decode(js("[...document.querySelectorAll('.task')].find(e=>e.querySelector('.prompt')?.textContent==="+JSONObject.quote(prompt)+").dataset.intent"));
 }
 private String proof(String id,String marker){return "document.querySelector('[data-intent=\""+id+"\"]')?.dataset.state==='completed'&&document.querySelector('[data-intent=\""+id+"\"] .result').textContent.includes("+JSONObject.quote(marker)+")";}
 public void testPersonalProjectHistoryAndContinuation()throws Exception{
  JSONObject cfg=new JSONObject(new String(java.nio.file.Files.readAllBytes(new java.io.File(getInstrumentation().getTargetContext().getFilesDir(),"personal-projects-test.json").toPath()),StandardCharsets.UTF_8));assertEquals("https://47.95.141.18",cfg.getString("origin"));
  Activity activity=getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));AtomicReference<WebView> found=new AtomicReference<>();getInstrumentation().runOnMainSync(()->found.set(find(activity.getWindow().getDecorView())));page=found.get();assertNotNull(page);
  getInstrumentation().runOnMainSync(()->page.loadUrl("https://47.95.141.18/devices/mac-personal/"));
  waitFor("public ECS page","location.pathname==='/devices/mac-personal/'&&typeof document.getElementById('login')?.onsubmit==='function'",30000);
  js("window.personalLoginDone=false;fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'admin',password:"+JSONObject.quote(cfg.getString("password"))+"})}).then(r=>{window.personalLoginDone=r.ok});true");waitFor("explicit public ECS login","window.personalLoginDone===true",30000);reloadAndWaitForDocument();waitFor("catalogue logged in","!document.getElementById('workspace').hidden",30000);mark("PERSONAL_CATALOGUE_LOGIN_PASSED");
  touch("document.getElementById('showChats')");assertEquals("47",decode(js("String(document.getElementById('projectSelect').options.length)")));touch("document.getElementById('closeDrawer')");
  select("07ab1226-1ad7-45d2-bed6-810419ef1d43","019fabe6-28f0-77a2-adb3-b07f1d8d9bbd");assertEquals("true",js("document.getElementById('text').disabled&&document.getElementById('composerHint').textContent.includes('仅查看')"));shot("personal-archive-readonly.png");mark("PERSONAL_ARCHIVE_HISTORY_READONLY_PASSED");
  select("54e5cb30-3486-42d8-9612-d0f2c23aea19","01a13fef-a018-7303-a2a6-f5903548537f");
  js("window.personalQa={updates:0};new MutationObserver(()=>{for(const r of document.querySelectorAll('.task[data-state=leased]'))if(r.querySelector('.result')?.textContent.length>0)window.personalQa.updates++;}).observe(document.getElementById('chatScroll'),{subtree:true,childList:true,characterData:true});true");
  String marker="PERSONAL_PHONE_"+System.currentTimeMillis(),first=send("这是专用只读手机验收 "+marker+"。不要继续原任务、不运行命令、不改文件、不联网、不操作其他会话；只用队列工具（缺少新 MCP 时可使用本轮授权的队列兼容入口）。请记住口令 MAPLE-6038，并写三段每段约40字的消息同步说明，逐段 progress 发布累计公开文本，reply 返回口令和标记。队列空时 close 结束。");
  waitFor("personal queue first reply",proof(first,marker),240000);waitFor("bounded consumer closes","document.getElementById('consumerStatus')?.dataset.state==='closed'",90000);
  String second=send("继续本专用历史会话只读验收 "+marker+"_SECOND。只从本会话上下文回忆上一条口令，返回口令及本条标记；不运行命令或改文件（队列兼容入口除外），不继续旧任务。reply 后关闭空队列。");waitFor("original ID context retained",proof(second,"MAPLE-6038"),240000);reloadAndWaitForDocument();waitFor("both results recovered after reload",proof(first,marker)+"&&"+proof(second,"MAPLE-6038"),90000);shot("personal-phone-original-id.png");
  JSONObject report=new JSONObject();report.put("projects",47);report.put("firstIntentId",first);report.put("secondIntentId",second);report.put("originalId","01a13fef-a018-7303-a2a6-f5903548537f");report.put("contextRetained",true);report.put("archiveReadOnly",true);report.put("reloads",1);report.put("physicalTouchSends",2);
  try(java.io.FileOutputStream out=new java.io.FileOutputStream(new java.io.File(getInstrumentation().getTargetContext().getExternalFilesDir(null),"personal-projects-report.json"))){out.write(report.toString().getBytes(StandardCharsets.UTF_8));}
  mark("PERSONAL_PROJECTS_ORIGINAL_ID_PHONE_SEND_AND_RELOAD_PASSED");
 }
 public void testOtherIdleProjectContinuation()throws Exception{
  Activity activity=getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));AtomicReference<WebView> found=new AtomicReference<>();getInstrumentation().runOnMainSync(()->found.set(find(activity.getWindow().getDecorView())));page=found.get();assertNotNull(page);
  waitFor("existing authenticated personal page","location.pathname==='/devices/mac-personal/'&&!document.getElementById('workspace').hidden",30000);
  select("07ab1226-1ad7-45d2-bed6-810419ef1d43","019fa761-c061-7db0-a1b9-577b18315c39");
  String marker="OTHER_PROJECT_PHONE_"+System.currentTimeMillis(),id=send("只读手机原历史续聊验收 "+marker+"。请仅根据本会话原始用户问题，概括当时想调研什么能力，并包含本标记。不要继续执行旧任务、不运行命令、不读写文件、不联网、不操作其他会话。只使用本轮手机队列工具（没有新 MCP 时仅允许队列兼容入口），通过 reply 回传，空队列关闭。");
  waitFor("other project replies in original context",proof(id,marker)+"&&document.querySelector('[data-intent=\""+id+"\"] .result').textContent.includes('热点')",240000);waitFor("other receiver drains","document.getElementById('consumerStatus').dataset.state==='closed'",90000);reloadAndWaitForDocument();waitFor("other project result restored",proof(id,marker),90000);
  assertEquals("No horizontal page overflow","false",js("document.documentElement.scrollWidth>innerWidth"));assertEquals("No horizontal page offset","0",decode(js("String(scrollX)")));shot("personal-other-project-reply.png");
  JSONObject report=new JSONObject();report.put("projectId","07ab1226-1ad7-45d2-bed6-810419ef1d43");report.put("conversationId","019fa761-c061-7db0-a1b9-577b18315c39");report.put("intentId",id);report.put("contextRetained",true);report.put("physicalTouchSends",1);report.put("reloads",1);report.put("overflow",false);try(java.io.FileOutputStream out=new java.io.FileOutputStream(new java.io.File(getInstrumentation().getTargetContext().getExternalFilesDir(null),"personal-other-project-report.json"))){out.write(report.toString().getBytes(StandardCharsets.UTF_8));}mark("OTHER_PROJECT_ORIGINAL_HISTORY_PHONE_REPLY_RELOAD_PASSED");
 }

 public void testNativePersonalLaunchReady()throws Exception{
  Activity activity=getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));AtomicReference<WebView> found=new AtomicReference<>();getInstrumentation().runOnMainSync(()->found.set(find(activity.getWindow().getDecorView())));page=found.get();assertNotNull(page);
  waitFor("normal APK launches personal cloud catalog","location.origin==='https://47.95.141.18'&&!document.getElementById('workspace')?.hidden&&document.getElementById('showChats')!=null",60000);
  waitFor("normal launch recovers complete live history","document.querySelector('.desktop-status')?.dataset.available==='true'&&document.querySelector('.desktop-status').dataset.complete==='true'&&document.getElementById('connection').textContent.includes('已同步')",90000);
  assertEquals("false",js("document.documentElement.scrollWidth>innerWidth"));touch("document.getElementById('showChats')");assertEquals("47",decode(js("String(document.getElementById('projectSelect').options.length)")));shot("personal-native-project-picker.png");touch("document.getElementById('closeDrawer')");shot("personal-native-launch-ready.png");mark("NORMAL_APK_START_PROJECT_PICKER_AND_HISTORY_READY_PASSED");
 }

 public void testEmptyAndMissingWorkspaceReadOnly()throws Exception{
  Activity activity=getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));AtomicReference<WebView> found=new AtomicReference<>();getInstrumentation().runOnMainSync(()->found.set(find(activity.getWindow().getDecorView())));page=found.get();assertNotNull(page);reloadAndWaitForDocument();waitFor("personal page","!document.getElementById('workspace')?.hidden",30000);
  js("window.emptyRequests=[];const originalFetch=window.fetch;window.fetch=(...a)=>{if(String(a[0]).includes('undefined'))window.emptyRequests.push(String(a[0]));return originalFetch(...a);};true");touch("document.getElementById('showChats')");js("const s=document.getElementById('projectSelect');s.value='local-eb4f0c75850a22713c6e3630123864a7';s.dispatchEvent(new Event('change',{bubbles:true}));true");touch("document.getElementById('closeDrawer')");waitFor("empty project state","document.getElementById('emptyHint').textContent.includes('还没有')&&document.getElementById('text').disabled",10000);Thread.sleep(3500);assertEquals("No undefined queue requests","0",decode(js("String(window.emptyRequests.length)")));assertEquals("true",js("document.getElementById('notice').hidden"));
  select("local-88bfa0cd38c27f1c96dcbcc161d16a69","01a036d1-6c96-71c2-a0fd-6e1768f17f3d");assertEquals("true",js("document.getElementById('text').disabled&&document.getElementById('text').placeholder.includes('目录不存在')"));shot("personal-missing-workspace-readonly.png");select("07ab1226-1ad7-45d2-bed6-810419ef1d43","019fa761-c061-7db0-a1b9-577b18315c39");mark("EMPTY_PROJECT_AND_MISSING_WORKSPACE_HISTORY_PASSED");
 }

}
