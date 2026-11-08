package com.ieatfood314.exosphere;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * Saved responses on disk, for reading offline. Pages (the site and its API) and media are kept
 * apart because they age differently. Plain Java, so it can be tested off the phone.
 */
final class Shelf {
    /** Tells the site this is the saved copy, and from when. */
    static final String SAVED = "x-exosphere-saved";

    private final File pages, media;

    Shelf(File root) {
        pages = new File(root, "pages");
        media = new File(root, "media");
        pages.mkdirs();
        media.mkdirs();
    }

    static final class Item {
        final Map<String, String> headers;
        final long savedAt, offset, length;
        final File file;

        private Item(Map<String, String> headers, long savedAt, File file, long offset) {
            this.headers = headers;
            this.savedAt = savedAt;
            this.file = file;
            this.offset = offset;
            this.length = file.length() - offset;
        }

        /** The body from `start` on. */
        InputStream open(long start) throws IOException {
            FileInputStream stream = new FileInputStream(file);
            long skip = offset + start;
            while (skip > 0) {
                long skipped = stream.skip(skip);
                if (skipped <= 0) {
                    stream.close();
                    throw new IOException("short file");
                }
                skip -= skipped;
            }
            return new BufferedInputStream(stream);
        }

        byte[] body() throws IOException {
            try (InputStream stream = open(0)) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                for (int read; (read = stream.read(buffer)) > 0; ) out.write(buffer, 0, read);
                return out.toByteArray();
            }
        }
    }

    /** The same page however it was asked for: the site writes `:` as `%3A` in some cursors. */
    static String key(String url) {
        int hash = url.indexOf('#');
        String clean = (hash < 0 ? url : url.substring(0, hash)).replace("%3A", ":").replace("%3a", ":");
        int mark = clean.indexOf('?');
        if (mark < 0) return clean;
        String[] params = clean.substring(mark + 1).split("&");
        Arrays.sort(params);
        return clean.substring(0, mark) + "?" + String.join("&", params);
    }

    private static String name(String url) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(key(url).getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte b : hash) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static void writeHead(DataOutputStream out, Map<String, String> headers, long now) throws IOException {
        out.writeLong(now);
        out.writeInt(headers.size());
        for (Map.Entry<String, String> header : headers.entrySet()) {
            out.writeUTF(header.getKey());
            out.writeUTF(header.getValue());
        }
    }

    void putPage(String url, Map<String, String> headers, byte[] body) throws IOException {
        File temp = File.createTempFile("page", ".tmp", pages);
        try (DataOutputStream out = new DataOutputStream(new FileOutputStream(temp))) {
            writeHead(out, headers, System.currentTimeMillis() / 1000);
            out.write(body);
        }
        commit(temp, new File(pages, name(url)));
    }

    /** Saves at most `limit` bytes. Past that it gives up, leaving nothing behind. */
    boolean putMedia(String url, Map<String, String> headers, InputStream body, long limit) throws IOException {
        File temp = File.createTempFile("media", ".tmp", media);
        boolean fits = true;
        try (DataOutputStream out = new DataOutputStream(new FileOutputStream(temp))) {
            writeHead(out, headers, System.currentTimeMillis() / 1000);
            byte[] buffer = new byte[65536];
            long total = 0;
            for (int read; fits && (read = body.read(buffer)) > 0; ) {
                total += read;
                if (total > limit) fits = false;
                else out.write(buffer, 0, read);
            }
        } catch (IOException failure) {
            temp.delete();
            throw failure;
        }
        if (!fits) {
            temp.delete();
            return false;
        }
        commit(temp, new File(media, name(url)));
        return true;
    }

    /** A rename, so a reader sees the old copy or the new one and never half of either. */
    private static void commit(File temp, File target) throws IOException {
        if (!temp.renameTo(target)) {
            temp.delete();
            throw new IOException("can't save " + target.getName());
        }
    }

    /** A page the server says hasn't changed counts as freshly saved, so it doesn't expire. */
    void keepPage(String url) {
        new File(pages, name(url)).setLastModified(System.currentTimeMillis());
    }

    boolean hasMedia(String url) {
        return new File(media, name(url)).isFile();
    }

    /** Null if there's no copy, or the copy can't be read. */
    Item get(String url) {
        File file = new File(pages, name(url));
        if (!file.isFile()) file = new File(media, name(url));
        if (!file.isFile()) return null;
        try (DataInputStream in = new DataInputStream(new BufferedInputStream(new FileInputStream(file)))) {
            long savedAt = in.readLong();
            int count = in.readInt();
            long offset = 12;
            Map<String, String> headers = new LinkedHashMap<>();
            for (int i = 0; i < count; i++) {
                String name = in.readUTF(), value = in.readUTF();
                headers.put(name, value);
                offset += 4 + name.getBytes(StandardCharsets.UTF_8).length + value.getBytes(StandardCharsets.UTF_8).length;
            }
            return new Item(headers, savedAt, file, offset);
        } catch (IOException damaged) {
            return null;
        }
    }

    long mediaBytes() {
        long total = 0;
        File[] files = media.listFiles();
        if (files != null) for (File file : files) total += file.length();
        return total;
    }

    /** Drops media for posts that have aged out of the list. */
    void keepMedia(Iterable<String> urls) {
        Set<String> keep = new HashSet<>();
        for (String url : urls) keep.add(name(url));
        File[] files = media.listFiles();
        if (files != null) for (File file : files) if (!keep.contains(file.getName())) file.delete();
    }

    /** Pages picked up while browsing have no list to fall out of, so they just expire. */
    void dropPagesBefore(long epochSeconds) {
        File[] files = pages.listFiles();
        if (files != null) for (File file : files) if (file.lastModified() / 1000 < epochSeconds) file.delete();
    }

    /** "bytes=a-b" as {start, end}, both inclusive, or null if it isn't one this file can serve. */
    static long[] range(String header, long length) {
        if (header == null || !header.startsWith("bytes=") || header.contains(",")) return null;
        String[] parts = header.substring(6).trim().split("-", -1);
        if (parts.length != 2) return null;
        try {
            long start, end = length - 1;
            if (parts[0].isEmpty()) { // the last N bytes
                start = Math.max(0, length - Long.parseLong(parts[1]));
            } else {
                start = Long.parseLong(parts[0]);
                if (!parts[1].isEmpty()) end = Math.min(end, Long.parseLong(parts[1]));
            }
            return start <= end && start < length ? new long[] {start, end} : null;
        } catch (NumberFormatException junk) {
            return null;
        }
    }
}
