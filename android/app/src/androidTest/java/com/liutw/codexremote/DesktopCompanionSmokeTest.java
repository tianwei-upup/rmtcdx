package com.liutw.codexremote;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Explicit opt-in fixture: only the newly created companion acceptance chat. */
@SuppressWarnings("deprecation")
public class DesktopCompanionSmokeTest extends InstrumentationTestCase {
    private WebView page;
    private JSONObject config;

    public void testTlsCertificateDiagnostic() throws Exception {
        java.io.File file = new java.io.File(getInstrumentation().getTargetContext().getFilesDir(), "companion-test.json");
        JSONObject settings = new JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
        String origin = HostAddress.cloudOrigin(settings.getString("origin"));
        JSONObject evidence = new JSONObject();
        try {
            javax.net.ssl.HttpsURLConnection connection = (javax.net.ssl.HttpsURLConnection)new java.net.URL(origin + "/healthz").openConnection();
            connection.setConnectTimeout(10000); connection.setReadTimeout(10000);
            evidence.put("javaHttpsStatus", connection.getResponseCode()); connection.disconnect();
        } catch (Exception error) {
            evidence.put("javaHttpsError", error.getClass().getSimpleName());
            org.json.JSONArray causes = new org.json.JSONArray();
            for (Throwable cause = error; cause != null; cause = cause.getCause()) causes.put(cause.toString());
            evidence.put("javaHttpsCauses", causes);
        }
        CountDownLatch observed = new CountDownLatch(1);
        AtomicReference<WebView> probe = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> {
            WebView view = new WebView(getInstrumentation().getTargetContext()); probe.set(view);
            view.setWebViewClient(new android.webkit.WebViewClient() {
                @Override public void onReceivedSslError(WebView v, android.webkit.SslErrorHandler handler, android.net.http.SslError error) {
                    handler.cancel();
                    try {
                        byte[] der = android.net.http.SslCertificate.saveState(error.getCertificate()).getByteArray("x509-certificate");
                        StringBuilder hash = new StringBuilder();
                        for (byte b : java.security.MessageDigest.getInstance("SHA-256").digest(der)) hash.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
                        evidence.put("webViewCertificateSha256", hash.toString()); evidence.put("webViewSslError", error.getPrimaryError());
                    } catch (Exception e) { }
                    observed.countDown();
                }
                @Override public void onPageFinished(WebView v, String url) { if (url.startsWith("https:")) observed.countDown(); }
            });
            view.loadUrl(origin + "/healthz");
        });
        assertTrue("TLS diagnostic callback", observed.await(15, TimeUnit.SECONDS));
        getInstrumentation().runOnMainSync(() -> probe.get().destroy());
        android.os.Bundle result = new android.os.Bundle(); result.putString("stream", "\nTLS_DIAGNOSTIC " + evidence + "\n");
        getInstrumentation().sendStatus(0, result);
    }

    public void testOriginalDesktopSessionViaEcs() throws Exception {
        java.io.File file = new java.io.File(getInstrumentation().getTargetContext().getFilesDir(), "companion-test.json");
        config = new JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
        assertEquals("mac-companion", config.getString("deviceId"));
        assertEquals("rmtcdx-companion-test", config.getString("projectId"));
        String origin = HostAddress.cloudOrigin(config.getString("origin"));
        assertTrue(origin.startsWith("https://"));
        getInstrumentation().getTargetContext().getSharedPreferences("hosts", 0).edit()
            .putString("cloud_url", origin).putInt("active", 1).commit();
        Activity activity = getInstrumentation().startActivitySync(new Intent(getInstrumentation().getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        AtomicReference<WebView> found = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> found.set(findPage(activity.getWindow().getDecorView())));
        page = found.get(); assertNotNull(page);
        getInstrumentation().runOnMainSync(() -> page.loadUrl(origin + "/devices/mac-companion/"));
        waitFor("HTTPS business page", "!!document.getElementById('login')&&!!document.getElementById('project')", 30000);
        waitFor("authentication resolved", "document.getElementById('project').options.length>0||!document.getElementById('login').hidden", 30000);
        evaluate("if(!document.getElementById('login').hidden){document.getElementById('password').value=" + JSONObject.quote(config.getString("password")) + ";document.getElementById('login').requestSubmit()}true");
        selectFixture();
        waitFor("desktop original history", "document.body.textContent.includes('ROUND2 LANTERN-4826')&&document.body.textContent.includes('ECS LANTERN-4826')", 45000);
        send("这是手机 APK 经 ECS 发来的第一轮续聊。不要使用工具或读写文件，请回忆这个原会话最初的标记，只回复：APK1 <最初的标记>。");
        waitFor("APK first reply preserves desktop context", "Array.from(document.querySelectorAll('.message.assistant')).some(x=>x.textContent.trim()==='APK1 LANTERN-4826')", 120000);
        waitFor("first turn settled", "document.getElementById('pending').hidden", 45000);
        send("继续手机第二轮。不要使用工具或读写文件，请从上下文回忆标记与上一轮回复，只回复：APK2 <最初的标记> | PREVIOUS <上一轮完整回复>。");
        waitFor("APK second reply preserves original session", "Array.from(document.querySelectorAll('.message.assistant')).some(x=>x.textContent.trim()==='APK2 LANTERN-4826 | PREVIOUS APK1 LANTERN-4826')", 120000);
        waitFor("second turn settled", "document.getElementById('pending').hidden", 45000);
        getInstrumentation().runOnMainSync(() -> page.reload());
        selectFixture();
        waitFor("reload reconstructs original desktop history", "document.body.textContent.includes('BOOTSTRAP LANTERN-4826')&&document.body.textContent.includes('APK2 LANTERN-4826 | PREVIOUS APK1 LANTERN-4826')", 45000);
        evaluate("document.getElementById('chatScroll').scrollTop=document.getElementById('chatScroll').scrollHeight;true");
        android.graphics.Bitmap screenshot = getInstrumentation().getUiAutomation().takeScreenshot();
        assertNotNull(screenshot);
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(new java.io.File(getInstrumentation().getTargetContext().getExternalFilesDir(null), "desktop-companion.png"))) {
            assertTrue(screenshot.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, out));
        } finally { screenshot.recycle(); }
    }

    private void selectFixture() throws Exception {
        String project = JSONObject.quote(config.getString("projectId"));
        String thread = JSONObject.quote(config.getString("conversationId"));
        waitFor("dedicated test project", "Array.from(document.getElementById('project')?.options||[]).some(x=>x.value===" + project + ")", 45000);
        evaluate("document.getElementById('project').value=" + project + ";document.getElementById('project').dispatchEvent(new Event('change'));true");
        waitFor("only authorized test session", "Array.from(document.querySelectorAll('.session-row')).some(x=>x.dataset.id===" + thread + ")", 45000);
        evaluate("Array.from(document.querySelectorAll('.session-row')).find(x=>x.dataset.id===" + thread + ").click();true");
        waitFor("selected original session", "document.querySelectorAll('.message.assistant').length>0", 45000);
    }
    private void send(String prompt) throws Exception {
        waitFor("composer ready", "!document.getElementById('text').readOnly&&document.getElementById('pending').hidden", 15000);
        evaluate("document.getElementById('text').value=" + JSONObject.quote(prompt) + ";document.getElementById('text').dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('composer').requestSubmit();true");
    }
    private WebView findPage(View view) {
        if (view instanceof WebView) return (WebView)view;
        if (view instanceof ViewGroup) for (int i = 0; i < ((ViewGroup)view).getChildCount(); i++) {
            WebView found = findPage(((ViewGroup)view).getChildAt(i)); if (found != null) return found;
        }
        return null;
    }
    private String evaluate(String script) throws Exception {
        CountDownLatch done = new CountDownLatch(1); AtomicReference<String> result = new AtomicReference<>("");
        getInstrumentation().runOnMainSync(() -> page.evaluateJavascript(script, value -> { result.set(value); done.countDown(); }));
        assertTrue("JavaScript callback", done.await(10, TimeUnit.SECONDS)); return result.get();
    }
    private void waitFor(String label, String expression, long timeout) throws Exception {
        long deadline = System.currentTimeMillis() + timeout;
        do {
            if ("true".equals(evaluate("!!(" + expression + ")"))) {
                android.os.Bundle result = new android.os.Bundle(); result.putString("stream", "\nPASS " + label + "\n");
                getInstrumentation().sendStatus(0, result); return;
            }
            Thread.sleep(300);
        } while (System.currentTimeMillis() < deadline);
        fail("Timed out: " + label + "; state=" + evaluate("JSON.stringify({path:location.pathname,status:document.getElementById('status')?.textContent,notice:document.getElementById('notice')?.textContent,pending:document.getElementById('pending')?.hidden})"));
    }
}
