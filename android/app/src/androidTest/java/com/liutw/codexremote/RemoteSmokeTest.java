package com.liutw.codexremote;

import android.app.Activity;
import android.content.Intent;
import android.test.InstrumentationTestCase;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.Button;
import java.util.concurrent.atomic.AtomicReference;

/** Native configuration, upgrade, address policy and retained WebView checks. */
@SuppressWarnings("deprecation")
public class RemoteSmokeTest extends InstrumentationTestCase {
    private Activity activity;

    public void testFreshInstallUsesConfiguredDefault() throws Exception {
        getInstrumentation().getTargetContext().getSharedPreferences("hosts", 0).edit().clear().commit();
        launch();
        assertEquals(BuildConfig.DEFAULT_WINDOWS_URL.isEmpty(), webView() == null);
    }

    public void testUpgradeReplacesLegacyLoopbackDefault() throws Exception {
        getInstrumentation().getTargetContext().getSharedPreferences("hosts", 0).edit().clear()
            .putString("url_0", "http://127.0.0.1:3210").commit();
        launch();
        assertEquals(BuildConfig.DEFAULT_WINDOWS_URL.isEmpty(), webView() == null);
    }

    public void testUpgradePreservesCustomEndpoint() throws Exception {
        String custom = "https://custom.example.test";
        getInstrumentation().getTargetContext().getSharedPreferences("hosts", 0).edit().clear()
            .putString("url_0", custom).commit();
        launch();
        assertEquals(custom, getInstrumentation().getTargetContext().getSharedPreferences("hosts", 0)
            .getString("url_0", ""));
        assertEquals(android.net.Uri.parse(custom).getHost(), android.net.Uri.parse(originalUrl()).getHost());
    }

    private void launch() {
        Intent intent = new Intent(getInstrumentation().getTargetContext(), MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        activity = getInstrumentation().startActivitySync(intent);
    }

    private String originalUrl() throws Exception {
        WebView page = webView();
        assertNotNull(page);
        AtomicReference<String> result = new AtomicReference<>();
        long deadline = System.currentTimeMillis() + 5000;
        do {
            getInstrumentation().runOnMainSync(() -> result.set(page.getOriginalUrl()));
            if (result.get() == null) Thread.sleep(100);
        } while (result.get() == null && System.currentTimeMillis() < deadline);
        assertNotNull("WebView navigation must start", result.get());
        return result.get();
    }

    public void testCloudHostSwitchAndAddressPolicy() throws Exception {
        getInstrumentation().getTargetContext().getSharedPreferences("hosts", 0).edit().clear()
            .putBoolean("windows_default_migrated", true)
            .putString("cloud_url", "http://127.0.0.1:3220").commit();
        launch();
        WebView windows = webView();
        assertEquals("http://127.0.0.1:3220/devices/windows/", originalUrl());
        click("Mac");
        WebView mac = webView();
        assertNotSame(windows, mac);
        assertEquals("http://127.0.0.1:3220/devices/mac/", originalUrl());
        click("Windows");
        assertSame("Switching hosts must retain Windows page", windows, webView());
        click("Mac");
        assertSame("Switching hosts must retain Mac page", mac, webView());
        for (String invalid : new String[]{"", "http://example.com", "file:///sdcard/image.png", "javascript:alert(1)",
                "https://user:password@example.com", "https://example.com:99999"}) {
            assertFalse(invalid, HostAddress.isAllowed(invalid));
        }
        assertTrue(HostAddress.isAllowed("https://example.com"));
        assertTrue(HostAddress.isAllowed("http://10.0.2.2:3220"));
        assertEquals("https://example.com", HostAddress.cloudOrigin("https://example.com/"));
        for (String invalid : new String[]{"https://example.com/path", "https://example.com/?token=x", "https://example.com/#x"}) {
            try { HostAddress.cloudOrigin(invalid); fail("Cloud origin must reject paths and parameters"); }
            catch (IllegalArgumentException expected) { }
        }
    }

    private View find(View view, Class<?> type, String text) {
        if (type.isInstance(view) && (text == null || ((Button) view).getText().toString().equals(text))) return view;
        if (view instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                View found = find(group.getChildAt(i), type, text);
                if (found != null) return found;
            }
        }
        return null;
    }
    private WebView webView() throws Exception {
        AtomicReference<WebView> result = new AtomicReference<>();
        getInstrumentation().runOnMainSync(() -> result.set((WebView) find(activity.getWindow().getDecorView(), WebView.class, null)));
        return result.get();
    }
    private void click(String text) throws Exception {
        getInstrumentation().runOnMainSync(() -> {
            View button = find(activity.getWindow().getDecorView(), Button.class, text);
            assertNotNull(text, button);
            button.performClick();
        });
        getInstrumentation().waitForIdleSync();
    }
    @Override protected void tearDown() throws Exception {
        if (activity != null) getInstrumentation().runOnMainSync(() -> activity.finish());
        super.tearDown();
    }
}
