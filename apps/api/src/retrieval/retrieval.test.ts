import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  canonicalUrl,
  cleanText,
  errorCode,
  fetchPage,
  isPrivateAddress,
  parseHtml,
} from "./fetchPage.ts";
import { keywordHits, rankLinks, scoreLink, slugify } from "./rank.ts";
import { parseRobots, robotsAllows, sitemapLocs } from "./crawlSite.ts";
import { parseDuckDuckGoHtml } from "./search.ts";

test("private and reserved addresses are rejected, public ones are not", () => {
  const blocked = [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // the cloud metadata endpoint, the whole point of the guard
    "0.0.0.0",
    "100.64.0.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:127.0.0.1", // IPv4-mapped, the usual bypass
  ];
  for (const ip of blocked) assert.ok(isPrivateAddress(ip), `${ip} should be blocked`);

  for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "2606:4700::1111"]) {
    assert.ok(!isPrivateAddress(ip), `${ip} should be allowed`);
  }
});

test("a URL with no scheme gets https, and the fragment is dropped", () => {
  assert.equal(canonicalUrl("acme.com"), "https://acme.com/");
  assert.equal(canonicalUrl(" http://acme.com/x#frag "), "http://acme.com/x");
});

test("fetchPage refuses a loopback address before opening a socket", async () => {
  await assert.rejects(
    () => fetchPage("http://127.0.0.1:9/nothing"),
    (e) => errorCode(e) === "PRIVATE_HOST",
  );
});

test("cleanText strips control characters and collapses whitespace", () => {
  assert.equal(cleanText("a\u0000b\t\t c\u001b[31m"), "a b c [31m");
  assert.equal(cleanText("one  \n\n\n\n two"), "one\n\ntwo", "paragraph breaks survive");
});

const HTML = `<html><head><title> Acme  Inc </title></head><body>
  <nav><a href="/careers">Careers</a><a href="mailto:x@y.z">Mail</a></nav>
  <main><a href="/blog/post-1">A blog post</a><a href="/careers">Careers again</a>
  <p>Acme builds widgets.</p></main>
  <footer><a href="https://twitter.com/acme">Twitter</a></footer>
  <script>var x = "not text";</script></body></html>`;

test("parseHtml extracts title, visible text, and deduplicated http links", () => {
  const page = parseHtml(HTML, "https://acme.com/");
  assert.equal(page.title, "Acme Inc");
  assert.ok(page.text.includes("Acme builds widgets."));
  assert.ok(!page.text.includes("not text"), "script contents are not page text");

  const hrefs = page.links.map((l) => l.href);
  assert.deepEqual(hrefs, [
    "https://acme.com/careers",
    "https://acme.com/blog/post-1",
    "https://twitter.com/acme",
  ]);
  assert.equal(page.links.find((l) => l.href.endsWith("/careers"))!.chrome, true, "nav link");
  assert.equal(page.links.find((l) => l.href.includes("blog"))!.chrome, false, "main link");
});

test("slugify and keywordHits match on word boundaries, not substrings", () => {
  assert.equal(slugify("Work With Us!"), "work-with-us");
  assert.equal(keywordHits("Work with us", "hiring"), 1);
  assert.equal(keywordHits("/handbook/hiring/process", "hiring"), 3);
  assert.equal(keywordHits("Our jobsworth policy", "hiring"), 0, "no substring matches");
  assert.equal(keywordHits("Open jobs", "hiring"), 1, "plurals still match");
});

test("ranking puts the careers link above the blog and penalises offsite", () => {
  const ranked = rankLinks(parseHtml(HTML, "https://acme.com/").links, "hiring", "acme.com");
  assert.equal(ranked[0]!.href, "https://acme.com/careers");
  assert.ok(!ranked.some((l) => l.href.includes("twitter")), "offsite scores itself out");
});

