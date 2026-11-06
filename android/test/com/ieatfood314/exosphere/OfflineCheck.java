package com.ieatfood314.exosphere;

import com.sun.net.httpserver.HttpServer;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/** Runs the Shelf and Syncer against a real HTTP server on the JVM. See android/test.sh. */
public class OfflineCheck {
    static int failures;

    static void check(String name, boolean ok) {
        System.out.println((ok ? "ok    " : "FAIL  ") + name);
        if (!ok) failures++;
    }

    static class Site {
        final HttpServer http;
        final String base;
        final Map<String, byte[]> files = new LinkedHashMap<>();
        String list = "";
        int listStatus = 200;
        final AtomicInteger hits = new AtomicInteger();

        Site() throws IOException {
            http = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            base = "http://127.0.0.1:" + http.getAddress().getPort();
            http.createContext("/", exchange -> {
                hits.incrementAndGet();
                String path = exchange.getRequestURI().toString();
                byte[] body = path.equals("/api/offline") ? list.getBytes(StandardCharsets.UTF_8) : files.get(path);
                int status = path.equals("/api/offline") ? listStatus : body == null ? 404 : 200;
                exchange.getResponseHeaders().set("content-type", path.endsWith(".mp4") ? "video/mp4" : "text/html; charset=utf-8");
                exchange.getResponseHeaders().set("content-security-policy", "default-src 'self'");
                exchange.getResponseHeaders().set("set-cookie", "nope=1");
                if (body == null) body = new byte[0];
                exchange.sendResponseHeaders(status, body.length == 0 ? -1 : body.length);
                if (body.length > 0) exchange.getResponseBody().write(body);
                exchange.close();
            });
            http.start();
        }
    }

    static Shelf freshShelf() throws IOException {
        return new Shelf(Files.createTempDirectory("shelf").toFile());
    }

    public static void main(String[] args) throws Exception {
        keys();
        ranges();
        storage();
        syncing();
        System.out.println(failures == 0 ? "all good" : failures + " failed");
        System.exit(failures == 0 ? 0 : 1);
    }

    static void keys() {
        String site = "https://x/api/feed?before=12%3A34&only=posts", server = "https://x/api/feed?only=posts&before=12:34";
        check("cursor escapes and param order don't matter", Shelf.key(site).equals(Shelf.key(server)));
        check("creator stays part of the key", !Shelf.key("https://x/api/feed?creator=1").equals(Shelf.key("https://x/api/feed?creator=2")));
        check("a fragment isn't part of the page", Shelf.key("https://x/#/all").equals(Shelf.key("https://x/")));
    }

    static void ranges() {
        check("open-ended range", Arrays.equals(Shelf.range("bytes=0-", 10), new long[] {0, 9}));
        check("middle range", Arrays.equals(Shelf.range("bytes=2-5", 10), new long[] {2, 5}));
        check("range past the end is clipped", Arrays.equals(Shelf.range("bytes=2-500", 10), new long[] {2, 9}));
        check("last N bytes", Arrays.equals(Shelf.range("bytes=-3", 10), new long[] {7, 9}));
        check("start past the end refused", Shelf.range("bytes=10-", 10) == null);
        check("several ranges refused", Shelf.range("bytes=0-1,3-4", 10) == null);
        check("junk refused", Shelf.range("bytes=a-b", 10) == null && Shelf.range(null, 10) == null);
    }

    static void storage() throws Exception {
        Shelf shelf = freshShelf();
        Map<String, String> headers = new HashMap<>();
        headers.put("content-type", "text/html; charset=utf-8");
        headers.put("content-security-policy", "default-src 'self' — ünïcode");
        shelf.putPage("https://x/", headers, "hello".getBytes(StandardCharsets.UTF_8));
        Shelf.Item item = shelf.get("https://x/");
        check("page comes back with its body", new String(item.body(), StandardCharsets.UTF_8).equals("hello"));
        check("headers survive, non-ASCII included", headers.equals(item.headers));
        check("length excludes the header block", item.length == 5);
        check("saved time is now", Math.abs(item.savedAt - System.currentTimeMillis() / 1000) < 5);
        try (InputStream part = item.open(2)) {
            check("reading from an offset", new String(part.readAllBytes(), StandardCharsets.UTF_8).equals("llo"));
        }
        shelf.putPage("https://x/", headers, "newer".getBytes(StandardCharsets.UTF_8));
        check("a new copy replaces the old", new String(shelf.get("https://x/").body(), StandardCharsets.UTF_8).equals("newer"));
        check("a missing page is null", shelf.get("https://x/none") == null);

        File root = Files.createTempDirectory("shelf").toFile();
        Shelf damaged = new Shelf(root);
        damaged.putPage("https://x/", headers, new byte[0]);
        File[] files = new File(root, "pages").listFiles();
        Files.write(files[0].toPath(), new byte[] {1, 2});
        check("a damaged file reads as no copy", damaged.get("https://x/") == null);

        Shelf media = freshShelf();
        boolean fit = media.putMedia("https://m/a", headers, new java.io.ByteArrayInputStream(new byte[100]), 50);
        check("media over its limit is refused", !fit && !media.hasMedia("https://m/a"));
        check("and leaves no temp file behind", media.mediaBytes() == 0);
    }

