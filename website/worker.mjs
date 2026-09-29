export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.protocol === "http:" && (url.pathname === "/life" || url.pathname.startsWith("/life/"))) {
      url.protocol = "https:";
      return Response.redirect(url.toString(), 308);
    }
    if (url.pathname === "/life") {
      url.pathname = "/life/";
      return Response.redirect(url.toString(), 308);
    }
    if (!url.pathname.startsWith("/life/")) return new Response("Not found", { status: 404 });
    url.pathname = url.pathname.slice(5);
    const response = await env.ASSETS.fetch(new Request(url, request));
    const headers = new Headers(response.headers);
    const location = headers.get("Location");
    if (location) {
      const target = new URL(location, url);
      if (target.origin === url.origin && !target.pathname.startsWith("/life/")) {
        target.pathname = `/life${target.pathname}`;
        headers.set("Location", target.toString());
      }
    }
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'");
    return new Response(response.body, { status: response.status, headers });
  },
};
