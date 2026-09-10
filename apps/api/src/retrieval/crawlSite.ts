/**
 * Stage 3. Company URL in, the about page and the hiring page out.
 *
 * Budget (plan §3), whichever hits first: 12 fetches, 45s wall clock, 3 concurrent with 250ms
 * minimum spacing. Everything that was tried is written to crawl_log, so a bad ranking is
 * diagnosable after the fact rather than a mystery.
 */
import { canonicalUrl, errorCode, fetchPage, type Link, type Page } from "./fetchPage.ts";
import { rankLinks, type RankedLink } from "./rank.ts";

export type Robots = { fetched: boolean; sitemaps: string[]; disallow: string[] };

export type CrawlEntry = {
  url: string;
  outcome: "ok" | "error" | "skipped";
  score?: number;
  note?: string;
};

export type CrawlResult = {
  root: Page | null;
  about: Page | null;
  hiring: Page | null;
  pages_used: string[];
  crawl_log: CrawlEntry[];
  robots: Robots;
  warnings: string[];
};

export type CrawlOptions = {
  allowPrivateHosts?: boolean;
  maxFetches?: number;
  wallClockMs?: number;
  timeoutMs?: number;
};

/** Only the two directives we act on: Sitemap, and Disallow for a user-agent group matching us. */
export function parseRobots(txt: string): Robots {
  const sitemaps: string[] = [];
  const disallow: string[] = [];
  let applies = false;

  for (const line of txt.split(/\r?\n/)) {
    const [rawKey = "", ...rest] = line.split("#")[0]!.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (!value && key !== "disallow") continue;

    if (key === "sitemap") sitemaps.push(value);
    else if (key === "user-agent") applies = value === "*" || /prepkitbot/i.test(value);
    else if (key === "disallow" && applies && value) disallow.push(value);
  }
  return { fetched: true, sitemaps, disallow };
}

export const robotsAllows = (robots: Robots, url: string) => {
  const path = new URL(url).pathname;
  return !robots.disallow.some((rule) => path.startsWith(rule));
};

/** <loc> entries out of a sitemap or a sitemap index. Regex, because a real XML parser is a dep. */
export const sitemapLocs = (xml: string) =>
  [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]!);

