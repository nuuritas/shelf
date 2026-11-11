package com.shelf.share;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;

/**
 * The app window: the library in a WebView. Tapping the launcher icon lands
 * here, so the app opens as an app instead of bouncing to a browser. Links to
 * other sites are handed to the browser; the shelf itself stays in the app.
 */
public class MainActivity extends Activity {
    private WebView web;
    private ProgressBar progress;
    private String siteHost;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        Uri site = Uri.parse(Config.SITE_URL);
        siteHost = site.getHost() == null ? "" : site.getHost();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#f4f0e8"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#f4f0e8"));

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        CookieManager.getInstance().setAcceptCookie(true);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                Uri target = Uri.parse(url);
                String host = target.getHost() == null ? "" : target.getHost();
                if (host.equals(siteHost)) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, target));
                } catch (Exception ignored) {
                    // No browser installed: keep the link in the app.
                    return false;
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
            }
        });

        root.addView(
            web,
            new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        );

        progress = new ProgressBar(this);
        FrameLayout.LayoutParams spinner = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT
        );
        spinner.gravity = Gravity.CENTER;
        root.addView(progress, spinner);

        setContentView(root);

        if (state != null) {
            web.restoreState(state);
            progress.setVisibility(View.GONE);
        } else {
            web.loadUrl(Config.SITE_URL);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
