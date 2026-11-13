package com.shelf.share;

import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * First-launch onboarding: pick self-hosted or Shelf Cloud, enter the server
 * and credentials, test, and save. The layout is built in code because the app
 * deliberately has no XML resource pipeline beyond the icon and theme.
 */
public class SetupActivity extends Activity {
    /** Link carried over from a share that arrived before setup finished. */
    static final String EXTRA_PENDING_SHARE = "com.shelf.share.extra.PENDING_SHARE";
    /** Set when MainActivity opened setup and will reload on RESULT_OK. */
    static final String EXTRA_RETURN_TO_CALLER = "com.shelf.share.extra.RETURN_TO_CALLER";

    private static final int COLOR_OK = Color.parseColor("#2e7d32");
    private static final int COLOR_ERROR = Color.parseColor("#b3261e");

    private Prefs prefs;
    private boolean returnToCaller;
    private String pendingShare;
    private boolean busy;

    private RadioGroup modeGroup;
    private RadioButton selfButton;
    private RadioButton cloudButton;
    private EditText urlField;
    private TextView emailLabel;
    private EditText emailField;
    private EditText passwordField;
    private Button testButton;
    private Button saveButton;
    private TextView statusView;
    private TextView noticeView;
    private int mutedColor;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        prefs = new Prefs(this);
        returnToCaller = getIntent().getBooleanExtra(EXTRA_RETURN_TO_CALLER, false);
        pendingShare = getIntent().getStringExtra(EXTRA_PENDING_SHARE);

        boolean night = (getResources().getConfiguration().uiMode
            & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        int page = Color.parseColor(night ? "#141311" : "#f4f0e8");
        mutedColor = Color.parseColor(night ? "#a49d92" : "#6b655c");
        getWindow().setStatusBarColor(page);
        getWindow().setNavigationBarColor(page);
        applyBarIcons(night);

        setContentView(buildContent(page));
        prefill();
    }

