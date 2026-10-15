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

/** Explicit opt-in: exercises only the isolated session named in cloud-test.json. */
@SuppressWarnings("deprecation")
public class CloudSmokeTest extends InstrumentationTestCase {
    private Activity activity;
    private WebView page;
    private JSONObject config;

    public void testCloudHistoryNewSessionAndResume() throws Exception {
        java.io.File file = new java.io.File(getInstrumentation().getTargetContext().getFilesDir(), "cloud-test.json");
        config = new JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
        String cloud = HostAddress.cloudOrigin(config.getString("cloudUrl"));
        getInstrumentation().getTargetContext().getSharedPreferences("hosts", 0).edit().clear()
            .putBoolean("windows_default_migrated", true).commit();
        CountDownLatch cookies = new CountDownLatch(1);
        getInstrumentation().runOnMainSync(() -> CookieManager.getInstance().removeAllCookies(ignored -> cookies.countDown()));
        assertTrue(cookies.await(10, TimeUnit.SECONDS));
        Intent intent = new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        activity = getInstrumentation().startActivitySync(intent);
        clickNative("配置");
        clickDialogText("统一云端地址（推荐）");
        android.view.accessibility.AccessibilityNodeInfo input = awaitAccessibilityNode(null, "android.widget.EditText");
        android.os.Bundle text = new android.os.Bundle();
        text.putCharSequence(android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, cloud);
        assertTrue(input.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_TEXT, text));
        clickDialogText("保存并连接");
        page = webView();
        waitFor("login form", "!!document.querySelector('input[type=password]')", 30000);
        evaluate("localStorage.setItem('/devices/windows:codex-remote-user-default-run-settings',JSON.stringify({sandbox:'read-only',approvalPolicy:'on-request',model:null}));true");
        evaluate("document.querySelector('input[name=username]').value=" + JSONObject.quote(config.getString("username")) + ";"
            + "document.querySelector('input[type=password]').value=" + JSONObject.quote(config.getString("password")) + ";"
            + "document.querySelector('form').requestSubmit();true");
        waitFor("authenticated device link or application", "!!document.querySelector('a[href=\"/devices/windows/\"]') || !!document.querySelector('.session-row')", 30000);
        evaluate("document.querySelector('a[href=\"/devices/windows/\"]')?.click();true");
        waitFor("device application", "!!document.querySelector('.session-row')", 45000);
        evaluate("window.__check='pending';fetch('/devices/windows/healthz').then(r=>{window.__healthStatus=r.status;return r.json()}).then(h=>window.__check=h.codex?.mode||'no-mode').catch(e=>window.__check=e.name);true");
        waitFor("real bridge", "window.__check==='real'", 20000);
        String fixtureTitle = JSONObject.quote(config.getString("fixtureTitle"));
        // Search the real history list for the isolated fixture, never select an arbitrary user's thread.
        evaluate("document.querySelector('[aria-label=\"Open list options\"]').click();true");
        waitFor("history search", "!!document.querySelector('input[placeholder=\"Search threads...\"]')", 10000);
        evaluate("(()=>{const s=document.querySelector('input[placeholder=\"Search threads...\"]');if(s){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(s," + fixtureTitle + ");s.dispatchEvent(new Event('input',{bubbles:true}));}return true})()");
        waitFor("isolated history fixture", "Array.from(document.querySelectorAll('.session-row')).some(x=>x.textContent.includes(" + fixtureTitle + "))", 30000);
        evaluate("document.querySelector('[aria-label=\"Open list options\"]').click();true");
        evaluate("Array.from(document.querySelectorAll('.session-row')).find(x=>x.textContent.includes(" + fixtureTitle + ")).click();true");
        waitFor("existing session composer", "!!document.querySelector('textarea[placeholder=\"Ask Codex...\"]')", 20000);
        waitFor("existing history message", "document.querySelectorAll('.message-card--assistant[data-kind=assistant_message]').length>0", 30000);
        String oldPath = evaluate("location.pathname");
        if (config.has("fixtureSessionId")) assertTrue("Only the designated isolated fixture may be resumed",
            oldPath.contains(config.getString("fixtureSessionId")));
        sendPrompt("Do not use tools or change files. Reply exactly ANDROID_RESUME_OK.");
        waitFor("resumed response", "Array.from(document.querySelectorAll('.message-card--assistant[data-kind=assistant_message]')).some(x=>x.textContent.includes('ANDROID_RESUME_OK'))", 90000);
        assertEquals("Resume must keep the same session", oldPath, evaluate("location.pathname"));
        clickNative("Mac");
        WebView mac = webView();
        assertNotSame(page, mac);
        clickNative("Windows");
        assertSame("Device switch must preserve WebView", page, webView());
        assertEquals("Device switch must preserve selected session", oldPath, evaluate("location.pathname"));
        evaluate("(()=>{document.querySelector('[aria-label=\"Back to sidebar\"]')?.click();return true})()");
        waitFor("new session button", "Array.from(document.querySelectorAll('button')).some(x=>x.textContent.trim()==='+ New session'&&!x.disabled)", 10000);
        evaluate("Array.from(document.querySelectorAll('button')).find(x=>x.textContent.trim()==='+ New session').click();true");
        waitFor("new session composer", "!!document.querySelector('textarea[placeholder=\"Ask Codex...\"]') && !document.querySelector('.message-card--assistant[data-kind=assistant_message]')", 20000);
        sendPrompt("Do not use tools or change files. Reply exactly ANDROID_NEW_OK.");
        waitFor("new session response", "Array.from(document.querySelectorAll('.message-card--assistant[data-kind=assistant_message]')).some(x=>x.textContent.includes('ANDROID_NEW_OK'))", 90000);
        assertFalse("New session must have a different identity", oldPath.equals(evaluate("location.pathname")));
        // Capture only this isolated test conversation; no arbitrary history is opened.
        android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
        assertNotNull("Emulator screenshot", screenshot);
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(new java.io.File(
                getInstrumentation().getTargetContext().getExternalFilesDir(null), "cloud-smoke.png"))) {
            assertTrue(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out));
        } finally { screenshot.recycle(); }
    }

    private void sendPrompt(String prompt) throws Exception {
        evaluate("(()=>{const t=document.querySelector('textarea[placeholder=\"Ask Codex...\"]');t.value=" + JSONObject.quote(prompt) + ";t.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('button[aria-label=Send]').click();return true})()");
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
            "JSON.stringify({path:location.pathname,health:window.__check,status:window.__healthStatus,rows:document.querySelectorAll('.session-row').length,composer:!!document.querySelector('textarea')})"));
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
    private void clickNative(String label) {
        getInstrumentation().runOnMainSync(()->find(activity.getWindow().getDecorView(),Button.class,label).performClick());
        getInstrumentation().waitForIdleSync();
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
