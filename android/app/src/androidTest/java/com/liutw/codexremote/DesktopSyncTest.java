package com.liutw.codexremote;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.view.MotionEvent;
import android.webkit.WebView;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

/** Dedicated loopback acceptance; restores the original WebView URL in finally. */
@SuppressWarnings("deprecation")
public class DesktopSyncTest extends InstrumentationTestCase {
    protected WebView page;
    protected String previousUrl;
    public void testNativeHistoryStreamingAndApprovalFromManualDesktop() throws Exception {
        try {
            java.io.File f=new java.io.File(getInstrumentation().getTargetContext().getFilesDir(),"desktop-sync-test.json");
            JSONObject config=new JSONObject(new String(java.nio.file.Files.readAllBytes(f.toPath()),StandardCharsets.UTF_8));
            assertEquals("01a13feb-ce80-7ca3-aa1e-17814542b353",config.getString("conversationId"));
            assertEquals("http://127.0.0.1:38441",config.getString("origin"));
            Activity activity=getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            AtomicReference<WebView> found=new AtomicReference<>();getInstrumentation().runOnMainSync(()->found.set(find(activity.getWindow().getDecorView())));page=found.get();assertNotNull(page);
            AtomicReference<String> old=new AtomicReference<>();getInstrumentation().runOnMainSync(()->{old.set(page.getUrl());page.loadUrl(config.optString("origin")+"/");});previousUrl=old.get();
            waitFor("login loaded","typeof document.getElementById('login')?.onsubmit==='function'&&(!document.getElementById('login').hidden||!document.getElementById('workspace').hidden)",30000);
            js("if(!document.getElementById('login').hidden){document.getElementById('password').value="+JSONObject.quote(config.getString("password"))+";document.getElementById('login').requestSubmit()}true");
            waitFor("complete dedicated history","document.querySelector('.desktop-status')?.dataset.complete==='true'",30000);
            assertEquals("true",js("[...document.querySelectorAll('.desktop-transcript [data-kind=assistant]')].some(r=>r.textContent.includes('BOOTSTRAP LANTERN-4826'))"));
            js("window.nsQa={changes:[],lengths:{},tools:[]};for(const r of document.querySelectorAll('.desktop-transcript [data-kind=assistant]'))window.nsQa.lengths[r.dataset.nativeId]=r.querySelector('.message-content').textContent.length;new MutationObserver(()=>{const active=document.querySelector('.desktop-transcript').getAttribute('aria-busy')==='true';for(const r of document.querySelectorAll('.desktop-transcript [data-kind=assistant]')){const n=r.querySelector('.message-content').textContent.length,k=r.dataset.nativeId;if(window.nsQa.lengths[k]!==n&&active)window.nsQa.changes.push({at:Date.now(),length:n});window.nsQa.lengths[k]=n;}for(const r of document.querySelectorAll('.desktop-tool'))if(!window.nsQa.tools.includes(r.dataset.status))window.nsQa.tools.push(r.dataset.status);}).observe(document.querySelector('.desktop-transcript'),{subtree:true,childList:true,characterData:true});true");
            mark("AWAITING_NATIVE_STREAM_AND_APPROVAL");
            waitFor("real pending approval","document.querySelector('.approval-card button')!=null",150000);
            js("document.querySelector('.approval-card').scrollIntoView({block:'end'});true");Thread.sleep(250);shot("desktop-native-approval-pending.png");
            JSONObject point=new JSONObject(decode(js("(()=>{const b=[...document.querySelectorAll('.approval-card button')].find(x=>x.textContent==='拒绝'),r=b.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth})})()")));
            int[] offset=new int[2];getInstrumentation().runOnMainSync(()->page.getLocationOnScreen(offset));
            float scale=page.getWidth()/(float)point.getDouble("width"),x=offset[0]+(float)point.getDouble("x")*scale,y=offset[1]+(float)point.getDouble("y")*scale;
            long now=android.os.SystemClock.uptimeMillis();MotionEvent down=MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,x,y,0),up=MotionEvent.obtain(now,now+80,MotionEvent.ACTION_UP,x,y,0);
            try{assertTrue(getInstrumentation().getUiAutomation().injectInputEvent(down,true));assertTrue(getInstrumentation().getUiAutomation().injectInputEvent(up,true));}finally{down.recycle();up.recycle();}
            waitFor("approval resolved by desktop","document.querySelector('.approval-card')==null&&document.querySelector('.desktop-approvals').textContent.includes('电脑已处理')",30000);
            waitFor("dedicated turn completed","[...document.querySelectorAll('.desktop-transcript [data-kind=assistant]')].some(r=>r.textContent.includes('PHONE_APPROVAL_REAL_DONE_20261016'))&&document.querySelector('.desktop-transcript').getAttribute('aria-busy')==='false'",90000);
            assertEquals("true",js("window.nsQa.changes.length>=3"));
            js("document.getElementById('chatScroll').scrollTop=document.getElementById('chatScroll').scrollHeight;true");Thread.sleep(250);shot("desktop-native-phone-completed.png");
            String report=decode(js("JSON.stringify({historyComplete:document.querySelector('.desktop-status').dataset.complete,bodyOverflow:document.documentElement.scrollWidth>innerWidth,incrementCount:window.nsQa.changes.length,first:window.nsQa.changes.slice(0,2),last:window.nsQa.changes.slice(-2),toolStates:window.nsQa.tools,approvalResolved:document.querySelector('.desktop-approvals').textContent,originalHistory:[...document.querySelectorAll('.desktop-transcript [data-kind=assistant]')].some(r=>r.textContent.includes('BOOTSTRAP LANTERN-4826'))})"));
            try(java.io.FileOutputStream out=new java.io.FileOutputStream(new java.io.File(getInstrumentation().getTargetContext().getExternalFilesDir(null),"desktop-native-report.json"))){out.write(report.getBytes(StandardCharsets.UTF_8));}
            mark("NATIVE_HISTORY_STREAMING_APPROVAL_PASSED");
        } finally {if(page!=null&&previousUrl!=null)getInstrumentation().runOnMainSync(()->page.loadUrl(previousUrl));}
    }
    public void testCompleteHistoryAndToolsReadOnly() throws Exception {
        try {
            java.io.File f=new java.io.File(getInstrumentation().getTargetContext().getFilesDir(),"desktop-sync-test.json");
            JSONObject config=new JSONObject(new String(java.nio.file.Files.readAllBytes(f.toPath()),StandardCharsets.UTF_8));
            assertEquals("01a13feb-ce80-7ca3-aa1e-17814542b353",config.getString("conversationId"));assertEquals("http://127.0.0.1:38441",config.getString("origin"));
            Activity activity=getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));AtomicReference<WebView> found=new AtomicReference<>();getInstrumentation().runOnMainSync(()->found.set(find(activity.getWindow().getDecorView())));page=found.get();assertNotNull(page);
            AtomicReference<String> old=new AtomicReference<>();getInstrumentation().runOnMainSync(()->{old.set(page.getUrl());page.loadUrl(config.optString("origin")+"/");});previousUrl=old.get();
            waitFor("login ready","typeof document.getElementById('login')?.onsubmit==='function'&&(!document.getElementById('login').hidden||!document.getElementById('workspace').hidden)",30000);
            js("if(!document.getElementById('login').hidden){document.getElementById('password').value="+JSONObject.quote(config.getString("password"))+";document.getElementById('login').requestSubmit()}true");
            waitFor("all native history pages","document.querySelector('.desktop-status')?.dataset.complete==='true'",30000);
            assertEquals("true",js("[...document.querySelectorAll('.desktop-transcript [data-kind=assistant]')].some(r=>r.textContent.includes('BOOTSTRAP LANTERN-4826'))"));
            assertEquals("true",js("[...document.querySelectorAll('.desktop-transcript [data-kind=assistant]')].some(r=>r.textContent.includes('STREAM_DONE_20261016'))"));
            assertEquals("true",js("[...document.querySelectorAll('.desktop-tool[data-tool-type=commandExecution]')].some(e=>e.textContent.includes('pwd')&&e.dataset.status==='completed')"));
            js("(()=>{const t=[...document.querySelectorAll('.desktop-tool[data-tool-type=commandExecution]')].find(e=>e.textContent.includes('pwd'));t.querySelector('details').open=true;t.scrollIntoView({block:'center'});})() ;true");Thread.sleep(300);shot("desktop-native-phone-tools.png");
            getInstrumentation().runOnMainSync(()->page.reload());waitFor("history after reload","document.querySelector('.desktop-status')?.dataset.complete==='true'&&[...document.querySelectorAll('.desktop-transcript [data-kind=assistant]')].some(r=>r.textContent.includes('BOOTSTRAP LANTERN-4826'))",30000);
            assertEquals("false",js("document.documentElement.scrollWidth>innerWidth"));
            String report=decode(js("JSON.stringify({historyComplete:true,originalHistory:true,latestNativeAnswer:true,actualPwdTool:true,nativeItemCount:document.querySelectorAll('[data-native-id]').length,reload:true,overflow:document.documentElement.scrollWidth>innerWidth})"));
            try(java.io.FileOutputStream out=new java.io.FileOutputStream(new java.io.File(getInstrumentation().getTargetContext().getExternalFilesDir(null),"desktop-history-tools-report.json"))){out.write(report.getBytes(StandardCharsets.UTF_8));}
            shot("desktop-native-phone-history.png");mark("COMPLETE_NATIVE_HISTORY_AND_TOOLS_PASSED");
        } finally {if(page!=null&&previousUrl!=null)getInstrumentation().runOnMainSync(()->page.loadUrl(previousUrl));}
    }
    public void testApprovalOnlyFromManualDesktop() throws Exception {
        try {
            java.io.File f=new java.io.File(getInstrumentation().getTargetContext().getFilesDir(),"desktop-sync-test.json");
            JSONObject config=new JSONObject(new String(java.nio.file.Files.readAllBytes(f.toPath()),StandardCharsets.UTF_8));
            assertEquals("01a13feb-ce80-7ca3-aa1e-17814542b353",config.getString("conversationId"));assertEquals("http://127.0.0.1:38441",config.getString("origin"));
            Activity activity=getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));AtomicReference<WebView> found=new AtomicReference<>();getInstrumentation().runOnMainSync(()->found.set(find(activity.getWindow().getDecorView())));page=found.get();assertNotNull(page);
            AtomicReference<String> old=new AtomicReference<>();getInstrumentation().runOnMainSync(()->{old.set(page.getUrl());page.loadUrl(config.optString("origin")+"/");});previousUrl=old.get();
            waitFor("login ready","typeof document.getElementById('login')?.onsubmit==='function'&&(!document.getElementById('login').hidden||!document.getElementById('workspace').hidden)",30000);
            js("if(!document.getElementById('login').hidden){document.getElementById('password').value="+JSONObject.quote(config.getString("password"))+";document.getElementById('login').requestSubmit()}true");
            waitFor("all native history pages","document.querySelector('.desktop-status')?.dataset.complete==='true'",30000);
            mark("AWAITING_MANUAL_DESKTOP_APPROVAL");
            waitFor("real dedicated command approval","[...document.querySelectorAll('.approval-card')].some(e=>e.textContent.includes('curl')&&e.querySelector('button'))",150000);
            long pendingAt=System.currentTimeMillis();String approvalId=decode(js("[...document.querySelectorAll('.approval-card')].find(e=>e.textContent.includes('curl')).dataset.approvalId"));
            js("[...document.querySelectorAll('.approval-card')].find(e=>e.textContent.includes('curl')).scrollIntoView({block:'end'});true");Thread.sleep(300);shot("desktop-native-approval-pending.png");
            JSONObject point=new JSONObject(decode(js("(()=>{const c=[...document.querySelectorAll('.approval-card')].find(e=>e.textContent.includes('curl')),b=[...c.querySelectorAll('button')].find(x=>x.textContent==='拒绝'),r=b.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth})})()")));
            int[] offset=new int[2];getInstrumentation().runOnMainSync(()->page.getLocationOnScreen(offset));float scale=page.getWidth()/(float)point.getDouble("width"),x=offset[0]+(float)point.getDouble("x")*scale,y=offset[1]+(float)point.getDouble("y")*scale;
            long clickedAt=System.currentTimeMillis(),now=android.os.SystemClock.uptimeMillis();MotionEvent down=MotionEvent.obtain(now,now,MotionEvent.ACTION_DOWN,x,y,0),up=MotionEvent.obtain(now,now+80,MotionEvent.ACTION_UP,x,y,0);try{assertTrue(getInstrumentation().getUiAutomation().injectInputEvent(down,true));assertTrue(getInstrumentation().getUiAutomation().injectInputEvent(up,true));}finally{down.recycle();up.recycle();}
            waitFor("native approval resolved","document.querySelector('.approval-card')==null&&document.querySelector('.desktop-approvals').textContent.includes('电脑已处理')",30000);
            long resolvedAt=System.currentTimeMillis();JSONObject report=new JSONObject();report.put("conversationId",config.getString("conversationId"));report.put("approvalId",approvalId);report.put("decision","decline");report.put("pendingObservedAt",pendingAt);report.put("physicalTouchAt",clickedAt);report.put("desktopResolvedAt",resolvedAt);report.put("clickToResolvedMs",resolvedAt-clickedAt);report.put("approvalCardRemoved",true);
            try(java.io.FileOutputStream out=new java.io.FileOutputStream(new java.io.File(getInstrumentation().getTargetContext().getExternalFilesDir(null),"desktop-manual-decline-report.json"))){out.write(report.toString().getBytes(StandardCharsets.UTF_8));}
            shot("desktop-native-approval-resolved.png");mark("MANUAL_NATIVE_APPROVAL_PHONE_DECLINE_PASSED");
        } finally {if(page!=null&&previousUrl!=null)getInstrumentation().runOnMainSync(()->page.loadUrl(previousUrl));}
    }
    /** Verifies final native decline after the physical-touch test, including reload. */
    public void testManualDeclineOutcomeReadOnly() throws Exception {
        try {
            java.io.File f=new java.io.File(getInstrumentation().getTargetContext().getFilesDir(),"desktop-sync-test.json");JSONObject config=new JSONObject(new String(java.nio.file.Files.readAllBytes(f.toPath()),StandardCharsets.UTF_8));
            assertEquals("01a13feb-ce80-7ca3-aa1e-17814542b353",config.getString("conversationId"));assertEquals("http://127.0.0.1:38441",config.getString("origin"));String turnId=config.getString("expectedTurnId");assertTrue(turnId.matches("[0-9a-f-]{36}"));
            Activity activity=getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));AtomicReference<WebView> found=new AtomicReference<>();getInstrumentation().runOnMainSync(()->found.set(find(activity.getWindow().getDecorView())));page=found.get();assertNotNull(page);
            AtomicReference<String> old=new AtomicReference<>();getInstrumentation().runOnMainSync(()->{old.set(page.getUrl());page.loadUrl(config.optString("origin")+"/");});previousUrl=old.get();
            waitFor("login ready","typeof document.getElementById('login')?.onsubmit==='function'&&(!document.getElementById('login').hidden||!document.getElementById('workspace').hidden)",30000);
            js("if(!document.getElementById('login').hidden){document.getElementById('password').value="+JSONObject.quote(config.getString("password"))+";document.getElementById('login').requestSubmit()}true");
            String rows="[...document.querySelectorAll('.desktop-transcript [data-turn-id=\""+turnId+"\"]')]";
            String outcome="document.querySelector('.desktop-status')?.dataset.complete==='true'&&document.querySelector('.desktop-status')?.dataset.available==='true'&&"+rows+".some(e=>e.dataset.toolType==='commandExecution'&&e.dataset.status==='declined'&&e.textContent.includes('curl'))&&"+rows+".some(e=>e.dataset.kind==='assistant'&&e.textContent.includes('是否被拒绝：是')&&e.textContent.includes('是否在审批后真正执行：否'))&&document.querySelector('.desktop-transcript').getAttribute('aria-busy')==='false'";
            waitFor("native declined tool and final answer",outcome,30000);assertEquals("true",js("document.querySelectorAll('.approval-card').length===0"));
            reloadAndWaitForDocument();waitFor("same declined turn after reload",outcome,30000);
            js("document.getElementById('chatScroll').scrollTop=document.getElementById('chatScroll').scrollHeight;true");Thread.sleep(200);shot("desktop-manual-decline-final.png");
            JSONObject report=new JSONObject();report.put("conversationId",config.getString("conversationId"));report.put("turnId",turnId);report.put("toolDeclined",true);report.put("finalAnswerSynced",true);report.put("reload",true);report.put("pendingApprovals",0);report.put("messagesSent",0);
            try(java.io.FileOutputStream out=new java.io.FileOutputStream(new java.io.File(getInstrumentation().getTargetContext().getExternalFilesDir(null),"desktop-manual-outcome-report.json"))){out.write(report.toString().getBytes(StandardCharsets.UTF_8));}
            mark("MANUAL_DECLINE_FINAL_OUTCOME_READ_ONLY_PASSED");
        } finally {if(page!=null&&previousUrl!=null)getInstrumentation().runOnMainSync(()->page.loadUrl(previousUrl));}
    }
    /** Reads an already completed, auto-reviewed turn; never clicks an approval. */
    public void testAutoReviewedLifecycleOutcomeReadOnly() throws Exception {
        try {
            java.io.File f=new java.io.File(getInstrumentation().getTargetContext().getFilesDir(),"desktop-sync-test.json");
            JSONObject config=new JSONObject(new String(java.nio.file.Files.readAllBytes(f.toPath()),StandardCharsets.UTF_8));
            assertEquals("01a13fef-a018-7303-a2a6-f5903548537f",config.getString("conversationId"));
            assertEquals("http://127.0.0.1:38441",config.getString("origin"));
            String turnId=config.getString("expectedTurnId");assertTrue(turnId.matches("[0-9a-f-]{36}"));
            Activity activity=getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            AtomicReference<WebView> found=new AtomicReference<>();getInstrumentation().runOnMainSync(()->found.set(find(activity.getWindow().getDecorView())));page=found.get();assertNotNull(page);
            AtomicReference<String> old=new AtomicReference<>();getInstrumentation().runOnMainSync(()->{old.set(page.getUrl());page.loadUrl(config.optString("origin")+"/");});previousUrl=old.get();
            waitFor("login ready","typeof document.getElementById('login')?.onsubmit==='function'&&(!document.getElementById('login').hidden||!document.getElementById('workspace').hidden)",30000);
            js("if(!document.getElementById('login').hidden){document.getElementById('password').value="+JSONObject.quote(config.getString("password"))+";document.getElementById('login').requestSubmit()}true");
            waitFor("complete lifecycle history","document.querySelector('.desktop-status')?.dataset.complete==='true'&&document.querySelector('.desktop-status')?.dataset.available==='true'",30000);
            String rows="[...document.querySelectorAll('.desktop-transcript [data-turn-id=\""+turnId+"\"]')]";
            String failed=rows+".some(e=>e.dataset.toolType==='commandExecution'&&e.dataset.status==='failed'&&e.textContent.includes('Could not resolve host: example.com'))";
            String succeeded=rows+".some(e=>e.dataset.toolType==='commandExecution'&&e.dataset.status==='completed'&&e.textContent.includes('HTTP/2 200'))";
            String answer=rows+".some(e=>e.dataset.kind==='assistant'&&e.textContent.includes('网络权限申请获准后'))";
            waitFor("actual failed command",failed,30000);waitFor("actual successful retry",succeeded,30000);waitFor("actual final answer",answer,30000);
            assertEquals("true",js("document.querySelectorAll('.approval-card').length===0&&document.querySelector('.desktop-transcript').getAttribute('aria-busy')==='false'"));
            js(rows+".filter(e=>e.dataset.toolType==='commandExecution').forEach(e=>e.querySelector('details').open=true);true");
            js("document.getElementById('chatScroll').scrollTop=document.getElementById('chatScroll').scrollHeight;true");Thread.sleep(200);shot("desktop-auto-review-outcome.png");
            reloadAndWaitForDocument();waitFor("same native turn after refresh","document.querySelector('.desktop-status')?.dataset.complete==='true'&&"+failed+"&&"+succeeded+"&&"+answer,30000);
            assertEquals("true",js("document.querySelectorAll('.approval-card').length===0"));assertEquals("false",js("document.documentElement.scrollWidth>innerWidth"));
            JSONObject report=new JSONObject();report.put("conversationId",config.getString("conversationId"));report.put("turnId",turnId);report.put("historyComplete",true);report.put("failedCommandShown",true);report.put("successfulCommandShown",true);report.put("finalAnswerShown",true);report.put("reload",true);report.put("pendingApprovals",0);report.put("declineClicked",false);report.put("liveGenerationMeasured",false);
            try(java.io.FileOutputStream out=new java.io.FileOutputStream(new java.io.File(getInstrumentation().getTargetContext().getExternalFilesDir(null),"desktop-auto-review-report.json"))){out.write(report.toString().getBytes(StandardCharsets.UTF_8));}
            mark("AUTO_REVIEWED_NATIVE_OUTCOME_READ_ONLY_PASSED");
        } finally {if(page!=null&&previousUrl!=null)getInstrumentation().runOnMainSync(()->page.loadUrl(previousUrl));}
    }
    protected void mark(String value){android.os.Bundle b=new android.os.Bundle();b.putString("stream","\nPASS "+value+"\n");getInstrumentation().sendStatus(0,b);}
    // A matching old DOM does not prove reload recovery. Wait for the native
    // page-finished event, then restore the product client before assertions.
    protected void reloadAndWaitForDocument() throws Exception {
        String marker=java.util.UUID.randomUUID().toString();js("window.__rmtReloadDocument="+JSONObject.quote(marker)+";true");
        CountDownLatch loaded=new CountDownLatch(1);AtomicReference<android.webkit.WebViewClient> original=new AtomicReference<>();
        getInstrumentation().runOnMainSync(()->{original.set(page.getWebViewClient());page.setWebViewClient(new android.webkit.WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView view,android.webkit.WebResourceRequest request){return original.get().shouldOverrideUrlLoading(view,request);}
            @Override public void onPageFinished(WebView view,String url){original.get().onPageFinished(view,url);loaded.countDown();}
        });page.reload();});
        try{assertTrue("Reload did not finish",loaded.await(30,TimeUnit.SECONDS));}
        finally{getInstrumentation().runOnMainSync(()->page.setWebViewClient(original.get()));}
        waitFor("a genuinely new document after reload","document.readyState==='complete'&&window.__rmtReloadDocument!=="+JSONObject.quote(marker),30000);
    }
    protected String decode(String raw)throws Exception{return new org.json.JSONArray("["+raw+"]").getString(0);}
    protected WebView find(View v){if(v instanceof WebView)return(WebView)v;if(v instanceof ViewGroup)for(int i=0;i<((ViewGroup)v).getChildCount();i++){WebView w=find(((ViewGroup)v).getChildAt(i));if(w!=null)return w;}return null;}
    protected String js(String code)throws Exception{CountDownLatch done=new CountDownLatch(1);AtomicReference<String> value=new AtomicReference<>("");getInstrumentation().runOnMainSync(()->page.evaluateJavascript(code,r->{value.set(r);done.countDown();}));assertTrue(done.await(10,TimeUnit.SECONDS));return value.get();}
    protected void waitFor(String label,String expression,long timeout)throws Exception{long end=System.currentTimeMillis()+timeout;do{if("true".equals(js("!!("+expression+")")))return;Thread.sleep(40);}while(System.currentTimeMillis()<end);fail("Timed out: "+label);}
    protected void shot(String name)throws Exception{android.graphics.Bitmap b=getInstrumentation().getUiAutomation().takeScreenshot();try(java.io.FileOutputStream out=new java.io.FileOutputStream(new java.io.File(getInstrumentation().getTargetContext().getExternalFilesDir(null),name))){assertTrue(b.compress(android.graphics.Bitmap.CompressFormat.PNG,100,out));}finally{b.recycle();}}
}
