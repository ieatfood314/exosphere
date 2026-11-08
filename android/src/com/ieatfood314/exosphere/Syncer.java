package com.ieatfood314.exosphere;

import java.io.ByteArrayOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.BooleanSupplier;

/**
 * Fills the Shelf from the list at /api/offline. Plain Java, so it can be tested off the phone.
 * Media comes straight from X's CDN, which needs no account, so the burner isn't involved.
 */
final class Syncer {
    static final long MEDIA_BUDGET = 512L * 1024 * 1024;
    static final long VIDEO_LIMIT = 25L * 1024 * 1024; // most are a few MB, and a few are over 100
    private static final int TIMEOUT_MS = 20000;
    private static final long PAGE_LIFE_SECONDS = 30L * 24 * 3600;
    /** How much of a file comes down between asks whether to stop, which on the phone means "still on Wi-Fi?". */
    private static final long CHECK_BYTES = 1L << 20;
    /** What a saved page has to keep. The security headers matter most on the document itself, and
     * the etag lets the next request ask "changed?" instead of downloading it all again. */
    private static final String[] KEPT = {"content-type", "content-security-policy", "referrer-policy", "x-content-type-options", "etag"};

    static final class Response {
        final int status;
        final Map<String, String> headers;
        final byte[] body;

        Response(int status, Map<String, String> headers, byte[] body) {
            this.status = status;
            this.headers = headers;
            this.body = body;
        }
    }

    private final Shelf shelf;
    private final String server;
    private final BooleanSupplier stopped;
    private final long budget, videoLimit;

    Syncer(Shelf shelf, String server, BooleanSupplier stopped) {
        this(shelf, server, stopped, MEDIA_BUDGET, VIDEO_LIMIT);
    }

    Syncer(Shelf shelf, String server, BooleanSupplier stopped, long budget, long videoLimit) {
        this.shelf = shelf;
        this.server = server;
        this.stopped = stopped;
        this.budget = budget;
        this.videoLimit = videoLimit;
    }

    private static Map<String, String> kept(HttpURLConnection connection) {
        Map<String, String> headers = new LinkedHashMap<>();
        for (String name : KEPT) {
            String value = connection.getHeaderField(name);
            if (value != null) headers.put(name, value);
        }
        return headers;
    }

    private static HttpURLConnection open(String url, int connectMs, int readMs) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(connectMs);
        connection.setReadTimeout(readMs);
        return connection;
    }

    static Response get(String url, int connectMs, int readMs) throws IOException {
        return get(url, connectMs, readMs, null);
    }

    /** With the etag of a saved copy, an unchanged page answers 304 with no body. */
    static Response get(String url, int connectMs, int readMs, String etag) throws IOException {
        HttpURLConnection connection = open(url, connectMs, readMs);
        if (etag != null) connection.setRequestProperty("If-None-Match", etag);
        try {
            int status = connection.getResponseCode();
            InputStream stream = status < 400 ? connection.getInputStream() : connection.getErrorStream();
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            if (stream != null) {
                try (InputStream in = stream) {
                    byte[] buffer = new byte[8192];
                    for (int read; (read = in.read(buffer)) > 0; ) body.write(buffer, 0, read);
                }
            }
            return new Response(status, kept(connection), body.toByteArray());
        } finally {
            connection.disconnect();
        }
    }

    /** Throws if the server can't be reached, so nothing already saved is lost to a bad sync. */
    void run() throws IOException {
        Response list = get(server + "/api/offline", TIMEOUT_MS, TIMEOUT_MS);
        if (list.status != 200) throw new IOException("offline list: " + list.status);
        List<String> pages = new ArrayList<>(), media = new ArrayList<>();
        for (String line : new String(list.body, StandardCharsets.UTF_8).split("\n")) {
            if (line.startsWith("/")) pages.add(line);
            else if (line.startsWith("http")) media.add(line);
        }
        if (pages.isEmpty()) throw new IOException("empty offline list");

        for (String path : pages) {
            if (stopped.getAsBoolean()) return;
            Shelf.Item had = shelf.get(server + path);
            Response page = get(server + path, TIMEOUT_MS, TIMEOUT_MS, had == null ? null : had.headers.get("etag"));
            if (page.status == 200) shelf.putPage(server + path, page.headers, page.body);
            else if (page.status == 304) shelf.keepPage(server + path);
        }
        shelf.dropPagesBefore(System.currentTimeMillis() / 1000 - PAGE_LIFE_SECONDS);

        shelf.keepMedia(media);
        long used = shelf.mediaBytes();
        for (String url : media) {
            if (stopped.getAsBoolean()) return;
            if (used >= budget) return; // the list is newest first, so what's left out is the oldest
            if (shelf.hasMedia(url)) continue;
            try {
                used += fetchMedia(url);
            } catch (IOException gone) {
                // X drops media now and then. One missing file shouldn't end the sync.
            }
        }
    }

    private long fetchMedia(String url) throws IOException {
        HttpURLConnection connection = open(url, TIMEOUT_MS, TIMEOUT_MS);
        try {
            if (connection.getResponseCode() != 200) return 0;
            long limit = isVideo(url, connection) ? videoLimit : Long.MAX_VALUE;
            if (connection.getContentLengthLong() > limit) return 0;
            try (InputStream body = watched(connection.getInputStream())) {
                return shelf.putMedia(url, kept(connection), body, limit) ? Math.max(connection.getContentLengthLong(), 0) : 0;
            }
        } finally {
            connection.disconnect();
        }
    }

    /** Gives up partway through a file once told to stop, so a big video that started on Wi-Fi
     * doesn't finish on mobile data if the connection survives the switch. */
    private InputStream watched(InputStream body) {
        return new FilterInputStream(body) {
            private long untilCheck = 0;

            @Override public int read(byte[] buffer, int offset, int length) throws IOException {
                if (untilCheck <= 0) {
                    if (stopped.getAsBoolean()) throw new IOException("stopped");
                    untilCheck = CHECK_BYTES;
                }
                int read = super.read(buffer, offset, length);
                if (read > 0) untilCheck -= read;
                return read;
            }
        };
    }

    private static boolean isVideo(String url, HttpURLConnection connection) {
        String type = connection.getContentType();
        return (type != null && type.toLowerCase(Locale.ROOT).startsWith("video/")) || url.contains("video.twimg.com");
    }
}
