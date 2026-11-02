// Secrets that are only needed for some setups, so they aren't in wrangler.jsonc's required list
// (wrangler types only declares required secrets)
interface OptionalSecrets {
  GOOGLE_CLIENT_SECRET?: string
  ZITADEL_CLIENT_SECRET?: string
}
interface Env extends OptionalSecrets {}
declare namespace Cloudflare {
  interface Env extends OptionalSecrets {}
}
