import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../../website/worker.mjs";

test("only the product path is handled; the existing homepage is never served or changed", async () => {
  let reads = 0;
  const env = { ASSETS: { fetch: () => { reads++; return new Response("site"); } } };
  assert.equal((await worker.fetch(new Request("https://ouyangyu.tech/"), env)).status, 404);
  assert.equal((await worker.fetch(new Request("https://ouyangyu.tech/lifetime"), env)).status, 404);
  assert.equal(reads, 0);
});

test("HTTP and missing trailing slash redirect to the canonical product URL", async () => {
  const env = { ASSETS: { fetch: () => { throw Error("Should not serve an asset"); } } };
  for (const [url, target] of [
    ["http://ouyangyu.tech/life/", "https://ouyangyu.tech/life/"],
    ["https://ouyangyu.tech/life?ref=home", "https://ouyangyu.tech/life/?ref=home"],
  ]) {
    const response = await worker.fetch(new Request(url), env);
    assert.equal(response.status, 308);
    assert.equal(response.headers.get("Location"), target);
  }
});

test("asset paths retain query parameters and return protective response headers", async () => {
  const env = { ASSETS: { fetch: request => {
    assert.equal(request.url, "https://ouyangyu.tech/assets/site.js?v=1");
    return new Response("console.log('website')", { headers: { "Content-Type": "application/javascript", ETag: "test" } });
  } } };
  const response = await worker.fetch(new Request("https://ouyangyu.tech/life/assets/site.js?v=1"), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("ETag"), "test");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(response.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  assert.equal(await response.text(), "console.log('website')");
});

test("asset canonical redirects stay within the product path", async () => {
  const env = { ASSETS: { fetch: () => Response.redirect("https://ouyangyu.tech/", 307) } };
  const response = await worker.fetch(new Request("https://ouyangyu.tech/life/index.html"), env);
  assert.equal(response.headers.get("Location"), "https://ouyangyu.tech/life/");
  assert.equal(response.status, 307);
});
