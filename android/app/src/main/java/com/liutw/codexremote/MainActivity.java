package com.liutw.codexremote;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.ConsoleMessage;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.ScrollView;
import android.widget.Toast;
import android.graphics.Typeface;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.io.OutputStream;
import java.io.IOException;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

public class MainActivity extends Activity {
    private static final int FILE_PICKER = 41;
    private static final int LOG_EXPORT = 42;
    private static final String[] NAMES = {"Windows", "Mac"};
    private final WebView[] pages = new WebView[2];
    private SharedPreferences preferences;
    private FrameLayout content;
    private TextView status;
    private ProgressBar progress;
    private int active;
    private ValueCallback<Uri[]> fileCallback;
    private DiagnosticLog logs;
    private String diagnosticScript;

    @Override public void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        preferences = getSharedPreferences("hosts", MODE_PRIVATE);
        logs = DiagnosticLog.get(this);
        logs.record("App", "app.start", DiagnosticLog.data("version", BuildConfig.VERSION_NAME, "androidApi", android.os.Build.VERSION.SDK_INT));
        try (java.io.InputStream input = getAssets().open("diagnostics.js")) {
            java.io.ByteArrayOutputStream script = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int length;
            while ((length = input.read(buffer)) != -1) script.write(buffer, 0, length);
            diagnosticScript = script.toString(StandardCharsets.UTF_8.name());
        } catch (IOException error) { logs.record("App", "diagnostics.error", DiagnosticLog.data("error", "IOException")); }
        migrateWindowsDefault();
        active = preferences.getInt("active", 0) == 1 ? 1 : 0;
        boolean dark = (getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
            == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        int background = dark ? Color.rgb(33, 33, 33) : Color.WHITE;
        getWindow().setStatusBarColor(background);
        getWindow().setNavigationBarColor(background);
        int systemFlags = getWindow().getDecorView().getSystemUiVisibility();
        int lightFlags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        getWindow().getDecorView().setSystemUiVisibility(dark ? systemFlags & ~lightFlags : systemFlags | lightFlags);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(background);
        content = new FrameLayout(this);
        root.addView(content, new FrameLayout.LayoutParams(-1, -1));
        // Keep diagnostics out of the chat canvas. Connection errors use contextual toasts.
        status = new TextView(this);
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        root.addView(progress, new FrameLayout.LayoutParams(-1, dp(2), android.view.Gravity.TOP));
        Button menu = button("⋮", this::showMore);
        menu.setTextSize(25);
        menu.setTextColor(Color.rgb(117, 117, 117));
        menu.setContentDescription("更多选项");
        menu.setPadding(0, 0, 0, dp(3));
        android.graphics.drawable.GradientDrawable circle = new android.graphics.drawable.GradientDrawable();
        circle.setColor(Color.WHITE);
        circle.setCornerRadius(dp(22));
        menu.setBackground(new android.graphics.drawable.RippleDrawable(android.content.res.ColorStateList.valueOf(0x20757575), null, circle));
        menu.setStateListAnimator(null);
        menu.setElevation(0);
        FrameLayout.LayoutParams menuLayout = new FrameLayout.LayoutParams(dp(48), dp(48), android.view.Gravity.TOP | android.view.Gravity.END);
        menuLayout.topMargin = dp(7); menuLayout.rightMargin = dp(8);
        root.addView(menu, menuLayout);
        setContentView(root);
        switchHost(active);
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private Button button(String label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setOnClickListener(view -> action.run());
        return button;
    }
    private String endpoint(int index) {
        String cloud = preferences.getString("cloud_url", "");
        if (!cloud.isEmpty()) return cloud + "/devices/" + (index == 0 ? "windows" : "mac") + "/";
        return preferences.getString("url_" + index, index == 0 ? BuildConfig.DEFAULT_WINDOWS_URL : "");
    }

    private void migrateWindowsDefault() {
        if (preferences.getBoolean("windows_default_migrated", false)) return;
        String previous = preferences.getString("url_0", "");
        SharedPreferences.Editor update = preferences.edit().putBoolean("windows_default_migrated", true);
        if (previous.equals("http://127.0.0.1:3210") || previous.equals("http://127.0.0.1:3210/")) {
            // Version 0.1.0 used phone loopback as its default. Only remove that
            // legacy default; custom HTTPS and emulator endpoints remain intact.
            update.remove("url_0");
        }
        update.apply();
    }

    private void switchHost(int index) {
        if (pages[active] != null) pages[active].onPause();
        active = index;
        preferences.edit().putInt("active", active).apply();
        content.removeAllViews();
        String address = endpoint(active);
        logs.record(NAMES[active], "host.select", DiagnosticLog.data("url", address));
        progress.setVisibility(View.GONE);
        if (address.isEmpty() || !HostAddress.isAllowed(address)) {
            status.setText(NAMES[active] + " · 尚未配置");
            TextView empty = new TextView(this);
            empty.setText("点击右上角菜单中的「配置」，填写统一云端 HTTPS 地址。\n\nWindows 与 Mac 客户端连接云端后，可在这里切换，各自保留当前页面。");
            empty.setTextSize(18);
            empty.setPadding(dp(24), dp(40), dp(24), 0);
            content.addView(empty);
            return;
        }
        boolean fresh = pages[active] == null;
        if (fresh) pages[active] = createWebView(active);
        WebView page = pages[active];
        content.addView(page, new FrameLayout.LayoutParams(-1, -1));
        page.onResume();
        status.setText(NAMES[active] + " · " + address);
        if (fresh) page.loadUrl(address);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView createWebView(int index) {
        WebView page = new WebView(this);
        WebSettings settings = page.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setUserAgentString(settings.getUserAgentString() + " CodexRemoteAndroid/" + BuildConfig.VERSION_NAME);
        page.setBackgroundColor((getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES ? Color.rgb(33, 33, 33) : Color.WHITE);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(page, false);
        page.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                boolean allowed = HostAddress.isAllowed(request.getUrl().toString());
                logs.record(NAMES[index], allowed ? "navigation.allow" : "navigation.block", DiagnosticLog.data(
                    "url", request.getUrl().toString(), "method", request.getMethod(), "mainFrame", request.isForMainFrame()));
                if (allowed && request.isForMainFrame() && sameOrigin(request.getUrl().toString(), endpoint(index))) {
                    String target = request.getUrl().getPath();
                    if (target != null && target.matches("/devices/(windows|mac)/?")) {
                        int targetIndex = target.contains("/mac") ? 1 : 0;
                        if (targetIndex != index) { switchHost(targetIndex); return true; }
                    }
                }
                if (allowed) return false;
                if (request.isForMainFrame()) showStatus(index, "已阻止不安全或不支持的跳转");
                return true;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                logs.record(NAMES[index], "page.start", DiagnosticLog.data("url", url));
            }
            @Override public void onPageFinished(WebView view, String url) {
                CookieManager.getInstance().flush();
                logs.record(NAMES[index], "page.finish", DiagnosticLog.data("url", url));
                logCookieState(index);
                if (diagnosticScript != null && sameOrigin(url, endpoint(index))) {
                    view.evaluateJavascript(diagnosticScript, null);
                    logs.record(NAMES[index], "diagnostics.inject", DiagnosticLog.data("url", url));
                }
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                logs.record(NAMES[index], "network.error", DiagnosticLog.data("url", request.getUrl().toString(),
                    "method", request.getMethod(), "mainFrame", request.isForMainFrame(), "errorCode", error.getErrorCode()));
                if (request.isForMainFrame()) showStatus(index, "连接失败：" + error.getDescription() + "。可点击刷新重试");
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                logs.record(NAMES[index], "http.error", DiagnosticLog.data("url", request.getUrl().toString(),
                    "method", request.getMethod(), "mainFrame", request.isForMainFrame(), "status", response.getStatusCode()));
                logCookieState(index);
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                logs.record(NAMES[index], "tls.error", DiagnosticLog.data("url", error.getUrl(), "sslError", error.getPrimaryError()));
                showStatus(index, "证书验证失败，请检查服务的 HTTPS 配置");
            }
        });
        page.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage message) {
                String text = message.message() == null ? "" : message.message();
                if (text.startsWith(DiagnosticLog.CONSOLE_PREFIX) && text.length() <= 4096) {
                    try {
                        JSONObject event = new JSONObject(text.substring(DiagnosticLog.CONSOLE_PREFIX.length()));
                        logs.record(NAMES[index], event.optString("event"), event.optJSONObject("data"));
                        if (event.optString("event").equals("fetch.start") || event.optString("event").equals("ws.error")) logCookieState(index);
                    } catch (Exception error) { logs.record(NAMES[index], "console.reject", null); }
                } else if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR || message.messageLevel() == ConsoleMessage.MessageLevel.WARNING) {
                    String category = text.toLowerCase(java.util.Locale.ROOT).contains("cors") ? "cors"
                        : text.contains("Failed to fetch") || text.contains("net::") ? "network" : "javascript";
                    logs.record(NAMES[index], message.messageLevel() == ConsoleMessage.MessageLevel.ERROR ? "console.error" : "console.warn",
                        DiagnosticLog.data("source", message.sourceId(), "line", message.lineNumber(), "category", category));
                }
                // Handle console output here; raw page messages never enter our disk log.
                return true;
            }
            @Override public void onProgressChanged(WebView view, int value) {
                if (index == active) {
                    progress.setProgress(value);
                    progress.setVisibility(value < 100 ? View.VISIBLE : View.GONE);
                }
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent picker = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                picker.addCategory(Intent.CATEGORY_OPENABLE);
                picker.setType("image/*");
                picker.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(picker, FILE_PICKER); }
                catch (android.content.ActivityNotFoundException error) {
                    fileCallback.onReceiveValue(null);
                    fileCallback = null;
                    showStatus(index, "未找到系统图片选择器");
                }
                return true;
            }
        });
        return page;
    }

    private void showStatus(int index, String message) {
        if (index == active) { status.setText(NAMES[index] + " · " + message); Toast.makeText(this, message, Toast.LENGTH_LONG).show(); }
    }

    private void showMore() {
        new AlertDialog.Builder(this).setTitle("当前电脑：" + NAMES[active])
            .setItems(new String[]{"Windows", "Mac", "配置", "刷新", "连接说明", "日志", "导出日志"}, (dialog, which) -> {
                if (which < 2) switchHost(which);
                else if (which == 2) configureHost();
                else if (which == 3) refresh();
                else if (which == 4) showHelp();
                else if (which == 5) showLogs();
                else chooseLogExport();
            }).setNegativeButton("取消", null).show();
    }

    private void configureHost() {
        new AlertDialog.Builder(this).setTitle("连接配置")
            .setItems(new String[]{"统一云端地址（推荐）", "当前电脑直连地址"}, (dialog, which) -> {
                if (which == 0) configureCloud(); else configureDirectHost();
            }).setNegativeButton("取消", null).show();
    }

    private void configureCloud() {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(preferences.getString("cloud_url", ""));
        input.setHint("https://你的云端域名");
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(20), dp(12), dp(20), 0);
        form.addView(input);
        TextView hint = new TextView(this);
        hint.setText("只需配置一个云端地址。Windows 和 Mac 自动使用各自的设备入口，首次打开时登录。\n更改云端地址会重新打开两台电脑的页面。");
        form.addView(hint);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("统一云端地址")
            .setView(form).setNegativeButton("取消", null).setPositiveButton("保存并连接", null).create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            try {
                String address = HostAddress.cloudOrigin(input.getText().toString());
                if (!address.equals(preferences.getString("cloud_url", ""))) {
                    preferences.edit().putString("cloud_url", address).apply();
                    for (int i = 0; i < pages.length; i++) destroyPage(i);
                }
                dialog.dismiss();
                switchHost(active);
            } catch (IllegalArgumentException error) { input.setError(error.getMessage()); }
        }));
        dialog.show();
    }

    private void configureDirectHost() {
        final int index = active;
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        input.setText(preferences.getString("url_" + index, index == 0 ? BuildConfig.DEFAULT_WINDOWS_URL : ""));
        input.setHint("https://你的服务地址");
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(20), dp(12), dp(20), 0);
        form.addView(input);
        TextView hint = new TextView(this);
        hint.setText("填写电脑的 HTTPS 地址。保存后退出统一云端模式，两台电脑恢复使用各自的直连地址。");
        form.addView(hint);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("配置 " + NAMES[index])
            .setView(form).setNegativeButton("取消", null).setPositiveButton("保存并连接", null).create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            try {
                String address = HostAddress.normalize(input.getText().toString());
                logs.record(NAMES[index], "host.configure", DiagnosticLog.data("url", address));
                boolean wasCloud = !preferences.getString("cloud_url", "").isEmpty();
                if (wasCloud || !address.equals(endpoint(index))) {
                    preferences.edit().remove("cloud_url").putString("url_" + index, address).apply();
                    if (wasCloud) for (int i = 0; i < pages.length; i++) destroyPage(i);
                    else destroyPage(index);
                }
                dialog.dismiss();
                switchHost(index);
            } catch (IllegalArgumentException error) { input.setError(error.getMessage()); }
        }));
        dialog.show();
    }

    private void destroyPage(int index) {
        WebView page = pages[index];
        if (page == null) return;
        if (page.getParent() instanceof ViewGroup) ((ViewGroup) page.getParent()).removeView(page);
        page.stopLoading();
        page.destroy();
        pages[index] = null;
    }
    private void refresh() {
        if (pages[active] == null) configureHost();
        else {
            status.setText(NAMES[active] + " · " + endpoint(active));
            pages[active].reload();
        }
    }
    private void goBack() {
        if (pages[active] != null && pages[active].canGoBack()) pages[active].goBack();
        else new AlertDialog.Builder(this).setMessage("已在当前主机的起始页面").setPositiveButton("确定", null).show();
    }
    @SuppressWarnings("deprecation")
    @Override public void onBackPressed() {
        if (pages[active] != null && pages[active].canGoBack()) pages[active].goBack();
        else super.onBackPressed();
    }
    private void showHelp() {
        new AlertDialog.Builder(this).setTitle("连接电脑上的 Codex")
            .setMessage("在「配置 → 统一云端地址」填写云端 HTTPS 地址并登录。两台电脑分别以 windows、mac 设备标识连接同一云端。\n\n电脑需要保持开机联网。切换主机与从后台返回不会主动刷新，必要时点击「刷新」。\n\n直连方式仍可在「配置」中选择。127.0.0.1 指向手机自身，仅在电脑通过 USB 设置 adb reverse 后可用于旧版本机回归。业务服务验证无需 USB 映射。")
            .setPositiveButton("确定", null).show();
    }

    private boolean sameOrigin(String left, String right) {
        try {
            java.net.URI a = new java.net.URI(left), b = new java.net.URI(right);
            int aPort = a.getPort() < 0 ? ("https".equals(a.getScheme()) ? 443 : 80) : a.getPort();
            int bPort = b.getPort() < 0 ? ("https".equals(b.getScheme()) ? 443 : 80) : b.getPort();
            return a.getHost() != null && b.getHost() != null && a.getHost().equalsIgnoreCase(b.getHost())
                && a.getScheme().equalsIgnoreCase(b.getScheme()) && aPort == bPort;
        } catch (Exception error) { return false; }
    }

    private void logCookieState(int index) {
        boolean present = false;
        boolean cloudPresent = false;
        Long remaining = null;
        try {
            String cookies = CookieManager.getInstance().getCookie(endpoint(index));
            if (cookies != null) {
                for (String part : cookies.split(";")) {
                    String cookie = part.trim();
                    if (cookie.startsWith("__Host-rmtagt=") || cookie.startsWith("rmtagt=")) cloudPresent = true;
                    String name = "__Host-cloudflared-qt-auth-session=";
                    if (!cookie.startsWith(name)) continue;
                    present = true;
                    String payload = cookie.substring(name.length()).split("\\.", 2)[0];
                    byte[] bytes = android.util.Base64.decode(payload, android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP);
                    long expiry = new JSONObject(new String(bytes, StandardCharsets.UTF_8)).optLong("exp", 0);
                    if (expiry > 0) remaining = Math.max(-86400, Math.min(86400, expiry - System.currentTimeMillis() / 1000));
                }
            }
        } catch (Exception ignored) { }
        logs.record(NAMES[index], "cookies.state", DiagnosticLog.data("cloudCookiePresent", cloudPresent,
            "qtCookiePresent", present, "expiresInSeconds", remaining));
    }

    private void showLogs() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(16), dp(8), dp(16), 0);
        TextView note = new TextView(this);
        note.setText("最近 600 条诊断日志，自动保存在本机。仅含脱敏元数据，不含聊天正文、验证码或 Cookie 值。");
        panel.addView(note);
        TextView text = new TextView(this);
        text.setTextSize(12);
        text.setTypeface(Typeface.MONOSPACE);
        text.setTextIsSelectable(true);
        text.setText(logs.snapshot());
        ScrollView scroll = new ScrollView(this);
        scroll.addView(text);
        panel.addView(scroll, new LinearLayout.LayoutParams(-1, dp(300)));
        new AlertDialog.Builder(this).setTitle("诊断日志").setView(panel).setPositiveButton("关闭", null)
            .setNegativeButton("导出", (dialog, which) -> chooseLogExport())
            .setNeutralButton("清空", (dialog, which) -> logs.clear()).show();
        scroll.post(() -> scroll.fullScroll(View.FOCUS_DOWN));
    }

    private void chooseLogExport() {
        logs.record("App", "export.start", null);
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("text/plain");
        intent.putExtra(Intent.EXTRA_TITLE, "codex-remote-log-" + LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss")) + ".txt");
        try { startActivityForResult(intent, LOG_EXPORT); }
        catch (android.content.ActivityNotFoundException error) {
            logs.record("App", "export.error", DiagnosticLog.data("error", "ActivityNotFoundException"));
            Toast.makeText(this, "未找到系统文件保存器", Toast.LENGTH_SHORT).show();
        }
    }

    void exportLogs(Uri uri) {
        final String snapshot = logs.snapshot();
        new Thread(() -> {
            try (OutputStream output = getContentResolver().openOutputStream(uri, "wt")) {
                if (output == null) throw new IOException("No export stream");
                output.write(snapshot.getBytes(StandardCharsets.UTF_8));
                logs.record("App", "export.done", null);
                runOnUiThread(() -> Toast.makeText(getApplicationContext(), "日志已导出", Toast.LENGTH_SHORT).show());
            } catch (IOException | SecurityException error) {
                logs.record("App", "export.error", DiagnosticLog.data("error", error instanceof SecurityException ? "SecurityException" : "IOException"));
                runOnUiThread(() -> Toast.makeText(getApplicationContext(), "导出失败，请重新选择保存位置", Toast.LENGTH_LONG).show());
            }
        }, "DiagnosticExport").start();
    }

    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == LOG_EXPORT) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null && "content".equals(data.getData().getScheme())) exportLogs(data.getData());
            else logs.record("App", "export.cancel", null);
            return;
        }
        if (requestCode != FILE_PICKER || fileCallback == null) return;
        Uri[] selected = null;
        if (resultCode == RESULT_OK && data != null) {
            java.util.ArrayList<Uri> valid = new java.util.ArrayList<>();
            if (data.getClipData() != null) {
                for (int i = 0; i < Math.min(5, data.getClipData().getItemCount()); i++) {
                    Uri uri = data.getClipData().getItemAt(i).getUri();
                    if (isReadableImage(uri)) valid.add(uri);
                }
            } else if (isReadableImage(data.getData())) valid.add(data.getData());
            if (!valid.isEmpty()) selected = valid.toArray(new Uri[0]);
        }
        fileCallback.onReceiveValue(selected);
        fileCallback = null;
    }
    private boolean isReadableImage(Uri uri) {
        if (uri == null || !"content".equals(uri.getScheme())) return false;
        try {
            String type = getContentResolver().getType(uri);
            if (type == null || !type.startsWith("image/")) return false;
            try (android.os.ParcelFileDescriptor file = getContentResolver().openFileDescriptor(uri, "r")) {
                return file != null;
            }
        } catch (java.io.IOException | SecurityException error) { return false; }
    }
    @Override protected void onPause() {
        if (logs != null) { logs.record("App", "app.pause", null); logs.flushSoon(); }
        if (pages[active] != null) pages[active].onPause();
        CookieManager.getInstance().flush();
        super.onPause();
    }
    @Override protected void onResume() {
        super.onResume();
        if (logs != null) logs.record("App", "app.resume", null);
        if (pages[active] != null) pages[active].onResume();
    }
    @Override protected void onDestroy() {
        if (logs != null) { logs.record("App", "app.destroy", null); logs.flushSoon(); }
        if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
        for (int i = 0; i < pages.length; i++) destroyPage(i);
        super.onDestroy();
    }
}
