/**
 * Which URLs the extension may ask anyone to fetch.
 *
 * One predicate serves two consumers with different consequences: the URL reader
 * refuses a URL that fails it, and the search feature skips a source that fails it
 * (and also checks DNS, because it contacts the site itself).
 *
 * Address literals are filtered against special-purpose IPv4 ranges and global IPv6
 * space. This conservative filter is not a claim about DNS or future allocations.
 */
import { isIP } from "node:net";

/** Normalised URLs longer than this are refused rather than echoed or requested. */
export const MAX_URL_LENGTH = 2_048;

/** IPv4 ranges outside the global unicast space (IANA special-purpose registry). */
const IPV4_NOT_GLOBAL: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

/** Special-purpose blocks inside 2000::/3 that are not globally reachable. */
const IPV6_NOT_GLOBAL: Array<[number[], number]> = [
  [[0x2001, 0x0000], 23],
  [[0x2001, 0x0db8], 32],
  [[0x2002], 16],
  [[0x3fff, 0x0000], 20],
];

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, part) => value * 256 + Number(part), 0);
}

function inIpv4Range(value: number, [base, prefix]: [string, number]): boolean {
  const size = 2 ** (32 - prefix);
  const start = ipv4Number(base);
  return value >= start && value < start + size;
}

function isGlobalIpv4(address: string): boolean {
  const value = ipv4Number(address);
  return value !== 0xffffffff && !IPV4_NOT_GLOBAL.some((range) => inIpv4Range(value, range));
}

/** Expand an IPv6 literal to eight 16-bit words, or undefined if it does not parse. */
function ipv6Words(address: string): number[] | undefined {
  let canonical: string;
  try {
    // The URL parser canonicalises every spelling, including embedded dotted IPv4.
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
  const halves = canonical.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  const words = [...left, ...Array<string>(missing).fill("0"), ...right].map((word) =>
    Number.parseInt(word, 16),
  );
  return words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : undefined;
}

function inIpv6Block(words: number[], [base, prefix]: [number[], number]): boolean {
  for (let bit = 0; bit < prefix; bit += 16) {
    const index = bit / 16;
    const width = Math.min(16, prefix - bit);
    const mask = (0xffff << (16 - width)) & 0xffff;
    if ((words[index] & mask) !== ((base[index] ?? 0) & mask)) return false;
  }
  return true;
}

function isGlobalIpv6(address: string): boolean {
  const words = ipv6Words(address);
  if (!words) return false;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-translated (::ffff:0:a.b.c.d) forms carry an
  // IPv4 destination: judge that address, so public IPv4 stays reachable.
  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const translated =
    words.slice(0, 4).every((word) => word === 0) && words[4] === 0xffff && words[5] === 0;
  if (mapped || translated) {
    return isGlobalIpv4([words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join("."));
  }
  if ((words[0] & 0xe000) !== 0x2000) return false; // global unicast is 2000::/3
  return !IPV6_NOT_GLOBAL.some((block) => inIpv6Block(words, block));
}

/** Strip URL brackets and an interface zone (`fe80::1%eth0`). */
function bareAddress(address: string): string {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  return bare.split("%")[0];
}

/** Whether an IP literal is globally routable. Names are not addresses: false. */
export function isGloballyRoutable(address: string): boolean {
  const bare = bareAddress(address);
  const version = isIP(bare);
  if (version === 4) return isGlobalIpv4(bare);
  if (version === 6) return isGlobalIpv6(bare);
  return false;
}

/** True for an IP literal outside the global space. Host names return false. */
export function isPrivateAddress(address: string): boolean {
  const bare = bareAddress(address);
  return isIP(bare) !== 0 && !isGloballyRoutable(bare);
}

/** Special-use names that only resolve on a local network (RFC 6761 and later). */
const LOCAL_NAME_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "home.arpa",
  "invalid",
  "test",
  "onion",
  "alt",
];

/** Whether a host name or literal can only mean the local machine or network. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (isIP(bareAddress(host))) return !isGloballyRoutable(host);
  // A single-label name resolves through a local search domain, never on the internet.
  if (!host.includes(".")) return true;
  return LOCAL_NAME_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export type UrlCheck =
  | { ok: true; url: string }
  | { ok: false; reason: "missing" | "invalid" | "scheme" | "credentials" | "local" | "too-long" };

/**
 * May this URL be requested on the user's behalf? The answer is about the URL alone:
 * a public http(s) address with no embedded credentials and a bounded length.
 */
export function checkPublicUrl(raw: string): UrlCheck {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return { ok: false, reason: "missing" };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return { ok: false, reason: "scheme" };
  if (parsed.username || parsed.password) return { ok: false, reason: "credentials" };
  if (isLocalHost(parsed.hostname)) return { ok: false, reason: "local" };
  const url = parsed.toString();
  if (url.length > MAX_URL_LENGTH) return { ok: false, reason: "too-long" };
  return { ok: true, url };
}
