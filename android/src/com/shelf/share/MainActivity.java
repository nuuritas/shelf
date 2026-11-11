package com.shelf.share;

import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
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
    private boolean night;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        Uri site = Uri.parse(Config.SITE_URL);
        siteHost = site.getHost() == null ? "" : site.getHost();
        night = (getResources().getConfiguration().uiMode
            & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        int page = Color.parseColor(night ? "#141311" : "#f4f0e8");

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(page);

        web = new WebView(this);
        web.setBackgroundColor(page);

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
                // Persist the session cookie right after login, not on the next
                // periodic flush: leaving the app quickly should not log you out.
                CookieManager.getInstance().flush();
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

        // Android 15 draws the app behind the system bars. Inset the page so
        // the site header is not buried under the status bar.
        getWindow().setStatusBarColor(page);
        getWindow().setNavigationBarColor(page);
        applyBarIcons(night);
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View view, WindowInsets insets) {
                view.setPadding(0, insets.getSystemWindowInsetTop(), 0, insets.getSystemWindowInsetBottom());
                return insets;
            }
        });

        if (state != null) {
            web.restoreState(state);
            progress.setVisibility(View.GONE);
        } else {
            web.loadUrl(Config.SITE_URL);
        }
    }

    /** Dark status/navigation icons on a light page, light icons on a dark one. */
    private void applyBarIcons(boolean darkPage) {
        int flags = getWindow().getDecorView().getSystemUiVisibility();
        int lightIcons = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            lightIcons |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        flags = darkPage ? (flags & ~lightIcons) : (flags | lightIcons);
        getWindow().getDecorView().setSystemUiVisibility(flags);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
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
