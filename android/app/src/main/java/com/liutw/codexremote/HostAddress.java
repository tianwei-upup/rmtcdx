package com.liutw.codexremote;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** One policy shared by saved endpoints and WebView navigation. */
public final class HostAddress {
    private HostAddress() {}

    public static String normalize(String value) {
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalArgumentException("请填写服务地址");
        }
        String trimmed = value.trim();
        try {
            URI uri = new URI(trimmed);
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.ROOT);
            boolean local = host.equals("localhost") || host.equals("127.0.0.1") || host.equals("10.0.2.2");
            if (host.isEmpty() || !(scheme.equals("https") || (scheme.equals("http") && local))) {
                throw new IllegalArgumentException("远程地址必须使用 HTTPS；本机调试可用 http://127.0.0.1:3210");
            }
            if (uri.getUserInfo() != null) {
                throw new IllegalArgumentException("请勿在地址中填写账号或密码");
            }
            if (uri.getPort() > 65535 || uri.getPort() == 0) {
                throw new IllegalArgumentException("端口必须在 1–65535 之间");
            }
            return uri.toASCIIString();
        } catch (URISyntaxException error) {
            throw new IllegalArgumentException("地址格式无效", error);
        }
    }

    public static boolean isAllowed(String value) {
        try { normalize(value); return true; }
        catch (IllegalArgumentException error) { return false; }
    }

    public static String cloudOrigin(String value) {
        String address = normalize(value);
        URI uri = URI.create(address);
        if ((uri.getPath() != null && !uri.getPath().isEmpty() && !uri.getPath().equals("/"))
                || uri.getQuery() != null || uri.getFragment() != null) {
            throw new IllegalArgumentException("云端地址只填写域名和端口，不要包含路径或参数");
        }
        return address.endsWith("/") ? address.substring(0, address.length() - 1) : address;
    }
}
