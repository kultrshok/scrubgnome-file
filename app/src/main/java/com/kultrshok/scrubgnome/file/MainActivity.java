package com.kultrshok.scrubgnome.file;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Scrubgnome-File - a thin shell around the bundled web app (web/ in this repo, packaged
 * as assets). The scrubber itself is web/js/file.js, the same code the iPhone web app runs.
 *
 * Privacy: the app has NO internet permission, the WebView blocks network loads, and it
 * only ever serves its own packaged files. The JS bridge only saves to Download/Scrubgnome
 * and opens the share sheet.
 * Author: kultrshok. MIT License.
 */
public class MainActivity extends Activity {

    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final int REQ_PICK = 42;
    private static final int MAX_SHARE_IN = 64 * 1024 * 1024;   // per shared-in file

    private WebView web;
    private ValueCallback<Uri[]> pickCallback;
    private boolean pageReady;
    private final List<Uri> pendingIncoming = new ArrayList<>();

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#121417"));
        WebSettings ws = web.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setBlockNetworkLoads(true);          // belt and braces: no INTERNET permission either
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(true);         // picked files arrive as content:// URIs
        ws.setDomStorageEnabled(false);
        ws.setCacheMode(WebSettings.LOAD_NO_CACHE);
        web.addJavascriptInterface(new Bridge(), "SGAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!ORIGIN.equals(u.getScheme() + "://" + u.getHost())) return blocked();
                String path = u.getPath() == null || u.getPath().equals("/") ? "index.html" : u.getPath().substring(1);
                try {
                    return new WebResourceResponse(mime(path), "utf-8", getAssets().open(path));
                } catch (IOException e) {
                    return blocked();
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                return true;                     // never navigate anywhere else
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (pickCallback != null) pickCallback.onReceiveValue(null);
                pickCallback = cb;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                startActivityForResult(i, REQ_PICK);
                return true;
            }
        });
        setContentView(web);
        web.loadUrl(ORIGIN + "/index.html");
        collectIncoming(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        collectIncoming(intent);
        if (pageReady) deliverIncoming();
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req != REQ_PICK || pickCallback == null) return;
        Uri[] uris = null;
        if (res == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null) {
                uris = new Uri[clip.getItemCount()];
                for (int i = 0; i < uris.length; i++) uris[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                uris = new Uri[]{data.getData()};
            }
        }
        pickCallback.onReceiveValue(uris);
        pickCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    // ------------------------------------------------------------------ share-in

    @SuppressWarnings("deprecation")
    private void collectIncoming(Intent intent) {
        if (intent == null) return;
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            Uri u = android.os.Build.VERSION.SDK_INT >= 33
                    ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class)
                    : intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (u != null) pendingIncoming.add(u);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())) {
            ArrayList<Uri> l = android.os.Build.VERSION.SDK_INT >= 33
                    ? intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class)
                    : intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (l != null) pendingIncoming.addAll(l);
        }
    }

    /** Hand shared-in files to the page as [{name, b64}] (read on a worker thread). */
    private void deliverIncoming() {
        if (pendingIncoming.isEmpty()) return;
        final List<Uri> uris = new ArrayList<>(pendingIncoming);
        pendingIncoming.clear();
        new Thread(() -> {
            JSONArray arr = new JSONArray();
            ContentResolver cr = getContentResolver();
            for (Uri u : uris) {
                try (InputStream in = cr.openInputStream(u)) {
                    if (in == null) continue;
                    ByteArrayOutputStream bo = new ByteArrayOutputStream();
                    byte[] buf = new byte[1 << 16];
                    int n, total = 0;
                    while ((n = in.read(buf)) > 0) {
                        total += n;
                        if (total > MAX_SHARE_IN) throw new IOException("too big");
                        bo.write(buf, 0, n);
                    }
                    JSONObject o = new JSONObject();
                    o.put("name", displayName(u));
                    o.put("b64", Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP));
                    arr.put(o);
                } catch (Exception ignored) {
                    // unreadable or too large: the page just won't list it
                }
            }
            final String js = "window.sgReceive(" + arr + ")";
            runOnUiThread(() -> web.evaluateJavascript(js, null));
        }).start();
    }

    private String displayName(Uri u) {
        try (Cursor c = getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (Exception ignored) {
            // some providers don't answer queries
        }
        String last = u.getLastPathSegment();
        return last == null ? "file" : last;
    }

    // ------------------------------------------------------------------ bridge for the page

    private final class Bridge {
        @JavascriptInterface
        public void ready() {
            runOnUiThread(() -> {
                pageReady = true;
                deliverIncoming();
            });
        }

        /** Save a clean copy to Download/Scrubgnome. Returns its content:// URI (or "" on failure). */
        @JavascriptInterface
        public String save(String name, String mime, String b64) {
            try {
                byte[] data = Base64.decode(b64, Base64.DEFAULT);
                ContentResolver cr = getContentResolver();
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name.replaceAll("[\\\\/:*?\"<>|]", "_"));
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Scrubgnome");
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri u = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (u == null) return "";
                try (OutputStream out = cr.openOutputStream(u)) {
                    if (out == null) throw new IOException("no stream");
                    out.write(data);
                } catch (IOException e) {
                    cr.delete(u, null, null);
                    return "";
                }
                v.clear();
                v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                cr.update(u, v, null, null);
                return u.toString();
            } catch (Exception e) {
                return "";
            }
        }

        /** Open the share sheet for previously saved copies (JSON array of URI strings). */
        @JavascriptInterface
        public void share(String json) {
            runOnUiThread(() -> {
                try {
                    JSONArray a = new JSONArray(json);
                    ArrayList<Uri> uris = new ArrayList<>();
                    for (int i = 0; i < a.length(); i++) {
                        String s = a.optString(i);
                        if (s.startsWith("content://")) uris.add(Uri.parse(s));
                    }
                    if (uris.isEmpty()) return;
                    Intent s = uris.size() == 1 ? new Intent(Intent.ACTION_SEND) : new Intent(Intent.ACTION_SEND_MULTIPLE);
                    if (uris.size() == 1) s.putExtra(Intent.EXTRA_STREAM, uris.get(0));
                    else s.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
                    s.setType("*/*");
                    ClipData clip = ClipData.newRawUri("", uris.get(0));
                    for (int i = 1; i < uris.size(); i++) clip.addItem(new ClipData.Item(uris.get(i)));
                    s.setClipData(clip);
                    s.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivity(Intent.createChooser(s, "Send the clean copies to…"));
                } catch (Exception ignored) {
                    // malformed list: nothing to share
                }
            });
        }
    }

    // ------------------------------------------------------------------ helpers

    private static WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked", null,
                new java.io.ByteArrayInputStream(new byte[0]));
    }

    private static String mime(String path) {
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".webmanifest")) return "application/manifest+json";
        return "application/octet-stream";
    }
}
