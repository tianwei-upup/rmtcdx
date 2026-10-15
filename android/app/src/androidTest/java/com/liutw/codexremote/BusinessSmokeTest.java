package com.liutw.codexremote;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebView;
import android.widget.Button;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Explicit opt-in: creates and resumes only isolated project conversations. */
@SuppressWarnings("deprecation")
public class BusinessSmokeTest extends InstrumentationTestCase {
    private Activity activity;
    private WebView page;
    private JSONObject config;
    private String devicePath;
    private String mainHost;
    private String otherHost;

    public void testBusinessHttpsChatInteraction() throws Exception {
        java.io.File file = new java.io.File(getInstrumentation().getTargetContext().getFilesDir(), "business-test.json");
        config = new JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
        String origin = HostAddress.cloudOrigin(config.getString("origin"));
        assertTrue("HTTPS is required", origin.startsWith("https://"));
        getInstrumentation().getTargetContext().getSharedPreferences("hosts", 0).edit().clear()
          .putBoolean("windows_default_migrated", true).putString("cloud_url", origin).putInt("active", 1).commit();
        CountDownLatch cookies = new CountDownLatch(1);
        getInstrumentation().runOnMainSync(() -> CookieManager.getInstance().removeAllCookies(ignored -> cookies.countDown()));
        assertTrue(cookies.await(10, TimeUnit.SECONDS));
        activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        page = webView();
        waitFor("verified HTTPS login", "!!document.getElementById('password')&&!document.getElementById('login').hidden&&!document.getElementById('loginSubmit').disabled", 30000);
        evaluate("document.getElementById('password').value=" + JSONObject.quote(config.getString("password")) + ";document.getElementById('login').requestSubmit();true");
        waitFor("isolated project registered", "Array.from(document.getElementById('project')?.options||[]).some(p=>p.value==='rmtagt-compat')", 45000);
        evaluate("document.getElementById('project').value='rmtagt-compat';document.getElementById('project').dispatchEvent(new Event('change'));true");
        waitFor("isolated project synced", "document.getElementById('project').value==='rmtagt-compat'&&document.getElementById('projectName').textContent.includes('验证')", 45000);
        assertEquals("Native controls must not occupy chat space", "true", evaluate("document.documentElement.classList.contains('native-shell')"));
        evaluate("document.getElementById('new').click();true");
        waitFor("new chat opens blank without creating a thread", "!document.getElementById('welcome').hidden&&!document.getElementById('text').readOnly", 20000);
        String marker = "HONOR_UI_" + System.currentTimeMillis();
        send("Do not use tools or modify files. Reply exactly " + marker + ".");
        waitFor("optimistic user message", "document.querySelectorAll('.message.user').length===1", 5000);
        waitFor("new real Codex response", "Array.from(document.querySelectorAll('.message.assistant')).some(x=>x.textContent.includes(" + JSONObject.quote(marker) + "))", 120000);
        waitFor("new turn settled", "document.getElementById('pending').hidden&&document.getElementById('interrupt').hidden", 45000);
        tapWebElement(".message.assistant:last-child .message-actions button");
        waitFor("copy feedback", "!!document.querySelector('.message.assistant:last-child button[data-copied=true]')", 10000);
        AtomicReference<Boolean> clipboardMatches = new AtomicReference<>(false);
        getInstrumentation().runOnMainSync(() -> {
            android.content.ClipboardManager clipboard = (android.content.ClipboardManager) activity.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
            android.content.ClipData clip = clipboard.getPrimaryClip();
            clipboardMatches.set(clip != null && clip.getItemCount() > 0 && clip.getItemAt(0).coerceToText(activity).toString().contains(marker));
        });
        assertTrue("Copied answer matches isolated response", clipboardMatches.get());
        evaluate("window.__fullViewport=innerHeight;true");
        tapWebElement("#text");
        waitFor("keyboard resizes chat viewport", "innerHeight<window.__fullViewport-120", 15000);
        assertEquals("Composer stays above keyboard", "true", evaluate("document.getElementById('composer').getBoundingClientRect().bottom<=visualViewport.height+2"));
        getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);
        waitFor("keyboard dismissed without leaving chat", "innerHeight>=window.__fullViewport-40", 10000);
        String draft = "DRAFT_" + marker;
        evaluate("document.getElementById('text').value=" + JSONObject.quote(draft) + ";document.getElementById('text').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('showSessions').click();true");
        waitFor("drawer is open", "document.getElementById('drawer').open", 10000);
        waitFor("active conversation in history", "!!document.querySelector('.session-row[aria-current=true]')", 30000);
        evaluate("window.__fixtureId=document.querySelector('.session-row[aria-current=true]').dataset.id;document.getElementById('drawerNew').click();true");
        waitFor("new chat has separate draft", "!document.getElementById('welcome').hidden&&document.getElementById('text').value===''", 10000);
        evaluate("document.getElementById('showSessions').click();true");
        waitFor("drawer reopened", "document.getElementById('drawer').open", 10000);
        evaluate("Array.from(document.querySelectorAll('.session-row')).find(x=>x.dataset.id===window.__fixtureId).click();true");
        waitFor("switch restores draft", "document.getElementById('text').value===" + JSONObject.quote(draft), 15000);
        String resume = marker + "_RESUME";
        send("Do not use tools or modify files. Reply exactly " + resume + ".");
        waitFor("resumed real Codex response", "Array.from(document.querySelectorAll('.message.assistant')).some(x=>x.textContent.includes(" + JSONObject.quote(resume) + "))", 120000);
        waitFor("resumed turn settled", "document.getElementById('pending').hidden&&document.getElementById('interrupt').hidden", 45000);
        clickNative("Windows"); WebView other = webView(); assertNotSame(page, other);
        clickNative("Mac"); assertSame("Host switch retains the WebView", page, webView());
        waitFor("host switch retains conversation", "document.body.textContent.includes(" + JSONObject.quote(resume) + ")", 10000);
        evaluate("document.getElementById('showSessions').click();true");
        waitFor("back closes drawer first", "document.getElementById('drawer').open", 10000);
        getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);
        waitFor("drawer closed by system back", "!document.getElementById('drawer').open", 10000);
        evaluate("document.getElementById('chatScroll').scrollTop=document.getElementById('chatScroll').scrollHeight;window.__painted=false;requestAnimationFrame(()=>requestAnimationFrame(()=>window.__painted=true));true");
        waitFor("page painted", "window.__painted", 10000);
        android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(new java.io.File(getInstrumentation().getTargetContext().getExternalFilesDir(null), "business-smoke.png"))) { assertTrue(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out)); } finally { screenshot.recycle(); }
    }
    public void testProjectCatalogAndLocalPins() throws Exception {
        java.io.File file = new java.io.File(getInstrumentation().getTargetContext().getFilesDir(), "business-test.json");
        config = new JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
        String origin = HostAddress.cloudOrigin(config.getString("origin"));
        getInstrumentation().getTargetContext().getSharedPreferences("hosts", 0).edit().putString("cloud_url", origin).putInt("active", 1).commit();
        activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); page = webView();
        waitFor("unified sidebar page loaded", "!!document.getElementById('directoryStatus')", 30000);
        waitFor("authentication state resolved", "document.getElementById('project').options.length>0||!document.getElementById('login').hidden", 30000);
        evaluate("if(!document.getElementById('login').hidden){document.getElementById('password').value=" + JSONObject.quote(config.getString("password")) + ";document.getElementById('login').requestSubmit()}true");
        waitFor("all projects and sessions prefetched before opening sidebar", "document.getElementById('project').options.length>=46&&Number(document.getElementById('directoryStatus').dataset.syncedAt)>0", 65000);
        assertEquals("No independent project popup", "true", evaluate("!document.getElementById('projectsPanel')"));
        evaluate("document.getElementById('context').click();true");
        waitFor("one sidebar contains all project rows", "document.getElementById('drawer').open&&document.querySelectorAll('.project-row').length>=46", 10000);
        evaluate("document.getElementById('search').value='挡板子库';document.getElementById('search').dispatchEvent(new Event('input'));true");
        waitFor("search filters project tree locally", "document.querySelectorAll('.project-row').length===2", 5000);
        evaluate("document.getElementById('search').value='';document.getElementById('search').dispatchEvent(new Event('input'));window.__previousPins=localStorage.getItem('rmt-project-pins:v1:mac');window.__syncRequests=0;window.__savedFetch=window.fetch;window.fetch=(route,options)=>{if(String(route).endsWith('/sync'))window.__syncRequests++;return window.__savedFetch(route,options)};true");
        String target = "200a1af4-2b21-45ce-b301-e8d084c48eb5";
        String row = ".project-row[data-project-id='" + target + "']";
        evaluate("if(document.querySelector(\"" + row + " .project-pin\").getAttribute('aria-pressed')==='true')document.querySelector(\"" + row + " .project-pin\").click();document.querySelector(\"" + row + " .project-pin\").click();true");
        waitFor("local pin reorders sidebar", "document.querySelector('.project-row').dataset.projectId===" + JSONObject.quote(target), 5000);
        assertEquals("Pin and search trigger no directory requests", "0", evaluate("window.__syncRequests"));
        getInstrumentation().sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK);
        waitFor("sidebar collapsed", "!document.getElementById('drawer').open", 10000);
        evaluate("window.__syncedBefore=Number(document.getElementById('directoryStatus').dataset.syncedAt);true");
        waitFor("background directory sync completes while sidebar stays collapsed", "!document.getElementById('drawer').open&&Number(document.getElementById('directoryStatus').dataset.syncedAt)>window.__syncedBefore&&window.__syncRequests>0", 75000);
        evaluate("window.__requestsBeforeOpen=window.__syncRequests;document.getElementById('context').click();window.__requestsOnOpen=window.__syncRequests-window.__requestsBeforeOpen;true");
        waitFor("cached directory is immediately visible", "document.getElementById('drawer').open&&document.querySelectorAll('.project-row').length>=46", 5000);
        assertEquals("Opening sidebar performs no new sync", "0", evaluate("window.__requestsOnOpen"));
        evaluate("window.__requestsBeforeToggle=window.__syncRequests;const button=document.querySelector(\"" + row + " .project-select\");if(button.getAttribute('aria-expanded')==='true')button.click();document.querySelector(\"" + row + " .project-select\").click();window.__requestsOnToggle=window.__syncRequests-window.__requestsBeforeToggle;true");
        assertEquals("Project expansion performs no new sync", "0", evaluate("window.__requestsOnToggle"));
        waitFor("sessions are nested beneath selected project", "document.querySelector(\".project-group[data-project-id='" + target + "'] .project-sessions\").hidden===false&&document.querySelectorAll(\".project-group[data-project-id='" + target + "'] .session-row\").length>0", 5000);
        tapWebElement(".project-group[data-project-id='" + target + "'] .session-row");
        waitFor("real session opens from tree", "!document.getElementById('drawer').open&&document.querySelectorAll('.message').length>0", 60000);
        evaluate("if(window.__previousPins===null)localStorage.removeItem('rmt-project-pins:v1:mac');else localStorage.setItem('rmt-project-pins:v1:mac',window.__previousPins);document.getElementById('search').dispatchEvent(new Event('input'));document.getElementById('context').click();true");
        waitFor("sidebar tree restored", "document.getElementById('drawer').open", 10000);
        android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(new java.io.File(getInstrumentation().getTargetContext().getExternalFilesDir(null), "projects-smoke.png"))) { assertTrue(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out)); } finally { screenshot.recycle(); }
    }
    private void send(String prompt) throws Exception {
        waitFor("composer ready", "!document.getElementById('text').readOnly&&document.getElementById('interrupt').hidden", 15000);
        evaluate("document.getElementById('text').value=" + JSONObject.quote(prompt) + ";document.getElementById('text').dispatchEvent(new Event('input',{bubbles:true}));true");
        waitFor("send is enabled", "!document.getElementById('send').disabled", 10000);
        evaluate("document.getElementById('composer').requestSubmit();true");
    }
    private void tapWebElement(String selector) throws Exception {
        String raw = evaluate("JSON.stringify((()=>{const r=document.querySelector(" + JSONObject.quote(selector) + ").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:innerWidth}})())");
        JSONObject point = new JSONObject((String) new org.json.JSONTokener(raw).nextValue());
        int[] location = new int[2];
        getInstrumentation().runOnMainSync(() -> page.getLocationOnScreen(location));
        float scale = page.getWidth() / (float) point.getDouble("w");
        float x = location[0] + (float) point.getDouble("x") * scale, y = location[1] + (float) point.getDouble("y") * scale;
        long now = android.os.SystemClock.uptimeMillis();
        getInstrumentation().sendPointerSync(android.view.MotionEvent.obtain(now, now, 0, x, y, 0));
        getInstrumentation().sendPointerSync(android.view.MotionEvent.obtain(now, now + 50, 1, x, y, 0));
        getInstrumentation().waitForIdleSync();
    }
    private void waitFor(String label, String expression, long timeout) throws Exception {
        long deadline = System.currentTimeMillis() + timeout;
        do {
            if ("true".equals(evaluate("!!(" + expression + ")"))) {
                android.os.Bundle status = new android.os.Bundle();
                status.putString("stream", "\nPASS " + label + "\n");
                getInstrumentation().sendStatus(0, status);
                return;
            }
            Thread.sleep(300);
        }
        while (System.currentTimeMillis() < deadline);
        fail("Timed out waiting for " + label + "; metadata=" + evaluate(
            "JSON.stringify({path:location.pathname,status:document.getElementById('status')?.textContent,pending:document.getElementById('pending')?.textContent})"));
    }
    private String evaluate(String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>("");
        getInstrumentation().runOnMainSync(() -> page.evaluateJavascript(script, value -> { result.set(value); done.countDown(); }));
        assertTrue("JavaScript callback", done.await(10, TimeUnit.SECONDS));
        return result.get();
    }
    private View find(View view, Class<?> type, String label) {
        if (type.isInstance(view) && (label == null || ((Button)view).getText().toString().equals(label))) return view;
        if (view instanceof ViewGroup) for (int i=0;i<((ViewGroup)view).getChildCount();i++) {
            View found=find(((ViewGroup)view).getChildAt(i),type,label); if(found!=null)return found;
        }
        return null;
    }
    private WebView webView() {
        AtomicReference<WebView> found=new AtomicReference<>();
        getInstrumentation().runOnMainSync(()->found.set((WebView)find(activity.getWindow().getDecorView(),WebView.class,null)));
        return found.get();
    }
    private void clickNative(String label) throws Exception {
        AtomicReference<View> target = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> target.set(find(activity.getWindow().getDecorView(), Button.class, label)));
        if (target.get() != null) getInstrumentation().runOnMainSync(() -> target.get().performClick());
        else {
            getInstrumentation().runOnMainSync(() -> find(activity.getWindow().getDecorView(), Button.class, "⋮").performClick());
            getInstrumentation().waitForIdleSync();
            clickDialogText(label);
        }
        getInstrumentation().waitForIdleSync();
        if (label.equals("Mac") || label.equals("Windows")) {
            int expected = label.equals("Mac") ? 1 : 0;
            long deadline = System.currentTimeMillis() + 5000;
            while (getInstrumentation().getTargetContext().getSharedPreferences("hosts", 0).getInt("active", -1) != expected && System.currentTimeMillis() < deadline) Thread.sleep(50);
            getInstrumentation().runOnMainSync(() -> { });
        }
    }
    private void clickDialogText(String label) throws Exception {
        android.view.accessibility.AccessibilityNodeInfo node = awaitAccessibilityNode(label, null);
        // AlertDialog list labels may not expose ACTION_CLICK on their text node.
        android.graphics.Rect bounds = new android.graphics.Rect();
        node.getBoundsInScreen(bounds);
        assertFalse("Native control bounds", bounds.isEmpty());
        long now = android.os.SystemClock.uptimeMillis();
        getInstrumentation().sendPointerSync(android.view.MotionEvent.obtain(now, now,
            android.view.MotionEvent.ACTION_DOWN, bounds.centerX(), bounds.centerY(), 0));
        getInstrumentation().sendPointerSync(android.view.MotionEvent.obtain(now, now + 50,
            android.view.MotionEvent.ACTION_UP, bounds.centerX(), bounds.centerY(), 0));
        getInstrumentation().waitForIdleSync();
    }
    private android.view.accessibility.AccessibilityNodeInfo awaitAccessibilityNode(String label, String className) throws Exception {
        android.view.accessibility.AccessibilityNodeInfo node = null;
        long deadline = System.currentTimeMillis() + 5000;
        do {
            node = accessibilityNode(getInstrumentation().getUiAutomation().getRootInActiveWindow(), label, className);
            if (node != null) break;
            Thread.sleep(100);
        } while (System.currentTimeMillis() < deadline);
        assertNotNull("Native dialog control: " + (label == null ? className : label), node);
        return node;
    }
    private android.view.accessibility.AccessibilityNodeInfo accessibilityNode(
            android.view.accessibility.AccessibilityNodeInfo node, String label, String className) {
        if (node == null) return null;
        if ((label == null || label.contentEquals(node.getText() == null ? "" : node.getText()))
                && (className == null || className.contentEquals(node.getClassName()))) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            android.view.accessibility.AccessibilityNodeInfo found = accessibilityNode(node.getChild(i), label, className);
            if (found != null) return found;
        }
        return null;
    }
    @Override protected void tearDown() throws Exception {
        if(activity!=null)getInstrumentation().runOnMainSync(()->activity.finish());
        super.tearDown();
    }
}
