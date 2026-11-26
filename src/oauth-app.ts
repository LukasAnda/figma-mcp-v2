// The Figma OAuth app behind "Log in with Figma". The release workflow fills this from the
// FIGMA_OAUTH_CLIENT_ID / FIGMA_OAUTH_CLIENT_SECRET repository secrets before publishing; it stays
// empty in git. Desktop OAuth clients can't keep a secret (Figma requires one even with PKCE), so
// it ships in the package like in any desktop app; tokens are still bound to each user's consent.
export const BUILT_IN_APP = { clientId: "", clientSecret: "" };
