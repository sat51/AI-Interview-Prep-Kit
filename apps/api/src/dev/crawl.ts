/**
 * H2 demo: prints the ranked links and the pages the crawler chose, for whatever you give it.
 *
 *   npm run crawl                       # gitlab.com, posthog.com, and a dead domain
 *   npm run crawl -- stripe.com
 */
import { crawlSite } from "../retrieval/crawlSite.ts";
import { rankLinks } from "../retrieval/rank.ts";
import { searchDiscussion } from "../retrieval/search.ts";

const DEFAULTS = ["gitlab.com", "posthog.com", "this-domain-does-not-exist-92841.com"];

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);

for (const site of process.argv.slice(2).length ? process.argv.slice(2) : DEFAULTS) {
  const started = Date.now();
  console.log(`\n${"=".repeat(78)}\n${site}\n${"=".repeat(78)}`);

  const result = await crawlSite(site, { allowPrivateHosts: process.env.ALLOW_PRIVATE_HOSTS === "true" });

  if (result.root) {
    const host = new URL(result.root.url).host;
    for (const lexicon of ["hiring", "about"] as const) {
      const ranked = rankLinks(result.root.links, lexicon, host).slice(0, 5);
      console.log(`\n  top ${lexicon} links (of ${result.root.links.length} on the homepage)`);
      for (const l of ranked) console.log(`    ${pad(String(l.score), 4)} ${l.href}`);
      if (!ranked.length) console.log("    (none scored above zero)");
    }
  }

  console.log("\n  chosen");
  console.log(`    about   ${result.about?.url ?? "-"}`);
  console.log(`    hiring  ${result.hiring?.url ?? "-"}`);
  if (result.hiring) console.log(`            ${result.hiring.text.slice(0, 160)}...`);

  console.log(`\n  fetched ${result.crawl_log.length} urls in ${Date.now() - started}ms`);
  for (const e of result.crawl_log) {
    console.log(`    ${pad(e.outcome, 8)} ${pad(e.note ?? "", 24)} ${e.url}`);
  }
  if (result.warnings.length) console.log(`  warnings: ${result.warnings.join(", ")}`);

  if (result.root && process.env.RUN_SEARCH === "true") {
    // The real company name comes from stage 6; the domain label is close enough for a demo.
    const name = new URL(result.root.url).host.replace(/^www\./, "").split(".")[0]!;
    const { snippets, warnings } = await searchDiscussion(name);
    console.log(`\n  discussion (${snippets[0]?.source ?? "none"}) ${warnings.join(", ")}`);
    for (const s of snippets.slice(0, 3)) console.log(`    ${s.title} — ${s.url}`);
  }
}