test("depth and junk penalties apply", () => {
  const link = (href: string) => ({ href, text: "Careers", chrome: false, depth: new URL(href).pathname.split("/").filter(Boolean).length });
  const shallow = scoreLink(link("https://acme.com/careers"), "hiring", "acme.com");
  const deep = scoreLink(link("https://acme.com/a/b/c/careers"), "hiring", "acme.com");
  const pdf = scoreLink(link("https://acme.com/careers.pdf"), "hiring", "acme.com");
  assert.ok(deep === shallow - 2, "depth > 2 costs 2");
  assert.ok(pdf === shallow - 5, "a pdf costs 5");
});

test("robots.txt sitemaps and wildcard disallow rules are honoured", () => {
  const robots = parseRobots(`
    Sitemap: https://acme.com/sitemap.xml
    User-agent: BadBot
    Disallow: /
    User-agent: *
    Disallow: /admin
    Disallow:
    # a comment
  `);
  assert.deepEqual(robots.sitemaps, ["https://acme.com/sitemap.xml"]);
  assert.deepEqual(robots.disallow, ["/admin"], "another agent's rules are not ours");
  assert.equal(robotsAllows(robots, "https://acme.com/careers"), true);
  assert.equal(robotsAllows(robots, "https://acme.com/admin/x"), false);
});

test("sitemap locs are extracted from both a sitemap and an index", () => {
  const xml = `<urlset><url><loc>https://acme.com/a</loc></url>
    <url><loc> https://acme.com/handbook/hiring/ </loc></url></urlset>`;
  assert.deepEqual(sitemapLocs(xml), ["https://acme.com/a", "https://acme.com/handbook/hiring/"]);
});

test("duckduckgo results are unwrapped from the redirect href", () => {
  const html = `<div><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Facme.com%2Fblog">
    Acme interview</a><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Facme.com%2Fblog">dupe</a></div>`;
  const results = parseDuckDuckGoHtml(html);
  assert.equal(results.length, 1, "duplicates collapse");
  assert.equal(results[0]!.url, "https://acme.com/blog");
  assert.equal(results[0]!.title, "Acme interview");
});

// --- the limits, against a real local server -------------------------------------------------

let server: Server;
const listen = () =>
  new Promise<string>((resolve) => {
    server = createServer((req, res) => {
      const path = req.url ?? "/";
      if (path.startsWith("/redirect")) {
        const n = Number(path.split("/")[2] ?? 0);
        res.writeHead(302, { location: `/redirect/${n + 1}` });
        return res.end();
      }
      if (path === "/pdf") {
        res.writeHead(200, { "content-type": "application/pdf" });
        return res.end("%PDF-1.4");
      }
      if (path === "/big") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end("x".repeat(3_000_000));
      }
      if (path === "/missing") {
        res.writeHead(404, { "content-type": "text/html" });
        return res.end("gone");
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(HTML);
    }).listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });

after(() => server?.close());

test("limits hold: redirect cap, content-type allowlist, 2 MB cap, and HTTP errors", async (t) => {
  const base = await listen();
  const opts = { allowPrivateHosts: true };

  await t.test("redirects are capped", async () => {
    await assert.rejects(
      () => fetchPage(`${base}/redirect/0`, opts),
      (e) => errorCode(e) === "TOO_MANY_REDIRECTS",
    );
  });

  await t.test("a PDF is skipped without reading it", async () => {
    await assert.rejects(
      () => fetchPage(`${base}/pdf`, opts),
      (e) => errorCode(e) === "SKIPPED_CONTENT_TYPE",
    );
  });

  await t.test("a 404 is an error the crawler can record", async () => {
    await assert.rejects(
      () => fetchPage(`${base}/missing`, opts),
      (e) => errorCode(e) === "HTTP_404",
    );
  });

  await t.test("an oversized body is truncated, not swallowed whole", async () => {
    const page = await fetchPage(`${base}/big`, { ...opts, maxBytes: 50_000 });
    assert.equal(page.truncated, true);
    assert.ok(page.text.length <= 50_000);
  });

  await t.test("a normal page comes back parsed", async () => {
    const page = await fetchPage(`${base}/ok`, opts);
    assert.equal(page.title, "Acme Inc");
    assert.equal(page.links.length, 3);
  });
});
