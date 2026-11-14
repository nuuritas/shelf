# Security policy

## How this app is meant to be run

Shelf is a **single-user** app. It has one password, one shared
library, and no accounts. It is not a multi-tenant service, and it does not try
to be one.

There is no login rate limiting. If you expose it to the internet, use a long
`APP_PASSWORD` and consider putting Cloudflare Access in front of the Worker so
the password is not the only gate.

## Reporting a vulnerability

Open a private report through GitHub's **Security → Report a vulnerability** on
this repository rather than a public issue. Include the request that triggers the
problem and what an attacker gains. Expect a first reply within a week.

## Things that are not vulnerabilities

- No rate limit on `/login`, or a shared password model — see above.
- `POST /api/reindex` replacing the topic taxonomy; it is destructive by design.
- `SHARE_TOKEN` and the mobile apps. The published build embeds no token: it
  signs in with the account password (or a cloud session) at first launch.
  `SHARE_TOKEN` stays a server-side, add-only token for scripts, and even then it
  can save a bookmarked link and nothing else.
- Summaries quoting the post they summarize, including any links or text in it.
