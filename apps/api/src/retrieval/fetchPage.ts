/**
 * Stage 2. One page in, cleaned text and links out.
 *
 * Every ceiling from plan §3 is enforced here: 8s per request, 2 MB streamed and aborted,
 * 3 redirects with the host re-validated at every hop, and a content-type allowlist.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { parse } from "node-html-parser";

export type Link = {
  href: string;
  text: string;
  /** Link sits in <nav>, <header> or <footer> — site chrome, which is where careers links live. */
  chrome: boolean;
  depth: number;
};

export type Page = {
  url: string;
  status: number;
  contentType: string;
  title: string;
  text: string;
  links: Link[];
  truncated: boolean;
};

export type FetchOptions = {
  allowPrivateHosts?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
};

const ALLOWED_TYPES = new Set([
  "text/html",
  "text/plain",
  "application/xhtml+xml",
  "text/xml",
  "application/xml",
]);

const UA = "PrepKitBot/0.1 (+interview prep kit; respects robots.txt)";

export const fail = (code: string, message?: string) =>
  Object.assign(new Error(message ?? code), { code });

export const errorCode = (e: unknown) => (e as { code?: string })?.code ?? "UNKNOWN";

/** Edge case 15: `acme.com` has no scheme. Prepend https and let the caller retry http once. */
export function canonicalUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const u = new URL(withScheme);
  u.hash = "";
  return u.toString();
}

/** 0/8, 10/8, 127/8, 169.254/16, 172.16/12, 192.168/16, 100.64/10, and everything from 224 up. */
export function isPrivateV4(ip: string): boolean {
  const [a = -1, b = -1] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

/** ::1, ::, fc00::/7, fe80::/10, and IPv4-mapped addresses, which are the usual bypass. */
export function isPrivateV6(ip: string): boolean {
  const s = ip.toLowerCase().split("%")[0]!;
  if (s === "::1" || s === "::") return true;
  if (/^f[cd]/.test(s) || s.startsWith("fe80")) return true;
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateV4(mapped[1]!) : false;
}

export const isPrivateAddress = (ip: string) => (isIP(ip) === 6 ? isPrivateV6(ip) : isPrivateV4(ip));

/**
 * Edge case 11. Resolves the host and rejects if any A/AAAA record is private.
 *
 * ponytail: there is a TOCTOU window — we resolve, check, then fetch, and fetch resolves again,
 * so DNS rebinding with a 0-TTL record could still slip through. Closing it needs a pinned-IP
 * dispatcher (undici `Agent` with a custom `lookup`); add that if this ever faces untrusted
 * submitters at scale.
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host)
    ? [host]
    : await lookup(host, { all: true })
        .then((r) => r.map((x) => x.address))
        .catch(() => {
          throw fail("DNS_FAILED", `Could not resolve ${host}`);
        });

  if (addresses.length === 0) throw fail("DNS_FAILED", `Could not resolve ${host}`);
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw fail("PRIVATE_HOST", `That address isn't allowed (${host} -> ${address})`);
    }
  }
}

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Strip control characters and collapse whitespace, keeping paragraph breaks — a wall of
 * undifferentiated text is measurably worse input for the generation stages.
 * Also part of the edge case 10 defence.
 */
export const cleanText = (s: string) =>
  s
    .replace(CONTROL_CHARS, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Pure, so the ranking tests never touch the network. */
export function parseHtml(html: string, baseUrl: string): Pick<Page, "title" | "text" | "links"> {
  // A space between adjacent tags, so <a>Products</a><a>Pricing</a> does not read as
  // "ProductsPricing". The doctype goes because otherwise it lands in the extracted text.
  const root = parse(html.replace(/<!doctype[^>]*>/gi, "").replace(/>\s*</g, "> <"));
  const chrome = new Set(root.querySelectorAll("nav a, header a, footer a"));

  const links: Link[] = [];
  const seen = new Set<string>();
  for (const a of root.querySelectorAll("a")) {
    const raw = a.getAttribute("href");
    if (!raw) continue;
    let href: URL;
    try {
      href = new URL(raw, baseUrl);
    } catch {
      continue;
    }
    if (href.protocol !== "http:" && href.protocol !== "https:") continue;
    href.hash = "";
    const key = href.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({
      href: key,
      text: cleanText(a.text).slice(0, 120),
      chrome: chrome.has(a),
      depth: href.pathname.split("/").filter(Boolean).length,
    });
  }

  const title = cleanText(root.querySelector("title")?.text ?? "");
  for (const node of root.querySelectorAll("script, style, noscript, svg, template")) node.remove();
  return { title, text: cleanText(root.structuredText), links };
}

async function readCapped(res: Response, maxBytes: number) {
  if (!res.body) return { body: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    total += value.byteLength;
    if (total > maxBytes) {
      chunks.push(value.subarray(0, value.byteLength - (total - maxBytes)));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return { body: new TextDecoder().decode(Buffer.concat(chunks)), truncated };
}

export async function fetchPage(rawUrl: string, opts: FetchOptions = {}): Promise<Page> {
  const {
    allowPrivateHosts = false,
    timeoutMs = 8_000,
    maxBytes = 2_000_000,
    maxRedirects = 3,
  } = opts;

  let url = new URL(canonicalUrl(rawUrl));

  for (let hop = 0; ; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw fail("BAD_SCHEME", `Only http and https are fetched, got ${url.protocol}`);
    }
    // Re-validated on every hop. A redirect to 169.254.169.254 is the bypass everyone forgets.
    if (!allowPrivateHosts) await assertPublicHost(url.hostname);

    let res: Response;
    try {
      res = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.9" },
      });
    } catch (e) {
      throw fail(
        (e as Error)?.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR",
        `${url.host}: ${(e as Error)?.message ?? "fetch failed"}`,
      );
    }

    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel().catch(() => {});
      if (hop >= maxRedirects) throw fail("TOO_MANY_REDIRECTS", url.toString());
      url = new URL(res.headers.get("location")!, url);
      continue;
    }

    const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw fail(`HTTP_${res.status}`, `${url.toString()} returned ${res.status}`);
    }
    // Edge case 12: a 50 MB PDF is skipped here, before a single byte of it is read.
    if (contentType && !ALLOWED_TYPES.has(contentType)) {
      await res.body?.cancel().catch(() => {});
      throw fail("SKIPPED_CONTENT_TYPE", `${url.toString()} is ${contentType}`);
    }

    const { body, truncated } = await readCapped(res, maxBytes);
    return {
      url: url.toString(),
      status: res.status,
      contentType,
      truncated,
      ...parseHtml(body, url.toString()),
    };
  }
}