    static void syncing() throws Exception {
        Site site = new Site();
        byte[] photo = new byte[3000], small = new byte[2000], big = new byte[9000];
        Arrays.fill(photo, (byte) 7);
        site.files.put("/", "<html>".getBytes(StandardCharsets.UTF_8));
        site.files.put("/api/feed", "{\"posts\":[]}".getBytes(StandardCharsets.UTF_8));
        site.files.put("/photo.jpg", photo);
        site.files.put("/small.mp4", small);
        site.files.put("/big.mp4", big);
        String b = site.base;
        site.list = "/\n/api/feed\n/missing\n" + b + "/photo.jpg\n" + b + "/gone.jpg\n" + b + "/small.mp4\n" + b + "/big.mp4";
        Shelf shelf = freshShelf();
        new Syncer(shelf, b, () -> false, 1_000_000, 5000).run();
        check("pages saved", shelf.get(b + "/") != null && shelf.get(b + "/api/feed") != null);
        check("a page that fails isn't saved", shelf.get(b + "/missing") == null);
        check("security header kept", "default-src 'self'".equals(shelf.get(b + "/").headers.get("content-security-policy")));
        check("other headers dropped", !shelf.get(b + "/").headers.containsKey("set-cookie"));
        check("photo saved intact", Arrays.equals(shelf.get(b + "/photo.jpg").body(), photo));
        check("a missing photo doesn't end the sync", shelf.hasMedia(b + "/small.mp4"));
        check("a video over the limit is skipped", !shelf.hasMedia(b + "/big.mp4"));
        check("saved media keeps its type", "video/mp4".equals(shelf.get(b + "/small.mp4").headers.get("content-type")));

        int before = site.hits.get();
        new Syncer(shelf, b, () -> false, 1_000_000, 5000).run();
        site.files.remove("/photo.jpg");
        check("saved media isn't fetched again", site.hits.get() - before == 1 + 3 + 2);

        site.list = "/\n" + b + "/small.mp4";
        new Syncer(shelf, b, () -> false, 1_000_000, 5000).run();
        check("media that left the list is dropped", !shelf.hasMedia(b + "/photo.jpg") && shelf.hasMedia(b + "/small.mp4"));

        site.listStatus = 502;
        boolean threw = false;
        try { new Syncer(shelf, b, () -> false).run(); } catch (IOException expected) { threw = true; }
        check("a bad list fails the sync", threw);
        check("and everything saved stays", shelf.get(b + "/") != null && shelf.hasMedia(b + "/small.mp4"));

        site.listStatus = 200;
        site.list = "";
        threw = false;
        try { new Syncer(shelf, b, () -> false).run(); } catch (IOException expected) { threw = true; }
        check("an empty list can't wipe the shelf", threw && shelf.hasMedia(b + "/small.mp4"));

        site.files.put("/photo.jpg", photo);
        site.list = "/\n" + b + "/photo.jpg\n" + b + "/small.mp4";
        Shelf tight = freshShelf();
        new Syncer(tight, b, () -> false, 2500, 5000).run();
        check("full up, the newest stays and the rest waits", tight.hasMedia(b + "/photo.jpg") && !tight.hasMedia(b + "/small.mp4"));

        Shelf stopped = freshShelf();
        site.list = "/\n/api/feed\n" + b + "/photo.jpg";
        new Syncer(stopped, b, () -> true).run();
        check("a stopped sync stops", stopped.get(b + "/") == null);

        site.http.stop(0);
        boolean down = false;
        try { new Syncer(shelf, b, () -> false).run(); } catch (IOException expected) { down = true; }
        check("no server is an error, not a crash", down);
        check("offline, what's saved is still there", shelf.get(b + "/") != null);
    }
}
