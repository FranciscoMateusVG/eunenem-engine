import { isIP } from "node:net";

function normalizedHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function ipv4ToInteger(address: string): number {
  return address
    .split(".")
    .map(Number)
    .reduce((result, octet) => result * 256 + octet, 0);
}

function isInIpv4Cidr(address: number, base: string, prefix: number): boolean {
  const divisor = 2 ** (32 - prefix);
  return Math.floor(address / divisor) === Math.floor(ipv4ToInteger(base) / divisor);
}

function isSpecialIpv4(address: string): boolean {
  const value = ipv4ToInteger(address);
  return [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ].some(([base, prefix]) =>
    isInIpv4Cidr(value, base as string, prefix as number),
  );
}

function expandIpv6(address: string): number[] {
  let normalized = address.toLowerCase();
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4 = normalized.slice(lastColon + 1);
    const value = ipv4ToInteger(ipv4);
    normalized = `${normalized.slice(0, lastColon)}:${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const [left = "", right = ""] = normalized.split("::");
  const leftGroups = left === "" ? [] : left.split(":");
  const rightGroups = right === "" ? [] : right.split(":");
  const omitted = 8 - leftGroups.length - rightGroups.length;
  return [
    ...leftGroups.map((group) => Number.parseInt(group, 16)),
    ...Array.from({ length: omitted }, () => 0),
    ...rightGroups.map((group) => Number.parseInt(group, 16)),
  ];
}

function isSpecialIpv6(address: string): boolean {
  const groups = expandIpv6(address);
  const first = groups[0] ?? 0;

  // IPv4-mapped IPv6 inherits the embedded IPv4 address's classification.
  if (
    groups.length === 8 &&
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff
  ) {
    const penultimate = groups[6] ?? 0;
    const last = groups[7] ?? 0;
    const ipv4 = `${(penultimate >> 8) & 0xff}.${penultimate & 0xff}.${(last >> 8) & 0xff}.${last & 0xff}`;
    return isSpecialIpv4(ipv4);
  }

  return (
    groups.every((group) => group === 0) || // unspecified
    (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) || // loopback
    (first & 0xfe00) === 0xfc00 || // unique-local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xffc0) === 0xfec0 || // deprecated site-local fec0::/10
    (first & 0xff00) === 0xff00 || // multicast ff00::/8
    (first === 0x2001 && groups[1] === 0x0db8) // documentation 2001:db8::/32
  );
}

/** Whether a URL hostname is a numeric IPv4/IPv6 literal. */
export function isIpLiteralHostname(hostname: string): boolean {
  return isIP(normalizedHostname(hostname)) !== 0;
}

/**
 * Reject numeric addresses that must never be used as a production public
 * object-storage origin: private, loopback, link-local, carrier-grade NAT,
 * documentation, benchmark, multicast, and reserved ranges.
 *
 * Hostnames are deliberately not DNS-resolved here. This is a boot-time
 * configuration guard, not an SSRF fetch boundary; MinIO credentials remain
 * server configuration and the browser performs the presigned upload.
 */
export function isPrivateOrSpecialIpHostname(hostname: string): boolean {
  const normalized = normalizedHostname(hostname);
  const version = isIP(normalized);
  if (version === 4) return isSpecialIpv4(normalized);
  if (version === 6) return isSpecialIpv6(normalized);
  return false;
}
