package com.shelf.share;

import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.MenuItem;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/**
 * The app window: the configured library in a WebView. The server is chosen at
 * runtime in {@link SetupActivity}; nothing about it is compiled into the APK.
 */
public class MainActivity extends Activity {
    static final String EXTRA_OPEN_URL = "open_url";
    private static final int REQUEST_SETUP = 1;

    private Prefs prefs;
    private WebView web;
    private ProgressBar progress;
    private String baseUrl;
    private String mode;
    private String siteHost;
    private boolean night;
    private boolean recreating;
    private long pausedAt;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        prefs = new Prefs(this);
        if (!prefs.hasConfig()) {
            openSetup();
            return;
        }

        baseUrl = prefs.getBaseUrl();
        mode = prefs.getMode();
        Uri site = Uri.parse(baseUrl);
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
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openExternally(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return openExternally(Uri.parse(url));
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

        // The app theme has no action bar, so the settings entry is a small
        // overflow button floating over the page.
        TextView settingsButton = new TextView(this);
        settingsButton.setText("\u22ee");
        settingsButton.setTextSize(22);
        settingsButton.setTextColor(Color.parseColor(night ? "#f4f0e8" : "#141311"));
        settingsButton.setGravity(Gravity.CENTER);
        settingsButton.setContentDescription("Server settings");
        settingsButton.setAlpha(0.85f);
        GradientDrawable settingsBackground = new GradientDrawable();
        settingsBackground.setColor(Color.parseColor(night ? "#e62b2924" : "#e6ffffff"));
        settingsBackground.setCornerRadius(dp(20));
        settingsButton.setBackground(settingsBackground);
        settingsButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                showSettingsMenu(view);
            }
        });
        FrameLayout.LayoutParams settingsParams = new FrameLayout.LayoutParams(dp(40), dp(40));
        settingsParams.gravity = Gravity.BOTTOM | Gravity.END;
        settingsParams.setMargins(0, 0, dp(12), dp(20));
        root.addView(settingsButton, settingsParams);

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

        Notifications.prepare(this);
        Notifications.checkSoon(this);
        Notifications.requestPermission(this);

        if (state != null) {
            web.restoreState(state);
            progress.setVisibility(View.GONE);
        } else {
            signInThenLoad(getIntent());
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String path = intent.getStringExtra(EXTRA_OPEN_URL);
        if (path != null && path.startsWith("/") && baseUrl != null) {
            web.loadUrl(baseUrl + path);
        }
    }

    /** A notification can ask for one bookmark; otherwise the library. */
    private String startUrl(Intent intent) {
        String path = intent == null ? null : intent.getStringExtra(EXTRA_OPEN_URL);
        return path != null && path.startsWith("/") ? baseUrl + path : baseUrl;
    }

    /** Hands a non-shelf link to the browser and keeps the library inside. */
    private boolean openExternally(Uri target) {
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

    /**
     * Loads the library with a valid session. The Worker's cookie is obtained by
     * POSTing the saved password to /login, exactly like the web form, so the
     * user does not have to type it into the page. If that fails we still load
     * the base URL: the site's own /login page remains usable.
     */
    private void signInThenLoad(Intent intent) {
        final String base = baseUrl;
        final String target = startUrl(intent);
        final String currentMode = mode;
        final String email = prefs.getEmail();
        progress.setVisibility(View.VISIBLE);

        new Thread(new Runnable() {
            @Override
            public void run() {
                String cookie = null;
                String error = null;
                try {
                    String existing = CookieManager.getInstance().getCookie(base);
                    boolean valid = ApiClient.hasSessionCookie(existing)
                        && ApiClient.sessionValid(base, existing);

                    if (!valid) {
                        boolean cloud = Prefs.MODE_CLOUD.equals(currentMode);
                        String password = cloud ? prefs.getPassword() : prefs.getSecret();
                        if (password.isEmpty()) {
                            error = "Shelf is not set up. Open Server settings.";
                        } else {
                            ApiClient.LoginResult login = cloud
                                ? ApiClient.loginCloud(base, email, password)
                                : ApiClient.loginSelfHosted(base, password);
                            if (login.ok) {
                                cookie = login.cookie;
                                if (cloud) {
                                    // Refresh the token used by ShareActivity.
                                    try {
                                        prefs.updateSecret(login.token);
                                    } catch (SecureStore.SecureStoreException ignored) {
                                        // The web session still works; a later
                                        // settings save can repair the token.
                                    }
                                }
                            } else {
                                error = login.message;
                            }
                        }
                    }
                } catch (SecureStore.SecureStoreException failure) {
                    error = "Saved password can't be read. Open Server settings.";
                } catch (Exception failure) {
                    error = "Can't reach the server.";
                }

                final String sessionCookie = cookie;
                final String message = error;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (isFinishing()) return;
                        if (sessionCookie != null) {
                            CookieManager cookies = CookieManager.getInstance();
                            cookies.setAcceptCookie(true);
                            cookies.setCookie(base, sessionCookie);
                            cookies.flush();
                        }
                        if (message != null) {
                            Toast.makeText(MainActivity.this, message, Toast.LENGTH_LONG).show();
                        }
                        web.loadUrl(target);
                    }
                });
            }
        }).start();
    }

    private void openSetup() {
        startActivity(new Intent(this, SetupActivity.class));
        finish();
    }

    private void openSettings() {
        Intent setup = new Intent(this, SetupActivity.class);
        setup.putExtra(SetupActivity.EXTRA_RETURN_TO_CALLER, true);
        startActivityForResult(setup, REQUEST_SETUP);
    }

    private void showSettingsMenu(View anchor) {
        PopupMenu popup = new PopupMenu(this, anchor);
        popup.getMenu().add("Server settings");
        popup.setOnMenuItemClickListener(new PopupMenu.OnMenuItemClickListener() {
            @Override
            public boolean onMenuItemClick(MenuItem item) {
                openSettings();
                return true;
            }
        });
        popup.show();
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
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
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_SETUP && resultCode == RESULT_OK) {
            recreating = true;
            recreate();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        pausedAt = System.currentTimeMillis();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web == null || recreating) return;

        // The settings screen can change the server while this activity sits in
        // the back stack; pick that up without keeping stale cookies.
        Prefs current = new Prefs(this);
        if (!current.hasConfig()) {
            openSetup();
            return;
        }
        if (!current.getBaseUrl().equals(baseUrl) || !current.getMode().equals(mode)) {
            recreate();
            return;
        }

        // Coming back after a while should show what happened since, not a stale page.
        if (pausedAt > 0 && System.currentTimeMillis() - pausedAt > 60_000) {
            web.reload();
        }
        pausedAt = 0;
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
