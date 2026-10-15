package com.liutw.codexremote;

import android.content.Context;
import android.os.Build;
import android.os.SystemClock;
import android.util.AtomicFile;
import org.json.JSONObject;
import java.io.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.*;
import java.util.concurrent.*;

/** Bounded local metadata log. Never stores arbitrary console text or HTTP bodies. */
final class DiagnosticLog {
    static final String CONSOLE_PREFIX = "__CODEX_DIAGNOSTIC__";
    private static final int MAX_LINES = 600;
    private static final int MAX_BYTES = 192 * 1024;
    private static DiagnosticLog instance;
    private final ArrayDeque<String> lines = new ArrayDeque<>();
    private final AtomicFile file;
    private final ScheduledExecutorService writer = Executors.newSingleThreadScheduledExecutor();
    private ScheduledFuture<?> pending;
    private int bytes;
    private boolean diskError;
    private static final Set<String> ROUTES = new HashSet<>(Arrays.asList(
        "api", "sessions", "messages", "repos", "runs", "search", "select", "read", "archive", "restore",
        "requests", "respond", "files", "preview", "uploads", "notifications", "subscriptions", "config",
        "account", "rate-limits", "codex", "models", "dev", "interrupt"));
    private static final Set<String> METHODS = new HashSet<>(Arrays.asList(
        "GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "WS"));
    private static final Set<String> EVENTS = new HashSet<>(Arrays.asList(
        "app.start", "app.pause", "app.resume", "app.destroy", "host.select", "host.configure",
        "page.start", "page.finish", "navigation.allow", "navigation.block", "http.error", "network.error",
        "tls.error", "console.warn", "console.error", "console.reject", "cookies.state", "diagnostics.ready",
        "diagnostics.inject", "diagnostics.error", "fetch.start", "fetch.end", "fetch.error", "xhr.start",
        "xhr.end", "xhr.error", "ws.connect", "ws.open", "ws.close", "ws.error", "logs.clear",
        "export.start", "export.cancel", "export.done", "export.error"));

    static synchronized DiagnosticLog get(Context context) {
        if (instance == null) instance = new DiagnosticLog(context.getApplicationContext().getFilesDir());
        return instance;
    }

    private DiagnosticLog(File directory) {
        file = new AtomicFile(new File(directory, "diagnostics.jsonl"));
        try {
            if (file.getBaseFile().length() > MAX_BYTES) return;
            try (BufferedReader input = new BufferedReader(new InputStreamReader(file.openRead(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = input.readLine()) != null) {
                    // Re-apply the metadata whitelist even when restoring private storage.
                    try {
                        JSONObject old = new JSONObject(line);
                        JSONObject restored = entry(old.optString("host"), old.optString("event"), old.optJSONObject("data"));
                        restored.put("time", old.optString("time").matches("[0-9T:+.Z-]{1,40}")
                            ? old.optString("time") : "unknown");
                        append(restored.toString());
                    } catch (Exception ignored) { }
                }
            }
        } catch (FileNotFoundException ignored) { }
        catch (IOException error) { diskError = true; }
    }

    static JSONObject data(Object... values) {
        JSONObject result = new JSONObject();
        for (int i = 0; i + 1 < values.length; i += 2) {
            try { result.put(String.valueOf(values[i]), values[i + 1]); }
            catch (Exception ignored) { }
        }
        return result;
    }

    synchronized void record(String host, String event, JSONObject metadata) {
        append(entry(host, event, metadata).toString());
        if (pending == null || pending.isDone()) pending = writer.schedule(this::persist, 500, TimeUnit.MILLISECONDS);
    }

    private JSONObject entry(String host, String event, JSONObject metadata) {
        JSONObject safe = new JSONObject();
        if (metadata != null) {
            Iterator<String> keys = metadata.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                Object value = metadata.opt(key);
                try {
                    if (key.equals("url") || key.equals("source")) safe.put(key, safeUrl(String.valueOf(value)));
                    else if (key.equals("method") && METHODS.contains(value)) safe.put(key, value);
                    else if (Arrays.asList("status", "errorCode", "sslError", "closeCode", "durationMs", "line",
                            "expiresInSeconds", "androidApi").contains(key) && value instanceof Number) {
                        double number = ((Number) value).doubleValue();
                        if (Double.isFinite(number) && number >= -100000 && number <= 1000000000) safe.put(key, (long) number);
                    } else if (Arrays.asList("redirected", "mainFrame", "clean", "qtCookiePresent").contains(key)
                            && value instanceof Boolean) safe.put(key, value);
                    else if (key.equals("category") && Arrays.asList("cors", "network", "javascript", "other").contains(value))
                        safe.put(key, value);
                    else if (key.equals("error") && Arrays.asList("TypeError", "AbortError", "Error", "IOException",
                            "FileNotFoundException", "SecurityException", "ActivityNotFoundException").contains(value))
                        safe.put(key, value);
                    else if (key.equals("version") && String.valueOf(value).matches("[0-9.]{1,40}")) safe.put(key, value);
                } catch (Exception ignored) { }
            }
        }
        return data("time", OffsetDateTime.now().toString(), "elapsedMs", SystemClock.elapsedRealtime(),
            "host", Arrays.asList("Windows", "Mac", "App").contains(host) ? host : "App",
            "event", EVENTS.contains(event) ? event : "unknown", "data", safe);
    }

    static String safeUrl(String value) {
        if (value == null || value.length() > 8192) return "[invalid-url]";
        try {
            URI uri = new URI(value);
            String scheme = uri.getScheme();
            if (!Arrays.asList("http", "https", "ws", "wss").contains(scheme) || uri.getHost() == null) return "[invalid-url]";
            String origin = scheme + "://" + uri.getHost() + (uri.getPort() == -1 ? "" : ":" + uri.getPort());
            String path = uri.getPath();
            if (path == null || path.equals("/") || path.isEmpty()) return origin + "/";
            if (path.equals("/healthz") || path.equals("/ws") || path.equals("/icon.svg")) return origin + path;
            if (path.startsWith("/api/")) {
                StringBuilder route = new StringBuilder();
                for (String segment : path.split("/")) {
                    if (!segment.isEmpty()) route.append('/').append(ROUTES.contains(segment) ? segment : ":id");
                }
                return origin + route;
            }
            if (path.startsWith("/assets/")) return origin + "/assets/:file";
            if (path.startsWith("/cdn-cgi/")) return origin + "/cdn-cgi/:path";
            return origin + "/:path";
        } catch (Exception error) { return "[invalid-url]"; }
    }

    private void append(String line) {
        lines.addLast(line);
        bytes += line.getBytes(StandardCharsets.UTF_8).length + 1;
        while (lines.size() > MAX_LINES || bytes > MAX_BYTES) {
            bytes -= lines.removeFirst().getBytes(StandardCharsets.UTF_8).length + 1;
        }
    }

    synchronized String snapshot() {
        return "Codex Remote diagnostics\nApp: " + BuildConfig.VERSION_NAME + "\nAndroid API: " + Build.VERSION.SDK_INT
            + "\nMetadata only; URL queries, fragments, credentials, bodies and thread IDs are omitted.\n"
            + "Persistence error: " + diskError + "\n\n" + String.join("\n", lines) + "\n";
    }

    synchronized void clear() {
        lines.clear(); bytes = 0;
        record("App", "logs.clear", null);
    }

    synchronized void flushSoon() {
        if (pending != null) pending.cancel(false);
        pending = writer.schedule(this::persist, 0, TimeUnit.MILLISECONDS);
    }

    private void persist() {
        String payload;
        synchronized (this) { pending = null; payload = String.join("\n", lines) + "\n"; }
        FileOutputStream output = null;
        try {
            output = file.startWrite();
            output.write(payload.getBytes(StandardCharsets.UTF_8));
            file.finishWrite(output);
            synchronized (this) { diskError = false; }
        } catch (IOException error) {
            if (output != null) file.failWrite(output);
            synchronized (this) { diskError = true; }
        }
    }
}
