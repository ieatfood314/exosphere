package com.ieatfood314.exosphere;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;

/**
 * A shell around the exosphere site. The page is always the live one from your server, so
 * site changes never need a new APK. This adds what a browser would have given it: a screen
 * for the server's address, links that open outside, fullscreen video, Back and pull to
 * refresh. The address is asked for, not built in, because the APK is public. Offline reading
 * is Offline, and keeping its copy fresh on Wi-Fi is SyncJob.
 */
public class MainActivity extends Activity {
    private static final String CONNECT = "file:///android_asset/connect.html";
    private static final String UNREACHABLE = "Can't reach it. Is Tailscale on?";
    private static final String NOT_EXOSPHERE = "That isn't exosphere";
    private static final String BAD_ADDRESS = "That isn't an address";
    private static final int LOAD_TIMEOUT_MS = 15000;
    private static final int PROBE_TIMEOUT_MS = 8000;
    private static final int PULL_DP = 120;
    /** The hold menu is a modal dialog, and Back should close it rather than leave the page. */
    private static final String CLOSE_DIALOG =
        "(() => { const open = document.querySelector('dialog[open]'); open?.close(); return !!open; })()";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final Runnable giveUp = () -> showConnect(UNREACHABLE);
    private SharedPreferences prefs;
    private WebView web;
    private Offline offline;
    private volatile String server; // read on WebView threads too
    private boolean onConnect, freshHistory, probing;
    private float pullFrom = -1;
    private final Chrome chrome = new Chrome();
    private View fullscreen;
    private WebChromeClient.CustomViewCallback fullscreenDone;

    private interface Answer { void with(String problem); }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("exosphere", MODE_PRIVATE);
        server = prefs.getString("server", null);
        offline = new Offline(new Shelf(SyncJob.shelfDir(this)));

        // The bars keep their own black strips. Drawn under the status bar, posts would run
        // through the clock, because the site has no sticky header to cover them.
        getWindow().setDecorFitsSystemWindows(false);
        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(Color.BLACK);
        frame.setOnApplyWindowInsetsListener((view, insets) -> {
            Insets edge = insets.getInsets(WindowInsets.Type.systemBars()
                | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            view.setPadding(edge.left, edge.top, edge.right, edge.bottom);
            return WindowInsets.CONSUMED;
        });

        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        frame.addView(web, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(frame);

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        web.setWebViewClient(new Client());
        web.setWebChromeClient(chrome);
        web.setOnTouchListener(this::watchPull);

        if (server == null) {
            showConnect(null);
        } else {
            SyncJob.keepHourly(this);
            openFeed();
        }
    }

    private void openFeed() {
        onConnect = false;
        freshHistory = true;
        ui.removeCallbacks(giveUp);
        ui.postDelayed(giveUp, LOAD_TIMEOUT_MS);
        web.loadUrl(server + "/");
    }

    private void showConnect(String note) {
        ui.removeCallbacks(giveUp);
        if (onConnect) {
            showNote(note);
            return;
        }
        onConnect = true;
        web.stopLoading();
        Uri.Builder url = Uri.parse(CONNECT).buildUpon();
        if (server != null) url.appendQueryParameter("address", Uri.parse(server).getAuthority());
        if (note != null) url.appendQueryParameter("note", note);
        web.loadUrl(url.build().toString());
    }

    private void showNote(String note) {
        web.evaluateJavascript("showNote(" + JSONObject.quote(note == null ? "" : note) + ")", null);
    }

    /** Takes "host", "host:port" or a full URL, and keeps just the origin. */
    private static String origin(String address) {
        if (address == null) return null;
        String text = address.trim().toLowerCase(Locale.ROOT);
        Uri uri = Uri.parse(text.contains("://") ? text : "https://" + text);
        boolean web = "https".equals(uri.getScheme()) || "http".equals(uri.getScheme());
        return web && uri.getHost() != null ? uri.getScheme() + "://" + uri.getAuthority() : null;
    }

    private void connect(String address) {
        String candidate = origin(address);
        if (candidate == null) {
            showNote(BAD_ADDRESS);
            return;
        }
        probe(candidate, problem -> {
            if (problem != null) {
                showNote(problem);
                return;
            }
            server = candidate;
            prefs.edit().putString("server", server).apply();
            SyncJob.keepHourly(this);
            SyncJob.soon(this);
            openFeed();
        });
    }

    /** Asks the API rather than loading the page, so a wrong address can't trap the app on someone else's site. */
    private void probe(String candidate, Answer answer) {
        if (probing) return;
        probing = true;
        new Thread(() -> {
            String problem = UNREACHABLE;
            try {
                HttpURLConnection connection = (HttpURLConnection) new URL(candidate + "/api/state").openConnection();
                connection.setConnectTimeout(PROBE_TIMEOUT_MS);
                connection.setReadTimeout(PROBE_TIMEOUT_MS);
                String type = connection.getContentType();
                boolean json = connection.getResponseCode() == 200 && type != null && type.startsWith("application/json");
                problem = json ? null : NOT_EXOSPHERE;
                connection.disconnect();
            } catch (IOException | RuntimeException failure) {
                // Stays UNREACHABLE.
            }
            final String result = problem;
            ui.post(() -> {
                probing = false;
                if (!isDestroyed()) answer.with(result);
            });
        }).start();
    }

    private void openOutside(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException nothing) {
            // Nothing on the phone opens it.
        }
    }

