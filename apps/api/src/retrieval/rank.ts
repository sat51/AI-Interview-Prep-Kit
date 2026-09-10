/**
 * Plan §3. No path list — a vocabulary, scored against whatever links the site actually has.
 * That is what reaches a buried /handbook/hiring/ that no hardcoded guess would have found.
 */
import type { Link } from "./fetchPage.ts";

export const LEXICONS = {
  hiring:
    "careers jobs join hiring interview recruit work-with-us life-at handbook culture people team apply openings process",
  about: "about company mission what-we-do story product platform why",
} as const;

export type LexiconName = keyof typeof LEXICONS;

const WORDS: Record<LexiconName, string[]> = {
  hiring: LEXICONS.hiring.split(" "),
  about: LEXICONS.about.split(" "),
};

const BAD_EXTENSION = /\.(pdf|zip|jpe?g|png|gif|svg|webp|mp4|mp3|docx?|xlsx?|pptx?|dmg|exe)$/i;

/** Lowercase, and turn every run of non-alphanumerics into a single hyphen. */
export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** How many distinct lexicon words appear in the text, matched on hyphenated word boundaries. */
export function keywordHits(text: string, lexicon: LexiconName): number {
  const slug = `-${slugify(text)}-`;
  return WORDS[lexicon].filter((w) => slug.includes(`-${w}-`) || slug.includes(`-${w}s-`)).length;
}

export function scoreLink(link: Link, lexicon: LexiconName, baseHost: string): number {
  let url: URL;
  try {
    url = new URL(link.href);
  } catch {
    return -Infinity;
  }

  const offsite = url.host !== baseHost;
  const junk = BAD_EXTENSION.test(url.pathname) || [...url.searchParams.keys()].length > 2;

  return (
    3 * keywordHits(link.text, lexicon) +
    2 * keywordHits(url.pathname, lexicon) +
    (link.chrome ? 1 : 0) -
    (link.depth > 2 ? 2 : 0) -
    (offsite || junk ? 5 : 0)
  );
}

export type RankedLink = Link & { score: number };

/** Highest score first. Ties break on shallower path, so /careers beats /about/careers. */
export function rankLinks(links: Link[], lexicon: LexiconName, baseHost: string): RankedLink[] {
  return links
    .map((link) => ({ ...link, score: scoreLink(link, lexicon, baseHost) }))
    .filter((l) => l.score > 0)
    .sort((a, b) => b.score - a.score || a.depth - b.depth || a.href.localeCompare(b.href));
}
