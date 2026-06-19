/**
 * Build the public origin (`scheme://host`) for an incoming request, honoring
 * the reverse-proxy forwarded headers. Behind a load balancer `url.host` is the
 * pod's internal address, so any externally-visible URL (OAuth redirect_uri,
 * Stripe return URLs, links emitted to users) must prefer `X-Forwarded-*`.
 */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const proto =
    request.headers.get("X-Forwarded-Proto") ?? url.protocol.replace(":", "");
  const host = request.headers.get("X-Forwarded-Host") ?? url.host;
  return `${proto}://${host}`;
}
