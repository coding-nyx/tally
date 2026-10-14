/**
 * Server-only preview OAuth configuration. Provide the credential through
 * GROK_PREVIEW_CLIENT_SECRET in the protected server environment. Per-app
 * GROK_AUTH_* credentials take precedence in server.ts.
 * Never commit shared credentials; coordinate rotation with the broker owner.
 */
export const PREVIEW_CLIENT_ID = "grok_preview";
export const PREVIEW_CLIENT_SECRET = process.env.GROK_PREVIEW_CLIENT_SECRET?.trim() || "";

/** The shared auth broker issuer (OIDC discovery lives under it). */
export const GROK_ISSUER_DEFAULT = "https://auth.grok.me";

/**
 * Host patterns whose callbacks the preview client accepts. Better Auth derives
 * the live preview's real origin from the request host and validates it against
 * this list (wildcard-matched), so the OAuth `redirect_uri` becomes the concrete
 * `https://<preview-host>/api/auth/oauth2/callback/...` the broker allows.
 */
export const PREVIEW_ALLOWED_HOSTS = ["*.grok-sandbox.com"] as const;
