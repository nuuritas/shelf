package com.shelf.share;

/**
 * Build-time values. android/build.sh replaces the two placeholders in a
 * temporary copy of this file; the tracked source never holds a real token.
 */
final class Config {
    private Config() {
    }

    static final String ENDPOINT = "__SHARE_ENDPOINT__";
    static final String TOKEN = "__SHARE_TOKEN__";

    /** The library itself: the endpoint minus its `/api/bookmarks` tail. */
    static final String SITE_URL = siteUrl();

    private static String siteUrl() {
        int cut = ENDPOINT.indexOf("/api/");
        return cut > 0 ? ENDPOINT.substring(0, cut) : ENDPOINT;
    }
}