const isIndex = (xml: string) => /<sitemapindex/i.test(xml);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function crawlSite(rawUrl: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
  const {
    allowPrivateHosts = false,
    maxFetches = 12,
    wallClockMs = 45_000,
    timeoutMs = 8_000,
  } = opts;

  const deadline = Date.now() + wallClockMs;
  const crawl_log: CrawlEntry[] = [];
  const warnings: string[] = [];
  const pages_used: string[] = [];
  let robots: Robots = { fetched: false, sitemaps: [], disallow: [] };
  let fetches = 0;
  let nextStart = 0;

  /** The only way anything gets fetched, so the budget cannot be bypassed by a new call site. */
  async function get(url: string, score?: number): Promise<Page | null> {
    if (fetches >= maxFetches || Date.now() > deadline) {
      crawl_log.push({ url, outcome: "skipped", score, note: "budget exhausted" });
      if (!warnings.includes("CRAWL_BUDGET_EXHAUSTED")) warnings.push("CRAWL_BUDGET_EXHAUSTED");
      return null;
    }
    if (robots.fetched && !robotsAllows(robots, url)) {
      crawl_log.push({ url, outcome: "skipped", score, note: "robots.txt disallows" });
      return null;
    }

    const wait = nextStart - Date.now();
    if (wait > 0) await sleep(wait);
    nextStart = Date.now() + 250;
    fetches++;

    try {
      const page = await fetchPage(url, {
        allowPrivateHosts,
        timeoutMs,
        maxRedirects: 3,
        maxBytes: 2_000_000,
      });
      crawl_log.push({ url, outcome: "ok", score, note: `${page.text.length} chars` });
      if (!pages_used.includes(page.url)) pages_used.push(page.url);
      // Edge case 16: a redirect off-domain means both hosts were involved.
      if (new URL(page.url).host !== new URL(url).host && !pages_used.includes(url)) {
        pages_used.push(url);
      }
      return page;
    } catch (e) {
      const code = errorCode(e);
      crawl_log.push({ url, outcome: "error", score, note: code });
      if (code === "SKIPPED_CONTENT_TYPE") warnings.push(`SKIPPED_CONTENT_TYPE:${url}`);
      return null;
    }
  }

  /** 3 at a time, and `get` already enforces the 250ms spacing between starts. */
  async function pooled(items: RankedLink[], limit = 3): Promise<(Page | null)[]> {
    const out: (Page | null)[] = new Array(items.length).fill(null);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
          const i = cursor++;
          out[i] = await get(items[i]!.href, items[i]!.score);
        }
      }),
    );
    return out;
  }

  const start = canonicalUrl(rawUrl);
  let root = await get(start);
  // Edge case 15: a bare `acme.com` became https; some small sites are http only.
  if (!root && start.startsWith("https://")) root = await get(start.replace("https://", "http://"));
  if (!root) {
    warnings.push("COMPANY_UNREACHABLE");
    return { root: null, about: null, hiring: null, pages_used, crawl_log, robots, warnings };
  }

  const origin = new URL(root.url).origin;
  const host = new URL(root.url).host;

  const robotsPage = await get(new URL("/robots.txt", origin).toString());
  if (robotsPage) robots = parseRobots(robotsPage.text);

  let candidates: Link[] = root.links;
  let hiringRanked = rankLinks(candidates, "hiring", host);

  // Discovery source 3: sitemap. Used when the homepage is a JS-only shell (edge case 14) or
  // when its anchors turn up nothing that looks like hiring — a buried /handbook/hiring/.
  const homepageIsThin = root.text.length < 200;
  if (homepageIsThin || (hiringRanked[0]?.score ?? 0) < 3) {
    const seeds = robots.sitemaps.length
      ? robots.sitemaps.slice(0, 2)
      : [new URL("/sitemap.xml", origin).toString()];
    const locs: string[] = [];
    for (const seed of seeds) {
      const sm = await get(seed);
      if (!sm) continue;
      const found = sitemapLocs(sm.text);
      if (isIndex(sm.text)) {
        for (const nested of found.slice(0, 2)) {
          const child = await get(nested);
          if (child) locs.push(...sitemapLocs(child.text));
        }
      } else {
        locs.push(...found);
      }
    }
    if (locs.length) {
      const asLinks: Link[] = locs.slice(0, 2000).map((href) => ({
        href,
        text: "",
        chrome: false,
        depth: (() => {
          try {
            return new URL(href).pathname.split("/").filter(Boolean).length;
          } catch {
            return 9;
          }
        })(),
      }));
      candidates = homepageIsThin ? asLinks : [...candidates, ...asLinks];
      hiringRanked = rankLinks(candidates, "hiring", host);
    }
  }

  const aboutRanked = rankLinks(candidates, "about", host);
  const targets = [...hiringRanked.slice(0, 2), ...aboutRanked.slice(0, 2)].filter(
    (l, i, a) => a.findIndex((x) => x.href === l.href) === i && l.href !== root.url,
  );
  const fetched = (await pooled(targets)).filter((p): p is Page => p !== null);

  const byHref = new Map(fetched.map((p, i) => [targets[i]?.href ?? p.url, p] as const));
  let hiring = hiringRanked.map((l) => byHref.get(l.href)).find(Boolean) ?? null;
  const about = aboutRanked.map((l) => byHref.get(l.href)).find(Boolean) ?? root;

  // One level deeper, conditionally: an index page is links and no prose. Take its two best.
  if (hiring && hiring.links.length > 25 && hiring.text.length < 600) {
    const children = rankLinks(hiring.links, "hiring", host)
      .filter((l) => l.href !== hiring!.url)
      .slice(0, 2);
    const deeper = (await pooled(children)).filter((p): p is Page => p !== null);
    if (deeper[0] && deeper[0].text.length > hiring.text.length) hiring = deeper[0];
  }

  if (!hiring) warnings.push("NO_HIRING_PAGE");

  return { root, about, hiring, pages_used, crawl_log, robots, warnings };
}
