package com.liutw.codexremote;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

/** Explicit single-project queue acceptance. Does not start/interrupt native turns. */
@SuppressWarnings("deprecation")
public class OwnerQueueSmokeTest extends InstrumentationTestCase {
    private WebView page;
    private String normalId, cancelId;
    public void testQueueReadOnlyReopen() throws Exception {
        java.io.File file=new java.io.File(getInstrumentation().getTargetContext().getFilesDir(),"queue-test.json");
        JSONObject config=new JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()),StandardCharsets.UTF_8));
        assertEquals("mac-owner-inbox-test",config.getString("deviceId"));
        assertEquals("01a13fef-a018-7303-a2a6-f5903548537f",config.getString("conversationId"));
        Activity activity=getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(),MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        AtomicReference<WebView> found=new AtomicReference<>();getInstrumentation().runOnMainSync(()->found.set(findPage(activity.getWindow().getDecorView())));page=found.get();assertNotNull(page);
        waitFor("final queue handlers ready","typeof document.getElementById('login')?.onsubmit==='function'&&!document.getElementById('loginButton').disabled",30000);
        evaluate("if(!document.getElementById('login').hidden){document.getElementById('password').value="+JSONObject.quote(config.getString("password"))+";document.getElementById('login').requestSubmit()}true");
        waitFor("final prompts and results restored","document.getElementById('login').hidden&&Array.from(document.querySelectorAll('.result')).some(x=>x.textContent==='APK_QUEUE1 TULIP-7386')&&Array.from(document.querySelectorAll('.result')).some(x=>x.textContent==='APK_QUEUE2 TULIP-7386')",30000);
        assertEquals("true",evaluate("document.documentElement.classList.contains('android-shell')&&document.documentElement.scrollWidth<=innerWidth"));
        evaluate("window.scrollTo(0,0);true");
        android.graphics.Bitmap shot=getInstrumentation().getUiAutomation().takeScreenshot();assertNotNull(shot);
        try(java.io.FileOutputStream out=new java.io.FileOutputStream(new java.io.File(getInstrumentation().getTargetContext().getExternalFilesDir(null),"owner-queue-final.png"))){assertTrue(shot.compress(android.graphics.Bitmap.CompressFormat.PNG,100,out));}finally{shot.recycle();}
        mark("FINAL_QUEUE_VIEW_PASSED");
    }
    public void testDedicatedQueueViaEcs() throws Exception {
        java.io.File file = new java.io.File(getInstrumentation().getTargetContext().getFilesDir(), "queue-test.json");
        JSONObject config = new JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
        assertEquals("mac-owner-inbox-test", config.getString("deviceId"));
        assertEquals("01a13fef-a018-7303-a2a6-f5903548537f", config.getString("conversationId"));
        String origin = HostAddress.cloudOrigin(config.getString("origin"));
        assertTrue(origin.startsWith("https://"));
        getInstrumentation().getTargetContext().getSharedPreferences("hosts", 0).edit().putString("cloud_url", origin).putInt("active", 1).commit();
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        AtomicReference<WebView> found = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> found.set(findPage(activity.getWindow().getDecorView())));
        page = found.get(); assertNotNull(page);
        waitFor("queue page via normal Mac route", "!!document.getElementById('composer')&&location.pathname==='/devices/mac-owner-inbox-test/'", 30000);
        waitFor("queue handlers ready", "typeof document.getElementById('login').onsubmit==='function'&&!document.getElementById('loginButton').disabled", 30000);
        evaluate("if(!document.getElementById('login').hidden){document.getElementById('password').value=" + JSONObject.quote(config.getString("password")) + ";document.getElementById('login').requestSubmit()}true");
        waitFor("online dedicated scope", "document.getElementById('login').hidden&&document.getElementById('connection').textContent==='电脑在线'", 30000);
        assertEquals("false", evaluate("!!document.getElementById('project')"));
        send("APK_QUEUE_CANCEL TULIP-7386：这条排队任务应在领取前取消，不执行任何工作。");
        waitFor("queued before consumer", "Array.from(document.querySelectorAll('.task')).some(x=>x.textContent.includes('APK_QUEUE_CANCEL TULIP-7386')&&x.dataset.state==='queued')", 30000);
        evaluate("Array.from(document.querySelectorAll('.task')).find(x=>x.textContent.includes('APK_QUEUE_CANCEL TULIP-7386')).querySelector('button').click();true");
        waitFor("queued cancellation confirmed", "Array.from(document.querySelectorAll('.task')).some(x=>x.textContent.includes('APK_QUEUE_CANCEL TULIP-7386')&&x.dataset.state==='cancelled')", 30000);
        send("这是 APK 公网队列只读验收。记住代码 TULIP-7386，只回复 APK_QUEUE1 TULIP-7386。不读写文件、不联网、不操作其他聊天。");
        waitFor("normal intent queued", "Array.from(document.querySelectorAll('.task')).some(x=>x.textContent.includes('记住代码 TULIP-7386')&&x.dataset.state==='queued')", 30000);
        normalId = decode(evaluate("Array.from(document.querySelectorAll('.task')).find(x=>x.textContent.includes('记住代码 TULIP-7386')).dataset.intent"));
        mark("AWAITING_DESKTOP_CONSUMER");
        waitFor("real desktop result", "Array.from(document.querySelectorAll('.task')).some(x=>x.dataset.intent===" + JSONObject.quote(normalId) + "&&x.dataset.state==='completed'&&x.querySelector('.result')?.textContent==='APK_QUEUE1 TULIP-7386')", 180000);
        send("APK_QUEUE_CANCEL_RUNNING TULIP-7386：这是协作取消验收。先 checkpoint；若尚未取消，用 exec_command 运行 /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node -e \"setTimeout(() => {}, 15000)\" 只读等待，再 checkpoint。若取消已请求，只 ack_cancel，不 complete。不操作文件、网络或其他聊天。");
        waitFor("leased cancellation target", "Array.from(document.querySelectorAll('.task')).some(x=>x.textContent.includes('APK_QUEUE_CANCEL_RUNNING TULIP-7386')&&x.dataset.state==='leased')", 60000);
        cancelId = decode(evaluate("Array.from(document.querySelectorAll('.task')).find(x=>x.textContent.includes('APK_QUEUE_CANCEL_RUNNING TULIP-7386')).dataset.intent"));
        evaluate("Array.from(document.querySelectorAll('.task')).find(x=>x.dataset.intent===" + JSONObject.quote(cancelId) + ").querySelector('button').click();true");
        waitFor("cooperative cancellation confirmed", "Array.from(document.querySelectorAll('.task')).find(x=>x.dataset.intent===" + JSONObject.quote(cancelId) + ")?.dataset.state==='cancelled'", 60000);
        send("沿用当前队列上下文的代码，只回复 APK_QUEUE2 TULIP-7386。不读写文件、不联网、不操作其他聊天。");
        waitFor("second result same desktop context", "Array.from(document.querySelectorAll('.result')).some(x=>x.textContent==='APK_QUEUE2 TULIP-7386')", 120000);
        getInstrumentation().runOnMainSync(() -> page.reload());
        waitFor("reload restores prompts and results", "Array.from(document.querySelectorAll('.result')).some(x=>x.textContent==='APK_QUEUE1 TULIP-7386')&&Array.from(document.querySelectorAll('.result')).some(x=>x.textContent==='APK_QUEUE2 TULIP-7386')&&document.body.textContent.includes('APK_QUEUE_CANCEL_RUNNING TULIP-7386')", 45000);
        waitFor("bounded consumer closed", "document.getElementById('consumerStatus').textContent.includes('桌面未开启领取')", 30000);
        evaluate("window.scrollTo(0,document.body.scrollHeight);true");
        android.graphics.Bitmap shot = getInstrumentation().getUiAutomation().takeScreenshot();
        assertNotNull(shot);
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(new java.io.File(getInstrumentation().getTargetContext().getExternalFilesDir(null), "owner-queue.png"))) { assertTrue(shot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out)); }
        finally { shot.recycle(); }
        mark("QUEUE_APK_ACCEPTANCE_PASSED");
    }
    private void send(String text) throws Exception {
        waitFor("composer enabled", "!document.getElementById('enqueue').disabled", 30000);
        evaluate("document.getElementById('text').value=" + JSONObject.quote(text) + ";document.getElementById('composer').requestSubmit();true");
        waitFor("message durably enqueued", "document.getElementById('text').value===''", 30000);
    }
    private void mark(String value) { android.os.Bundle b = new android.os.Bundle(); b.putString("stream", "\nPASS " + value + "\n"); getInstrumentation().sendStatus(0, b); }
    private String decode(String raw) throws Exception { return new org.json.JSONArray("[" + raw + "]").getString(0); }
    private WebView findPage(View view) { if(view instanceof WebView)return(WebView)view;if(view instanceof ViewGroup)for(int i=0;i<((ViewGroup)view).getChildCount();i++){WebView p=findPage(((ViewGroup)view).getChildAt(i));if(p!=null)return p;}return null; }
    private String evaluate(String script) throws Exception { CountDownLatch done=new CountDownLatch(1);AtomicReference<String> value=new AtomicReference<>("");getInstrumentation().runOnMainSync(()->page.evaluateJavascript(script,r->{value.set(r);done.countDown();}));assertTrue("JS callback",done.await(10,TimeUnit.SECONDS));return value.get(); }
    private void waitFor(String label,String expression,long timeout) throws Exception { long end=System.currentTimeMillis()+timeout;do{if("true".equals(evaluate("!!("+expression+")"))){mark(label);return;}Thread.sleep(300);}while(System.currentTimeMillis()<end);fail("Timed out: "+label+" state="+evaluate("JSON.stringify({path:location.pathname,notice:document.getElementById('notice')?.textContent,status:document.getElementById('connection')?.textContent})")); }
}
