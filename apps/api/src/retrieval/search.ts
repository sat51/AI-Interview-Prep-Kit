/**
 * Stage 4. One search per kit — what people say publicly about interviewing here.
 *
 * Tavily when TAVILY_API_KEY is set (1,000 free credits a month, one credit per kit), and a
 * keyless DuckDuckGo HTML scrape when it is not, so a clean clone with no keys still works.
 */
import { cleanText, fail, parseHtml } from "./fetchPage.ts";

export type Snippet = { title: string; url: string; content: string; source: "tavily" | "duckduckgo" };

export type SearchOptions = { maxResults?: number; timeoutMs?: number; apiKey?: string };

/** Confirmed against https://docs.tavily.com/api-reference/endpoint/search on 2026-09-10. */
async function tavily(query: string, apiKey: string, max: number, timeoutMs: number) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ query, max_results: max, search_depth: "basic", topic: "general" }),
  });
  if (!res.ok) throw fail(`TAVILY_${res.status}`, await res.text().catch(() => res.statusText));

  const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (data.results ?? [])
    .filter((r) => r.url)
    .map((r) => ({
      title: cleanText(r.title ?? ""),
      url: r.url!,
      content: cleanText(r.content ?? "").slice(0, 1200),
      source: "tavily" as const,
    }));
}

/** DuckDuckGo wraps every result href in a redirect carrying the real URL in `uddg`. */
const unwrapDuckDuckGo = (href: string) => {
  try {
    return new URL(href, "https://duckduckgo.com").searchParams.get("uddg") ?? href;
  } catch {
    return href;
  }
};

async function duckduckgo(query: string, max: number, timeoutMs: number) {
  // GET, with a browser user-agent. A POST from a bot UA is answered with a 202 challenge page
  // and no results at all — verified 2026-09-10 against html.duckduckgo.com.
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw fail(`DDG_${res.status}`, res.statusText);

  const results = parseDuckDuckGoHtml(await res.text()).slice(0, max);
  if (results.length === 0) throw fail("DDG_NO_RESULTS", "DuckDuckGo returned no parseable results");
  return results;
}

/** Exported so the parser is testable against a saved fixture rather than the live network. */
export function parseDuckDuckGoHtml(html: string): Snippet[] {
  const { links } = parseHtml(html, "https://duckduckgo.com");
  const seen = new Set<string>();
  const out: Snippet[] = [];

  for (const link of links) {
    if (!/uddg=/.test(link.href)) continue;
    const url = unwrapDuckDuckGo(link.href);
    if (!link.text || seen.has(url) || /duckduckgo\.com/.test(url)) continue;
    seen.add(url);
    out.push({ title: link.text, url, content: "", source: "duckduckgo" });
  }
  return out;
}

/**
 * Never throws. A kit with no discussion is a documented outcome (edge case 4), not a failure —
 * the brief just has to say so honestly instead of inventing interview rounds.
 */
export async function searchDiscussion(
  companyName: string,
  opts: SearchOptions = {},
): Promise<{ snippets: Snippet[]; warnings: string[] }> {
  const { maxResults = 6, timeoutMs = 10_000, apiKey = process.env.TAVILY_API_KEY } = opts;
  const query = `"${companyName}" interview process what to expect engineering hiring`;
  const warnings: string[] = [];

  if (apiKey) {
    try {
      return { snippets: await tavily(query, apiKey, maxResults, timeoutMs), warnings };
    } catch (e) {
      warnings.push(`SEARCH_TAVILY_FAILED:${(e as { code?: string }).code ?? "UNKNOWN"}`);
    }
  }

  try {
    return { snippets: await duckduckgo(query, maxResults, timeoutMs), warnings };
  } catch (e) {
    warnings.push(`SEARCH_FAILED:${(e as { code?: string }).code ?? "UNKNOWN"}`);
    return { snippets: [], warnings };
  }
}