    /** A browser's pull to refresh. The bounce the WebView already draws is the feedback. */
    private boolean watchPull(View view, MotionEvent event) {
        int action = event.getActionMasked();
        if (action == MotionEvent.ACTION_DOWN) {
            pullFrom = !onConnect && web.getScrollY() == 0 ? event.getY() : -1;
        } else if (action == MotionEvent.ACTION_POINTER_DOWN || action == MotionEvent.ACTION_CANCEL) {
            pullFrom = -1;
        } else if (action == MotionEvent.ACTION_UP && pullFrom >= 0) {
            float pulled = (event.getY() - pullFrom) / getResources().getDisplayMetrics().density;
            pullFrom = -1;
            if (pulled > PULL_DP && web.getScrollY() == 0) {
                web.performHapticFeedback(HapticFeedbackConstants.CONFIRM);
                web.reload();
            }
        }
        return false;
    }

    private class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return offline.answer(request, server);
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme();
            if ("exosphere".equals(scheme)) {
                if (onConnect) connect(uri.getQueryParameter("address"));
                return true;
            }
            if ("file".equals(scheme)) return false;
            if (server != null && Uri.parse(server).getAuthority().equals(uri.getAuthority())) return false;
            if ("https".equals(scheme) || "http".equals(scheme)) openOutside(uri);
            return true;
        }

        @Override
        public void onPageCommitVisible(WebView view, String url) {
            if (!onConnect) ui.removeCallbacks(giveUp);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            if (onConnect || !freshHistory) return;
            freshHistory = false;
            web.clearHistory(); // Back mustn't return to the connect screen
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame() && !onConnect) showConnect(UNREACHABLE);
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame() && !onConnect) showConnect(UNREACHABLE);
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
            if (!onConnect) showConnect(UNREACHABLE);
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            recreate(); // otherwise losing the renderer takes the whole app with it
            return true;
        }
    }

    /** Without this, the fullscreen button on a video does nothing. */
    private class Chrome extends WebChromeClient {
        @Override
        public void onShowCustomView(View view, CustomViewCallback done) {
            fullscreen = view;
            fullscreenDone = done;
            view.setKeepScreenOn(true);
            view.setBackgroundColor(Color.BLACK);
            ((ViewGroup) getWindow().getDecorView()).addView(view,
                new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            WindowInsetsController bars = getWindow().getInsetsController();
            bars.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            bars.hide(WindowInsets.Type.systemBars());
        }

        @Override
        public void onHideCustomView() {
            if (fullscreen == null) return;
            ((ViewGroup) getWindow().getDecorView()).removeView(fullscreen);
            fullscreen = null;
            fullscreenDone.onCustomViewHidden();
            getWindow().getInsetsController().show(WindowInsets.Type.systemBars());
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        // Coming back from turning Tailscale on. Probing leaves anything half typed alone.
        if (onConnect && server != null) probe(server, problem -> {
            if (problem == null && onConnect) openFeed();
        });
    }

    @Override
    protected void onPause() {
        web.onPause(); // the site records a check when the page goes hidden
        super.onPause();
    }

    @Override
    protected void onStop() {
        // Catches what's new before you walk out of Wi-Fi range.
        if (server != null) SyncJob.soon(this);
        super.onStop();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (fullscreen != null) {
            chrome.onHideCustomView();
        } else if (onConnect) {
            moveTaskToBack(true);
        } else {
            web.evaluateJavascript(CLOSE_DIALOG, closed -> {
                if ("true".equals(closed)) return;
                if (web.canGoBack()) web.goBack();
                else moveTaskToBack(true); // keeps the page, so a quick return finds it as it was
            });
        }
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacksAndMessages(null);
        ((ViewGroup) web.getParent()).removeView(web);
        web.destroy();
        super.onDestroy();
    }
}
