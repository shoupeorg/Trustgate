// OpenNext adapter config for Cloudflare Workers.
// The pages (/ and /v1) are prerendered at build time and never revalidate, so they are served from
// the static-assets cache instead of being rendered again on every request (a render cost more CPU
// than the Workers plan allows per request).
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

export default defineCloudflareConfig({ incrementalCache: staticAssetsIncrementalCache });
