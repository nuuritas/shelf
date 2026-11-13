package com.shelf.share;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.MalformedURLException;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Tiny HTTP client for the two Shelf flavours. It has no dependencies beyond
 * HttpURLConnection: the app is built with javac/d8, not Gradle, and a share
 * target does not need a networking library.
 */
final class ApiClient {
    static final String COOKIE_NAME = "shelf_session";
    static final String CLOUD_COOKIE_NAME = "shelf_cloud_session";
    static final String USER_AGENT = "Shelf/2.0";

    private static final int CONNECT_TIMEOUT = 15_000;
    private static final int READ_TIMEOUT = 30_000;
    private static final Pattern ERROR_FIELD =
        Pattern.compile("\"error\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"");
    private static final Pattern JSON_FIELD =
        Pattern.compile("\"([a-z_]+)\"\\s*:\\s*\"((?:\\\\.|[^\"\\\\])*)\"");

    private ApiClient() {
    }

    static final class ApiException extends Exception {
        ApiException(String message) {
            super(message);
        }
    }

    static final class TestResult {
        final boolean ok;
        final String message;

        TestResult(boolean ok, String message) {
            this.ok = ok;
            this.message = message;
        }
    }

    static final class LoginResult {
        final boolean ok;
        final String cookie;
        final String token;
        final String displayName;
        final String message;

        private LoginResult(
            boolean ok,
            String cookie,
            String token,
            String displayName,
            String message
        ) {
            this.ok = ok;
            this.cookie = cookie == null ? "" : cookie;
            this.token = token == null ? "" : token;
            this.displayName = displayName == null ? "" : displayName;
            this.message = message == null ? "" : message;
        }

        static LoginResult ok(String cookie, String token, String displayName) {
            return new LoginResult(true, cookie, token, displayName, "Connected.");
        }

        static LoginResult fail(String message) {
            return new LoginResult(false, "", "", "", message);
        }
    }

    static final class Result {
        final int code;
        final String message;

        Result(int code, String message) {
            this.code = code;
            this.message = message == null ? "" : message;
        }
    }

    /**
     * Validates and cleans a user-entered base URL. HTTPS is required except for
     * the loopback addresses an emulator or local Worker uses. The trailing
     * slash is dropped so endpoint concatenation is predictable.
     */
    static String normalizeBase(String raw) throws ApiException {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) throw new ApiException("Enter the server URL.");
        if (!value.matches("(?i)^[a-z][a-z0-9+.-]*://.*")) {
            value = "https://" + value;
        }

        URL parsed;
        try {
            parsed = new URL(value);
        } catch (MalformedURLException error) {
            throw new ApiException("That server URL is not valid.");
        }

        String scheme = parsed.getProtocol().toLowerCase(Locale.ROOT);
        if (!scheme.equals("https") && !scheme.equals("http")) {
            throw new ApiException("Use an https:// server URL.");
        }
        String host = parsed.getHost();
        if (host == null || host.isEmpty()) {
            throw new ApiException("That server URL has no host name.");
        }
        if (scheme.equals("http") && !isLocal(host)) {
            throw new ApiException(
                "Use https:// for a server on the internet. http:// only works for localhost."
            );
        }
        if (parsed.getQuery() != null || parsed.getRef() != null) {
            throw new ApiException("Remove the query string or fragment from the server URL.");
        }
        String authority = parsed.getAuthority();
        if (authority == null || authority.isEmpty() || authority.indexOf('@') >= 0) {
            throw new ApiException("That server URL is not valid.");
        }

        String path = parsed.getPath() == null ? "" : parsed.getPath();
        while (path.endsWith("/")) {
            path = path.substring(0, path.length() - 1);
        }
        return scheme + "://" + authority + path;
    }

    private static boolean isLocal(String host) {
        return host.equalsIgnoreCase("localhost")
            || host.equals("127.0.0.1")
            || host.equals("10.0.2.2")
            || host.equals("::1")
            || host.equals("[::1]");
    }

    /**
     * Self-hosted check: the Worker must answer its public health endpoint and
     * then accept the password as a bearer token.
     */
    static TestResult testSelfHosted(String rawBase, String password) {
        String base;
        try {
            base = normalizeBase(rawBase);
        } catch (ApiException error) {
            return new TestResult(false, error.getMessage());
        }

        HttpURLConnection health = null;
        HttpURLConnection stats = null;
        try {
            health = open(base + "/healthz");
            int healthCode = health.getResponseCode();
            drain(health, healthCode);
            if (healthCode < 200 || healthCode >= 300) {
                return new TestResult(
                    false,
                    "No Shelf server answered /healthz (HTTP " + healthCode + ")."
                );
            }

            stats = open(base + "/api/stats");
            stats.setRequestProperty("Authorization", "Bearer " + password);
            int statsCode = stats.getResponseCode();
            drain(stats, statsCode);
            if (statsCode == 401 || statsCode == 403) {
                return new TestResult(false, "Password rejected.");
            }
            if (statsCode < 200 || statsCode >= 300) {
                return new TestResult(
                    false,
                    "The server rejected the connection (HTTP " + statsCode + ")."
                );
            }
            return new TestResult(true, "Connected.");
        } catch (Exception error) {
            return new TestResult(false, "Can't reach the server.");
        } finally {
            if (health != null) health.disconnect();
            if (stats != null) stats.disconnect();
        }
    }

