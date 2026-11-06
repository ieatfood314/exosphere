package com.ieatfood314.exosphere;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import java.io.ByteArrayInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Sits between the WebView and the network. The site's own pages go to the network first and
 * fall back to the Shelf, so a fresh answer always wins. Photos come from the Shelf when it has
 * them. Videos are left to the WebView unless the server is out of reach, so one that's only
 * being watched online never goes through here.
 */
final class Offline {
    private static final int CONNECT_MS = 3000, READ_MS = 10000;
    /** After a failure, don't make every page of the load wait for its own timeout. */
    private static final long RETRY_MS = 15000;
    private static final String NO_COPY = "{\"error\":\"Offline\"}";

    private final Shelf shelf;
    private volatile boolean down;
    private volatile long retryAt;

    Offline(Shelf shelf) {
        this.shelf = shelf;
    }

    /** Runs on a WebView thread, so blocking here is fine. Null lets the WebView load it itself. */
    WebResourceResponse answer(WebResourceRequest request, String server) {
        if (server == null || !"GET".equals(request.getMethod())) return null;
        Uri uri = request.getUrl();
        String url = uri.toString(), host = uri.getHost();
        if ("pbs.twimg.com".equals(host)) return saved(url);
        if ("video.twimg.com".equals(host)) return down ? video(url, request.getRequestHeaders()) : null;
        if (!url.startsWith(server + "/")) return null;
        String path = uri.getPath();
        boolean api = "/api/state".equals(path) || "/api/feed".equals(path);
        if (!api && !"/".equals(path) && (path == null || !path.startsWith("/static/"))) return null;

        if (System.currentTimeMillis() >= retryAt) {
            try {
                Syncer.Response response = Syncer.get(url, CONNECT_MS, READ_MS);
                if (response.status < 500) {
                    down = false;
                    if (response.status == 200) shelf.putPage(url, response.headers, response.body);
                    return web(response.status, response.headers, new ByteArrayInputStream(response.body));
                }
            } catch (IOException failed) {
                // Falls through to the saved copy.
            }
            down = true;
            retryAt = System.currentTimeMillis() + RETRY_MS;
        }
        WebResourceResponse copy = saved(url);
        if (copy != null || !api) return copy; // with no copy of the page itself, the connect screen takes over
        Map<String, String> headers = new HashMap<>();
        headers.put("content-type", "application/json");
        return web(503, headers, new ByteArrayInputStream(NO_COPY.getBytes(StandardCharsets.UTF_8)));
    }

    private WebResourceResponse saved(String url) {
        Shelf.Item item = shelf.get(url);
        if (item == null) return null;
        try {
            Map<String, String> headers = new HashMap<>(item.headers);
            headers.put(Shelf.SAVED, String.valueOf(item.savedAt));
            return web(200, headers, item.open(0));
        } catch (IOException unreadable) {
            return null;
        }
    }

    /** Video players ask for byte ranges and won't play from a response that ignores them. */
    private WebResourceResponse video(String url, Map<String, String> requestHeaders) {
        Shelf.Item item = shelf.get(url);
        if (item == null) return null;
        String asked = null;
        for (Map.Entry<String, String> header : requestHeaders.entrySet()) {
            if ("range".equalsIgnoreCase(header.getKey())) asked = header.getValue();
        }
        long[] range = Shelf.range(asked, item.length);
        try {
            Map<String, String> headers = new HashMap<>(item.headers);
            headers.put("accept-ranges", "bytes");
            if (range == null) {
                headers.put("content-length", String.valueOf(item.length));
                return web(200, headers, item.open(0));
            }
            long size = range[1] - range[0] + 1;
            headers.put("content-length", String.valueOf(size));
            headers.put("content-range", "bytes " + range[0] + "-" + range[1] + "/" + item.length);
            return web(206, headers, limited(item.open(range[0]), size));
        } catch (IOException unreadable) {
            return null;
        }
    }

    private static InputStream limited(InputStream stream, long size) {
        return new FilterInputStream(stream) {
            private long left = size;

            @Override public int read() throws IOException {
                if (left <= 0) return -1;
                int value = super.read();
                if (value >= 0) left--;
                return value;
            }

            @Override public int read(byte[] buffer, int offset, int length) throws IOException {
                if (left <= 0) return -1;
                int read = super.read(buffer, offset, (int) Math.min(length, left));
                if (read > 0) left -= read;
                return read;
            }
        };
    }

    private static WebResourceResponse web(int status, Map<String, String> headers, InputStream body) {
        String type = headers.get("content-type");
        String mime = type == null ? "application/octet-stream" : type.split(";")[0].trim();
        String charset = type != null && type.toLowerCase().contains("charset=utf-8") ? "utf-8" : null;
        String reason = status == 200 ? "OK" : status == 206 ? "Partial Content" : "Error"; // can't be empty
        return new WebResourceResponse(mime, charset, status, reason, headers, body);
    }
}
