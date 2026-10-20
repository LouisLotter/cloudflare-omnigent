// The single build flag for owner decision F7-staging (pre-registration section 10).
//   true:  P4 and P5 are built. The deployment's staging.jsonc must declare the Tunnel's public
//          hostname and the service token, and the token's Worker secrets must exist.
//   false: P4 and P5 are not built. staging.jsonc must have no service token and no public
//          hostname; nothing reads the token secrets.
// scripts/deploy.sh refuses a deploy whose staging.jsonc disagrees with this flag. Never change it
// between the deploys of one run: a redeploy must change only the build stamp.
export const PUBLIC_ROUTES = true;