    /**
     * Signs in to a self-hosted Worker. Redirects are not followed: the session
     * cookie is on the 303 from /login, and following it would load the library
     * HTML for no reason.
     */
    static LoginResult loginSelfHosted(String rawBase, String password) {
        String base;
        try {
            base = normalizeBase(rawBase);
        } catch (ApiException error) {
            return LoginResult.fail(error.getMessage());
        }

        HttpURLConnection connection = null;
        try {
            connection = open(base + "/login");
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty(
                "Content-Type",
                "application/x-www-form-urlencoded; charset=utf-8"
            );
            connection.setRequestProperty("Accept", "text/html,application/json");

            write(
                connection,
                "password=" + URLEncoder.encode(password, "UTF-8") + "&next=%2F"
            );

            int code = connection.getResponseCode();
            String cookie = sessionCookie(connection.getHeaderFields());
            String body = readBody(connection, code);

            if (!cookie.isEmpty()) {
                return LoginResult.ok(cookie, cookieValue(cookie), "");
            }
            if (code == 401 || code == 403) {
                return LoginResult.fail("Password rejected.");
            }
            String detail = errorFrom(body);
            if (!detail.isEmpty()) return LoginResult.fail(detail);
            return LoginResult.fail("Sign-in failed (HTTP " + code + ").");
        } catch (Exception error) {
            return LoginResult.fail("Can't reach the server.");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /**
     * Signs in to Shelf Cloud. The service returns a JSON bearer token and/or a
     * `shelf_session` cookie; whichever is present is reused for the WebView and
     * for the next bookmark POST.
     */
    static LoginResult loginCloud(String rawBase, String email, String password) {
        String base;
        try {
            base = normalizeBase(rawBase);
        } catch (ApiException error) {
            return LoginResult.fail(error.getMessage());
        }

        HttpURLConnection connection = null;
        try {
            connection = open(base + "/api/auth/login");
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Accept", "application/json");

            write(
                connection,
                "{\"email\":\"" + escapeJson(email) + "\",\"password\":\""
                    + escapeJson(password) + "\"}"
            );

            int code = connection.getResponseCode();
            String body = readBody(connection, code);
            String cookie = sessionCookie(connection.getHeaderFields());

            if (code == 401 || code == 403) {
                return LoginResult.fail("Password rejected.");
            }
            if (code < 200 || code >= 300) {
                String detail = errorFrom(body);
                return LoginResult.fail(
                    detail.isEmpty() ? "Sign-in failed (HTTP " + code + ")." : detail
                );
            }

            String token = jsonField(body, "token");
            if (token.isEmpty()) token = jsonField(body, "access_token");
            if (token.isEmpty()) token = jsonField(body, "session");
            if (token.isEmpty() && !cookie.isEmpty()) token = cookieValue(cookie);
            if (cookie.isEmpty() && !token.isEmpty()) {
                cookie = CLOUD_COOKIE_NAME + "=" + token + "; Path=/; HttpOnly; SameSite=Lax";
            }
            if (token.isEmpty()) {
                return LoginResult.fail("Sign-in response had no session token.");
            }
            String name = jsonField(body, "display_name");
            if (name.isEmpty()) name = jsonField(body, "name");
            return LoginResult.ok(cookie, token, name);
        } catch (Exception error) {
            return LoginResult.fail("Can't reach the server.");
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** True when the cookie still opens a protected endpoint. */
    static boolean sessionValid(String rawBase, String cookie) {
        if (cookie == null || cookie.isEmpty()) return false;
        String base;
        try {
            base = normalizeBase(rawBase);
        } catch (ApiException error) {
            return false;
        }

        HttpURLConnection connection = null;
        try {
            connection = open(base + "/api/stats");
            connection.setRequestProperty("Cookie", firstSegment(cookie));
            int code = connection.getResponseCode();
            drain(connection, code);
            return code == 200;
        } catch (Exception error) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /**
     * Saves one bookmark. Self-hosted Workers accept the account password as a
     * bearer token; Shelf Cloud needs the token from {@link #loginCloud}.
     */
    static Result postBookmark(String rawBase, String secret, String url)
        throws ApiException, IOException {
        String base = normalizeBase(rawBase);
        HttpURLConnection connection = null;
        try {
            connection = open(base + "/api/bookmarks");
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Authorization", "Bearer " + secret);

            write(connection, "{\"url\": \"" + escapeJson(url) + "\"}");

            int code = connection.getResponseCode();
            String body = readBody(connection, code);
            String detail = errorFrom(body);
            return new Result(code, detail.isEmpty() ? body.trim() : detail);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /**
     * X's share sheet often hands over a t.co link. Follow its redirect so the
     * saved URL is the real post, not a shortener.
     */
    static String expandShortLink(String url) {
        if (url == null || url.isEmpty() || !url.contains("t.co/")) return url;
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setInstanceFollowRedirects(true);
            connection.setConnectTimeout(10_000);
            connection.setReadTimeout(10_000);
            connection.setRequestProperty("User-Agent", USER_AGENT);
            connection.connect();
            String resolved = connection.getURL().toString();
            return resolved == null || resolved.isEmpty() ? url : resolved;
        } catch (Exception ignored) {
            return url;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT);
        connection.setReadTimeout(READ_TIMEOUT);
        connection.setRequestProperty("User-Agent", USER_AGENT);
        return connection;
    }

    private static void write(HttpURLConnection connection, String body) throws IOException {
        OutputStream output = connection.getOutputStream();
        try {
            output.write(body.getBytes(StandardCharsets.UTF_8));
        } finally {
            output.close();
        }
    }

    private static String readBody(HttpURLConnection connection, int code) {
        InputStream stream = null;
        try {
            stream = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
            return stream == null ? "" : read(stream);
        } catch (Exception error) {
            return "";
        } finally {
            if (stream != null) {
                try {
                    stream.close();
                } catch (IOException ignored) {
                    // Nothing useful to do while reading an error body.
                }
            }
        }
    }

    private static void drain(HttpURLConnection connection, int code) {
        readBody(connection, code);
    }

    private static String read(InputStream stream) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        int count;
        while ((count = stream.read(chunk)) != -1) {
            buffer.write(chunk, 0, count);
        }
        return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
    }

    static boolean hasSessionCookie(String cookie) {
        return cookie != null
            && (cookie.contains(COOKIE_NAME + "=") || cookie.contains(CLOUD_COOKIE_NAME + "="));
    }

    private static String sessionCookie(Map<String, List<String>> headers) {
        if (headers == null) return "";
        for (Map.Entry<String, List<String>> header : headers.entrySet()) {
            if (header.getKey() == null || !header.getKey().equalsIgnoreCase("Set-Cookie")) {
                continue;
            }
            List<String> values = header.getValue();
            if (values == null) continue;
            for (String value : values) {
                if (value == null) continue;
                String trimmed = value.trim();
                if (trimmed.regionMatches(true, 0, COOKIE_NAME + "=", 0, COOKIE_NAME.length() + 1)
                    || trimmed.regionMatches(true, 0, CLOUD_COOKIE_NAME + "=", 0, CLOUD_COOKIE_NAME.length() + 1)) {
                    return trimmed;
                }
            }
        }
        return "";
    }

    private static String firstSegment(String cookie) {
        if (cookie == null) return "";
        int end = cookie.indexOf(';');
        return (end < 0 ? cookie : cookie.substring(0, end)).trim();
    }

    private static String cookieValue(String cookie) {
        String pair = firstSegment(cookie);
        int equals = pair.indexOf('=');
        return equals < 0 ? "" : pair.substring(equals + 1).trim();
    }

    private static String errorFrom(String body) {
        if (body == null || body.isEmpty()) return "";
        Matcher match = ERROR_FIELD.matcher(body);
        return match.find() ? unescapeJson(match.group(1)) : "";
    }

    private static String jsonField(String body, String field) {
        if (body == null || body.isEmpty()) return "";
        Matcher match = JSON_FIELD.matcher(body);
        while (match.find()) {
            if (field.equals(match.group(1))) return unescapeJson(match.group(2));
        }
        return "";
    }

    private static String escapeJson(String value) {
        String text = value == null ? "" : value;
        StringBuilder out = new StringBuilder(text.length() + 8);
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '"':
                    out.append("\\\"");
                    break;
                case '\\':
                    out.append("\\\\");
                    break;
                case '\n':
                    out.append("\\n");
                    break;
                case '\r':
                    out.append("\\r");
                    break;
                case '\t':
                    out.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        out.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        return out.toString();
    }

    private static String unescapeJson(String value) {
        StringBuilder out = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c != '\\' || i + 1 >= value.length()) {
                out.append(c);
                continue;
            }
            char next = value.charAt(++i);
            switch (next) {
                case 'n':
                    out.append('\n');
                    break;
                case 'r':
                    out.append('\r');
                    break;
                case 't':
                    out.append('\t');
                    break;
                case 'u':
                    if (i + 4 < value.length()) {
                        try {
                            out.append((char) Integer.parseInt(value.substring(i + 1, i + 5), 16));
                            i += 4;
                        } catch (NumberFormatException error) {
                            out.append("\\u");
                        }
                    } else {
                        out.append("\\u");
                    }
                    break;
                default:
                    out.append(next);
            }
        }
        return out.toString();
    }
}