    private View buildContent(int page) {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(page);
        scroll.setFillViewport(true);
        scroll.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View view, WindowInsets insets) {
                view.setPadding(
                    0,
                    insets.getSystemWindowInsetTop(),
                    0,
                    insets.getSystemWindowInsetBottom()
                );
                return insets;
            }
        });

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(24), dp(24), dp(24), dp(32));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // These credentials belong to the app's own encrypted store, so the
            // form opts out of autofill suggestions.
            root.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        }
        scroll.addView(
            root,
            new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        );

        TextView title = new TextView(this);
        title.setText("Shelf");
        title.setTextSize(30);
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        root.addView(title);

        TextView intro = new TextView(this);
        intro.setText(
            "Connect the app to your own Shelf server or to Shelf Cloud. "
                + "You can change this later with the settings button in the app."
        );
        intro.setTextSize(15);
        intro.setTextColor(mutedColor);
        intro.setPadding(0, dp(6), 0, dp(20));
        root.addView(intro);

        noticeView = new TextView(this);
        noticeView.setText(
            "Saving again signs out the current session and connects with the new server."
        );
        noticeView.setTextSize(13);
        noticeView.setTextColor(mutedColor);
        noticeView.setPadding(0, 0, 0, dp(12));
        noticeView.setVisibility(View.GONE);
        root.addView(noticeView);

        modeGroup = new RadioGroup(this);
        modeGroup.setOrientation(RadioGroup.VERTICAL);
        selfButton = new RadioButton(this);
        selfButton.setText("Self-hosted");
        selfButton.setId(View.generateViewId());
        cloudButton = new RadioButton(this);
        cloudButton.setText("Shelf Cloud");
        cloudButton.setId(View.generateViewId());
        modeGroup.addView(selfButton);
        modeGroup.addView(cloudButton);
        root.addView(modeGroup);

        urlField = field(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        urlField.setHint("https://your-worker.workers.dev");
        addLabelled(root, "Server URL", urlField);

        emailLabel = label("Email");
        emailLabel.setVisibility(View.GONE);
        root.addView(emailLabel);
        emailField = field(
            InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
        );
        emailField.setHint("you@example.com");
        emailField.setVisibility(View.GONE);
        root.addView(emailField);

        passwordField = field(
            InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD
        );
        passwordField.setHint("Server password");
        addLabelled(root, "Password", passwordField);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setPadding(0, dp(18), 0, 0);

        testButton = new Button(this);
        testButton.setText("Test connection");
        testButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                testConnection();
            }
        });
        actions.addView(
            testButton,
            new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        );

        saveButton = new Button(this);
        saveButton.setText("Save");
        saveButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                save();
            }
        });
        LinearLayout.LayoutParams saveParams = new LinearLayout.LayoutParams(
            0,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            1f
        );
        saveParams.leftMargin = dp(8);
        actions.addView(saveButton, saveParams);
        root.addView(actions);

        statusView = new TextView(this);
        statusView.setTextSize(15);
        statusView.setPadding(0, dp(16), 0, dp(12));
        statusView.setVisibility(View.GONE);
        root.addView(statusView);

        TextView note = new TextView(this);
        note.setText(
            "Your password is encrypted with a key in this device's Keystore "
                + "and is never written to the preferences file in plain text."
        );
        note.setTextSize(13);
        note.setTextColor(mutedColor);
        root.addView(note);

        modeGroup.setOnCheckedChangeListener(new RadioGroup.OnCheckedChangeListener() {
            @Override
            public void onCheckedChanged(RadioGroup group, int checkedId) {
                applyMode();
            }
        });
        return scroll;
    }

    private void prefill() {
        String base = prefs.getBaseUrl();
        if (!base.isEmpty()) urlField.setText(base);
        String email = prefs.getEmail();
        if (!email.isEmpty()) emailField.setText(email);
        if (prefs.hasConfig()) noticeView.setVisibility(View.VISIBLE);

        boolean cloud = prefs.isCloud() && !base.isEmpty();
        if (cloud) {
            cloudButton.setChecked(true);
        } else {
            selfButton.setChecked(true);
        }
        applyMode();

        if (pendingShare != null && !pendingShare.isEmpty()) {
            setStatus("Finish setup to save the shared link.", false);
        }
    }

    /** Cloud mode shows the email field and offers the hosted default URL. */
    private void applyMode() {
        boolean cloud = cloudButton.isChecked();
        emailLabel.setVisibility(cloud ? View.VISIBLE : View.GONE);
        emailField.setVisibility(cloud ? View.VISIBLE : View.GONE);
        passwordField.setHint(cloud ? "Shelf Cloud password" : "Server password");

        String url = urlField.getText().toString().trim();
        if (cloud) {
            if (url.isEmpty()) urlField.setText(Prefs.DEFAULT_CLOUD_URL);
        } else if (Prefs.DEFAULT_CLOUD_URL.equalsIgnoreCase(url)) {
            urlField.setText("");
        }
    }

    private void testConnection() {
        if (busy) return;
        final boolean cloud = cloudButton.isChecked();
        final String base = urlField.getText().toString().trim();
        final String email = emailField.getText().toString().trim();
        final String password = passwordField.getText().toString();

        String missing = missingField(cloud, base, email, password);
        if (missing != null) {
            setStatus(missing, true);
            return;
        }

        setBusy(true);
        setStatus("Testing connection...", false);
        new Thread(new Runnable() {
            @Override
            public void run() {
                ApiClient.TestResult result;
                try {
                    String normalized = ApiClient.normalizeBase(base);
                    if (cloud) {
                        ApiClient.LoginResult login = ApiClient.loginCloud(
                            normalized,
                            email,
                            password
                        );
                        result = new ApiClient.TestResult(
                            login.ok,
                            login.ok ? "Connected." : login.message
                        );
                    } else {
                        result = ApiClient.testSelfHosted(normalized, password);
                    }
                } catch (ApiClient.ApiException error) {
                    result = new ApiClient.TestResult(false, error.getMessage());
                }
                finishTest(result);
            }
        }).start();
    }

    private void save() {
        if (busy) return;
        final boolean cloud = cloudButton.isChecked();
        final String base = urlField.getText().toString().trim();
        final String email = emailField.getText().toString().trim();
        final String password = passwordField.getText().toString();

        String missing = missingField(cloud, base, email, password);
        if (missing != null) {
            setStatus(missing, true);
            return;
        }

        setBusy(true);
        setStatus("Connecting and saving...", false);
        new Thread(new Runnable() {
            @Override
            public void run() {
                String previousBase = prefs.getBaseUrl();
                try {
                    final String normalized = ApiClient.normalizeBase(base);

                    ApiClient.LoginResult login;
                    if (cloud) {
                        login = ApiClient.loginCloud(normalized, email, password);
                    } else {
                        ApiClient.TestResult test = ApiClient.testSelfHosted(
                            normalized,
                            password
                        );
                        if (!test.ok) {
                            failSave(test.message);
                            return;
                        }
                        login = ApiClient.loginSelfHosted(normalized, password);
                    }
                    if (!login.ok) {
                        failSave(login.message);
                        return;
                    }

                    String displayName = cloud ? displayName(login.displayName, email) : "";
                    if (cloud) {
                        // Keep the token for shares and the password for renewing
                        // it later; neither is written in plaintext.
                        prefs.save(
                            Prefs.MODE_CLOUD,
                            normalized,
                            email,
                            displayName,
                            login.token,
                            password
                        );
                    } else {
                        prefs.save(
                            Prefs.MODE_SELF,
                            normalized,
                            "",
                            "",
                            password,
                            ""
                        );
                    }
                    finishSave(previousBase, normalized, login);
                } catch (SecureStore.SecureStoreException error) {
                    failSave(error.getMessage());
                } catch (ApiClient.ApiException error) {
                    failSave(error.getMessage());
                } catch (Exception error) {
                    failSave("Could not save the settings. Try again.");
                }
            }
        }).start();
    }

    private void finishTest(final ApiClient.TestResult result) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (isFinishing()) return;
                setBusy(false);
                setStatus(result.message, !result.ok);
            }
        });
    }

    private void failSave(final String message) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (isFinishing()) return;
                setBusy(false);
                setStatus(message, true);
            }
        });
    }

    /** Applies the fresh session cookie and leaves setup. */
    private void finishSave(
        final String previousBase,
        final String base,
        final ApiClient.LoginResult login
    ) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (isFinishing()) return;
                CookieManager cookies = CookieManager.getInstance();
                cookies.setAcceptCookie(true);
                // Changing the server (or password) signs the old session out.
                if (!previousBase.isEmpty()) {
                    cookies.setCookie(
                        previousBase,
                        ApiClient.COOKIE_NAME + "=; Path=/; Max-Age=0"
                    );
                }
                cookies.setCookie(base, ApiClient.COOKIE_NAME + "=; Path=/; Max-Age=0");
                cookies.setCookie(base, ApiClient.CLOUD_COOKIE_NAME + "=; Path=/; Max-Age=0");
                cookies.setCookie(base, login.cookie);
                cookies.flush();

                if (pendingShare != null && !pendingShare.isEmpty()) {
                    setResult(RESULT_OK);
                    Intent share = new Intent(SetupActivity.this, ShareActivity.class);
                    share.putExtra(Intent.EXTRA_TEXT, pendingShare);
                    startActivity(share);
                } else if (returnToCaller) {
                    setResult(RESULT_OK);
                } else {
                    startActivity(new Intent(SetupActivity.this, MainActivity.class));
                }
                finish();
            }
        });
    }

    private String missingField(
        boolean cloud,
        String base,
        String email,
        String password
    ) {
        if (base.isEmpty()) return "Enter the server URL.";
        if (cloud && email.isEmpty()) return "Enter the email for Shelf Cloud.";
        if (password.isEmpty()) {
            return cloud ? "Enter the Shelf Cloud password." : "Enter the server password.";
        }
        return null;
    }

    private void setBusy(boolean value) {
        busy = value;
        testButton.setEnabled(!value);
        saveButton.setEnabled(!value);
        selfButton.setEnabled(!value);
        cloudButton.setEnabled(!value);
        urlField.setEnabled(!value);
        emailField.setEnabled(!value);
        passwordField.setEnabled(!value);
    }

    private void setStatus(String message, boolean error) {
        statusView.setText(message);
        statusView.setTextColor(error ? COLOR_ERROR : COLOR_OK);
        statusView.setVisibility(View.VISIBLE);
    }

    private EditText field(int inputType) {
        EditText field = new EditText(this);
        field.setInputType(inputType);
        field.setSingleLine(true);
        field.setTextSize(16);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            field.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        }
        return field;
    }

    private TextView label(String text) {
        TextView label = new TextView(this);
        label.setText(text);
        label.setTextSize(14);
        label.setTextColor(mutedColor);
        label.setPadding(0, dp(16), 0, 0);
        return label;
    }

    private void addLabelled(LinearLayout root, String text, EditText field) {
        root.addView(label(text));
        root.addView(field);
    }

    private static String displayName(String fromServer, String email) {
        if (fromServer != null && !fromServer.trim().isEmpty()) {
            return fromServer.trim();
        }
        int at = email.indexOf('@');
        return at > 0 ? email.substring(0, at) : email;
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

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
    public void onBackPressed() {
        if (busy) {
            Toast.makeText(this, "Still connecting...", Toast.LENGTH_SHORT).show();
            return;
        }
        super.onBackPressed();
    }
}
