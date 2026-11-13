import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bindings, defineConfig, exports } from "cf/config";

/**
 * The Worker, in one file for every deployment.
 *
 * Two modes exist:
 *
 *   (no mode)  the public shape: workers.dev only, English summaries, the
 *              Workers AI binding.
 *   personal   the maintainer's own instance: custom domains and provider
 *              settings read from `cloudflare.personal.json`, a gitignored
 *              file that plays the role `wrangler.personal.jsonc` used to.
 *
 * `cf deploy` with no mode evaluates the public shape, so a fork that deploys
 * this repository never publishes to someone else's host. `--mode personal`
 * without that file stops before uploading instead of guessing a domain.
 *
 * This file is not in `tsconfig.json`: it is loaded by `cf` under Node, and the
 * Workers type package does not describe `node:fs`. `cf deploy --dry-run`
 * evaluates it, which is the check that matters.
 *
 * Static assets are not declared here; `wrangler.config.ts` names the source
 * directory (`public/`) for `cf`'s Wrangler-based bundler.
 */

type PersonalConfig = {
  /** Custom domains published with the Worker. */
  domains?: string[];
  /** Extra plain-text bindings; they override the defaults below by key. */
  vars?: Record<string, string>;
};

const NAME = "shelf";
const COMPATIBILITY_DATE = "2026-10-26";

/** Values a personal deploy overrides. The public shape keeps the defaults. */
function readPersonal(): PersonalConfig {
  const path = join(dirname(fileURLToPath(import.meta.url)), "cloudflare.personal.json");
  if (!existsSync(path)) {
    throw new Error(
      [
        `--mode personal needs ${path}.`,
        "Copy cloudflare.personal.example.json and fill in your domains and vars,",
        "or run `cf deploy` without a mode to publish the public shape.",
      ].join(" "),
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as PersonalConfig;
}

export default defineConfig(({ mode }) => {
  const personal = mode === "personal";
  const own = personal ? readPersonal() : {};

  const vars: Record<string, string> = { SUMMARY_LANGUAGE: "en", ...(own.vars ?? {}) };
  const env = Object.fromEntries(
    Object.entries(vars).map(([key, value]) => [key, bindings.text(value)]),
  );

  return {
    worker: {
      name: NAME,
      compatibilityDate: COMPATIBILITY_DATE,
      entrypoint: "src/worker.ts",
      // Kept on in both modes: the workers.dev host is the fallback when a
      // custom domain or its DNS record is misconfigured.
      workersDev: true,
      domains: own.domains,
      env: {
        ...env,
        BOOKMARKS: bindings.durableObject({ worker: NAME, exportName: "Bookmarks" }),
        AI: bindings.ai({}),
      },
      // One Durable Object, one instance, SQLite storage. This replaces the
      // Wrangler `migrations` block: `cf` derives the migration tag from the
      // export lifecycle, so an existing deployment keeps its storage.
      exports: {
        Bookmarks: exports.durableObject({ storage: "sqlite" }),
      },
    },
  };
});
