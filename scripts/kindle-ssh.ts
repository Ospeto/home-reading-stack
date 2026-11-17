#!/usr/bin/env bun
/**
 * scripts/kindle-ssh.ts
 *
 * LightHouse Kindle SSH device-access tool.
 *
 * The Kindles have no stable address of their own: the wireless route is served
 * by an SSH daemon that only exists while KOReader is running, and the DHCP
 * lease can move the device to a different address at any time. Trusting a
 * remembered IP is therefore always wrong eventually, so this tool never does.
 * It discovers the device from live evidence first, then connects to what it
 * actually found.
 *
 * Discovery ladder (all three layers run every time; results are merged):
 *   1. mDNS          - <alias>.local hostname lookup
 *   2. USB gadget    - the jailbroken-device USB-network address 192.168.15.244
 *   3. LAN sweep     - TCP connect on the real LAN subnet(s) for ports 2222/22,
 *                      then an SSH banner read to prove the responder is
 *                      dropbear (the Kindle SSH daemon) and not something else
 *
 * Subcommands (also exposed as `bin/lighthouse kindle-ssh <subcommand>`):
 *   find      Report every reachable Kindle candidate and the exact login command
 *   probe     Full diagnosis of one device: port, banner, key auth, remote identity
 *   connect   Log in (or run a remote command) over the working route
 *   key       Install this Mac mini's public key on the device, idempotently
 *   usb       Report the USB-cable fallback route and the steps to bring it up (192.168.15.0/24)
 *
 * Exit codes are meaningful so scripts can branch on them:
 *   0  find: a Kindle responder was discovered; probe/connect/key: the route is verified; usb: the
 *      USB link answered
 *   1  find: nothing answered discovery; probe/connect/key: no device could be found
 *   2  probe/connect/key: a device was found but the route is not usable yet (SSH closed / key
 *      missing), it reported a different serial than --expect-serial, the address now presents a
 *      different host key, the connection failed, or the key check ran out of time and the key
 *      state is unknown (retry with a longer budget - do not reinstall the key);
 *      usb: the USB route is not up (no candidate link interface, or nothing answered)
 *   3  usage error
 * `connect -- <command>` instead exits with the remote command's own status, as ssh does, and 255
 * when the wrapper killed that command at its 120 s budget.
 *
 * `--device 1` / `--device 2` are address-order labels, not identities: the DHCP lease moves. The
 * serial (USID) read back after login is the identity, and `--expect-serial` makes a different unit
 * a hard failure on probe/connect/key. `find` and `usb` never log in, so they reject that option
 * rather than accepting an identity check they cannot perform.
 */

import * as dns from "node:dns/promises";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Port the Kindle SSH daemon (patched dropbear) listens on while KOReader runs. */
export const KINDLE_SSH_PORT = 2222;
/** Port accepted as a secondary match (USBNetwork / vendor sshd builds). */
export const KINDLE_ALT_SSH_PORT = 22;
/** Ports an SSH daemon can answer on over the USB link (USBNetwork on 22, KOReader's plugin on 2222). */
export const KINDLE_USB_PORTS = [KINDLE_SSH_PORT, KINDLE_ALT_SSH_PORT];
/** Address the Kindle takes on its own USB network interface. */
export const KINDLE_USB_HOST = "192.168.15.244";
/** The /24 the Kindle's USB gadget creates; any Mac interface holding an address on it is the link. */
export const USB_LINK_PREFIX = KINDLE_USB_HOST.replace(/\.\d+$/, ".");
/** Address this Mac must take on the same USB network link. */
export const MAC_USB_HOST = "192.168.15.201";
/** Netmask for the USB link. */
export const USB_NETMASK = "255.255.255.0";
/**
 * Amazon Technologies OUI. It is only a positive hint that an interface is the
 * Kindle USB link - never the gate: the Mac-side end of that link is often not
 * Amazon-assigned, and no scan path reads MAC addresses.
 */
export const AMAZON_OUI = "c0:8d:51";

/** Device aliases accepted on the command line, mapped to canonical names. */
const ALIASES: Record<string, string> = {
  "1": "kindle1",
  kindle: "kindle1",
  kindle1: "kindle1",
  "2": "kindle2",
  kindle2: "kindle2",
};

/** Candidate mDNS hostnames tried before falling back to a subnet sweep. */
export const MDNS_HOST_CANDIDATES = [
  "kindle.local",
  "kindle1.local",
  "kindle2.local",
  "kindlepaperwhite.local",
];

/** Command run on the device to prove both identity and that a shell really works. */
export const VERIFY_REMOTE_COMMAND = [
  "cat /proc/usid 2>/dev/null || echo no-usid",
  "uname -srm",
  "hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null",
  "cat /etc/kindle-version 2>/dev/null || echo 'no /etc/kindle-version'",
  "test -d /mnt/us && echo 'us-partition=present' || echo 'us-partition=absent'",
  "test -d /mnt/us/koreader && echo 'koreader=present' || echo 'koreader=absent'",
  "uptime",
].join("; ");

/**
 * The Kindle serial (USID) from a VERIFY_REMOTE_COMMAND readback. It is the only
 * field that differs between the units: they share hostname and kernel.
 */
export function parseSerialFromIdentity(output: string | undefined): string | undefined {
  const first = (output ?? "").split("\n")[0]?.trim() ?? "";
  return /^[A-Z0-9]{12,17}$/.test(first) ? first : undefined;
}

// ---------------------------------------------------------------------------
// IPv4 helpers (pure)
// ---------------------------------------------------------------------------

export interface IfaceAddr {
  name: string;
  address: string;
  netmask: string;
  mac?: string;
  /** "up" when ifconfig reported status: active or the interface carries a route. */
  state?: string;
}

export interface ScanTarget {
  network: string;
  prefix: number;
  interface: string;
  localAddress: string;
  firstHost: string;
  lastHost: string;
  hostCount: number;
}

export function isValidIpv4(value: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
  return value.split(".").every((octet) => {
    const n = Number(octet);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}

export function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`invalid IPv4 address: ${ip}`);
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

export function intToIpv4(value: number): string {
  const n = value >>> 0;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export function netmaskToPrefix(netmask: string): number {
  const bits = ipv4ToInt(netmask).toString(2).padStart(32, "0");
  if (!/^1*0*$/.test(bits)) throw new Error(`non-contiguous netmask: ${netmask}`);
  return bits.indexOf("0") === -1 ? 32 : bits.indexOf("0");
}

/**
 * 198.18.0.0/15 is the benchmarking range sing-box and other tunnel clients use
 * for fake-IP addresses. Scanning it is meaningless and slow, so it is excluded.
 */
export function isTunnelAddress(ip: string): boolean {
  if (!isValidIpv4(ip)) return false;
  const n = ipv4ToInt(ip);
  return (n >>> 17) === (ipv4ToInt("198.18.0.0") >>> 17);
}

const IGNORED_INTERFACE_PREFIXES = [
  "utun",
  "ipsec",
  "llw",
  "awdl",
  "bridge",
  "gif",
  "stf",
  "lo",
  "anpi",
  "ap1",
  "p2p",
];

export function shouldScanInterface(name: string, address: string): boolean {
  if (!isValidIpv4(address)) return false;
  if (IGNORED_INTERFACE_PREFIXES.some((prefix) => name.startsWith(prefix))) return false;
  if (address.startsWith("127.")) return false;
  if (isTunnelAddress(address)) return false;
  // Link-local addresses never carry a routable Kindle.
  if (address.startsWith("169.254.")) return false;
  return true;
}

/**
 * Turn live interface addresses into concrete host lists to probe.
 *
 * Addresses wider than /24 are clamped to the /24 that contains the local
 * address: a home Kindle is always one hop away on the local segment, and a
 * /16 sweep would take minutes for no benefit.
 */
export function deriveScanTargets(ifaces: IfaceAddr[], maxHostsPerTarget = 254): ScanTarget[] {
  const targets: ScanTarget[] = [];
  const seen = new Set<string>();

  for (const iface of ifaces) {
    if (!shouldScanInterface(iface.name, iface.address)) continue;
    if (!isValidIpv4(iface.netmask)) continue;

    let prefix: number;
    try {
      prefix = netmaskToPrefix(iface.netmask);
    } catch {
      continue;
    }
    if (prefix > 30) continue;

    const localInt = ipv4ToInt(iface.address);
    const networkInt = prefix >= 24
      ? (localInt & (0xffffffff << (32 - prefix))) >>> 0
      : (localInt & 0xffffff00) >>> 0;
    const effectivePrefix = prefix >= 24 ? prefix : 24;

    const key = `${intToIpv4(networkInt)}/${effectivePrefix}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const hostBits = 32 - effectivePrefix;
    const broadcastInt = (networkInt + 2 ** hostBits - 1) >>> 0;
    const firstHostInt = networkInt + 1;
    const lastHostInt = broadcastInt - 1;
    const hostCount = Math.max(0, lastHostInt - firstHostInt + 1);

    targets.push({
      network: intToIpv4(networkInt),
      prefix: effectivePrefix,
      interface: iface.name,
      localAddress: iface.address,
      firstHost: intToIpv4(firstHostInt),
      lastHost: intToIpv4(Math.min(lastHostInt, firstHostInt + maxHostsPerTarget - 1)),
      hostCount: Math.min(hostCount, maxHostsPerTarget),
    });
  }

  return targets;
}

export function expandScanHosts(target: ScanTarget): string[] {
  const first = ipv4ToInt(target.firstHost);
  const last = ipv4ToInt(target.lastHost);
  const hosts: string[] = [];
  for (let n = first; n <= last; n++) hosts.push(intToIpv4(n));
  return hosts;
}

/** Parse `ifconfig` output into interface addresses with MAC and status. */
export function parseIfconfig(text: string): IfaceAddr[] {
  const result: IfaceAddr[] = [];
  // Lines for one interface do not arrive in a fixed order (macOS prints
  // `status:` after `inet`), so accumulate the whole block and flush it when
  // the next interface header starts.
  let pending: { name: string; mac?: string; state?: string; addresses: Array<{ address: string; netmask: string }> } | null =
    null;

  const flush = () => {
    if (!pending) return;
    for (const entry of pending.addresses) {
      result.push({
        name: pending.name,
        address: entry.address,
        netmask: entry.netmask,
        mac: pending.mac,
        state: pending.state,
      });
    }
    pending = null;
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    const header = line.match(/^([A-Za-z0-9_.]+):\s+flags=/);
    if (header) {
      flush();
      pending = { name: header[1], addresses: [] };
      const macMatch = line.match(/ether\s+([0-9a-f:]{17})/i);
      if (macMatch) pending.mac = macMatch[1].toLowerCase();
      const statusMatch = line.match(/status:\s+(\w+)/);
      if (statusMatch) pending.state = statusMatch[1];
      continue;
    }
    if (!pending) continue;

    // Point-to-point interfaces insert "--> <peer>" before the netmask.
    const inetMatch = line.match(
      /^\s*inet\s+(\d+\.\d+\.\d+\.\d+)\s+(?:-->\s+\d+\.\d+\.\d+\.\d+\s+)?netmask\s+(0x[0-9a-fA-F]+|\d+\.\d+\.\d+\.\d+)/,
    );
    if (inetMatch) {
      let netmask = inetMatch[2];
      if (netmask.startsWith("0x")) netmask = intToIpv4(parseInt(netmask, 16));
      pending.addresses.push({ address: inetMatch[1], netmask });
      continue;
    }

    const macOnly = line.match(/^\s*ether\s+([0-9a-f:]{17})/i);
    if (macOnly && !pending.mac) pending.mac = macOnly[1].toLowerCase();
    const statusOnly = line.match(/^\s*status:\s+(\w+)/);
    if (statusOnly && !pending.state) pending.state = statusOnly[1];
  }

  flush();
  return result;
}

// ---------------------------------------------------------------------------
// SSH banner classification (pure)
// ---------------------------------------------------------------------------

export type SshServerKind = "dropbear" | "openssh" | "other" | "unknown";

export interface SshServerInfo {
  server: SshServerKind;
  version?: string;
  /** True only for the daemon family the Kindle SSH plugin runs. */
  kindleLikely: boolean;
}

/**
 * Classify an SSH identification string such as `SSH-2.0-dropbear_2020.81`.
 * Only dropbear counts as Kindle-likely: the Kindle route is served by the
 * patched dropbear the KOReader SSH session starts.
 */
export function classifySshServer(banner: string | null): SshServerInfo {
  if (!banner) return { server: "unknown", kindleLikely: false };
  const trimmed = banner.trim();
  if (!trimmed.toLowerCase().startsWith("ssh-")) return { server: "unknown", kindleLikely: false };

  const lower = trimmed.toLowerCase();
  if (lower.includes("dropbear")) {
    const version = trimmed.replace(/^SSH-[\d.]+-/, "");
    return { server: "dropbear", version, kindleLikely: true };
  }
  if (lower.includes("openssh")) {
    const version = trimmed.replace(/^SSH-[\d.]+-/, "");
    return { server: "openssh", version, kindleLikely: false };
  }
  return { server: "other", version: trimmed.replace(/^SSH-[\d.]+-/, ""), kindleLikely: false };
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
  timedOut: boolean;
}

export function runWithTimeout(command: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ stdout: "", stderr: String(error), status: null, timedOut: false });
      return;
    }

    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, status, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish(null);
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      stderr += String(error);
      finish(null);
    });
    child.once("close", (code) => finish(code));
  });
}

function readLiveInterfaces(): IfaceAddr[] {
  const result = spawnSync("ifconfig", ["-a"], { encoding: "utf8", timeout: 8000 });
  if (result.status !== 0 || !result.stdout) return [];
  return parseIfconfig(result.stdout);
}

// ---------------------------------------------------------------------------
// Network probes
// ---------------------------------------------------------------------------

export interface PortProbe {
  host: string;
  port: number;
  open: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * Native binary used for TCP probes.
 *
 * This deliberately does NOT use a Bun/Node socket. In this environment raw
 * runtime sockets to the LAN fail while native binaries succeed on the same
 * address: `net.connect('192.168.31.73', 2222)` returns ECONNREFUSED and a
 * Python socket returns EHOSTUNREACH, while `nc` and `ssh` reach the device
 * normally. The cause is the host's scoped-route/VPN layering, not the device.
 * Delegating to `nc` keeps discovery honest instead of silently blind.
 */
const NC_BIN = fs.existsSync("/usr/bin/nc") ? "/usr/bin/nc" : "nc";
/** Native ssh binary; used for probing because it handles the same env correctly. */
export const SSH_BIN = fs.existsSync("/usr/bin/ssh") ? "/usr/bin/ssh" : "ssh";

function msToSeconds(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

/**
 * Test whether a TCP port accepts connections.
 *
 * Returns `open: false` plus a reason for refused and timed-out ports, so the
 * caller can distinguish "host is up, nothing listening" from "host is not
 * answering" and never reports a bare timeout.
 */
export function probeTcp(host: string, port: number, timeoutMs = 1000): Promise<PortProbe> {
  const seconds = msToSeconds(timeoutMs);
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let stderr = "";
    let child: ReturnType<typeof spawn>;

    const finish = (open: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve({ host, port, open, latencyMs: Date.now() - started, error });
    };

    // Backstop: nc honours -w, but never let a probe outlive its budget.
    const timer = setTimeout(() => finish(false, "timeout"), seconds * 1000 + 700);

    try {
      child = spawn(NC_BIN, ["-z", "-w", String(seconds), host, String(port)], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch (error) {
      clearTimeout(timer);
      resolve({ host, port, open: false, latencyMs: 0, error: `spawn failed: ${String(error)}` });
      return;
    }

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => finish(false, String(error)));
    child.once("close", (code) => {
      if (code === 0) return finish(true);
      const firstLine = stderr.trim().split("\n")[0]?.trim();
      finish(false, firstLine || (code === null ? "timeout" : `exit ${code}`));
    });
  });
}

/** Read the SSH identification string a listener sends unprompted. */
export function readSshBanner(host: string, port: number, timeoutMs = 1500, maxBytes = 256): Promise<string | null> {
  const seconds = msToSeconds(timeoutMs);
  return new Promise((resolve) => {
    let buffer = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;

    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve(value);
    };

    const timer = setTimeout(() => finish(buffer.trim() || null), seconds * 1000 + 700);

    try {
      child = spawn(NC_BIN, ["-w", String(seconds), host, String(port)], {
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
      return;
    }

    child.stdout?.on("data", (chunk) => {
      buffer += String(chunk);
      if (buffer.includes("\n")) finish(buffer.split("\n")[0].replace(/\r$/, "").trim());
      else if (buffer.length >= maxBytes) finish(buffer.trim());
    });
    child.once("error", () => finish(buffer.trim() || null));
    child.once("close", () => finish(buffer.trim() || null));
    // Close stdin at once: we only want to read the server's greeting.
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
  });
}

/** Run async work over items with a bounded number of concurrent tasks. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length || 1));

  const runners = Array.from({ length: width }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export type DiscoverySource = "mdns" | "usb" | "lan-scan";

export interface DiscoveredDevice {
  host: string;
  port: number;
  banner: string | null;
  server: SshServerKind;
  serverVersion?: string;
  kindleLikely: boolean;
  source: DiscoverySource;
}

export interface LayerReport {
  layer: string;
  status: "found" | "empty" | "skipped" | "error";
  detail: string;
}

export interface DiscoveryResult {
  devices: DiscoveredDevice[];
  layers: LayerReport[];
  scannedHosts: number;
  /** Ports the probes actually used, so reports never name a port that was not tried. */
  probedPorts: number[];
  scanTargets: ScanTarget[];
  durationMs: number;
}

export interface DiscoverOptions {
  ports?: number[];
  timeoutMs?: number;
  concurrency?: number;
  mdns?: boolean;
  includeUsb?: boolean;
  /** Injected for tests: interface addresses to scan instead of live ones. */
  ifaces?: IfaceAddr[];
  /** Injected for tests. */
  probe?: (host: string, port: number, timeoutMs: number) => Promise<PortProbe>;
  /** Injected for tests. */
  banner?: (host: string, port: number) => Promise<string | null>;
}

async function resolveMdnsHostnames(candidates: string[]): Promise<Array<{ host: string; name: string }>> {
  const found: Array<{ host: string; name: string }> = [];
  await Promise.all(
    candidates.map(async (name) => {
      try {
        const record = await dns.lookup(name, { family: 4 });
        if (record?.address) found.push({ host: record.address, name });
      } catch {
        /* name does not resolve - expected when the device is absent */
      }
    }),
  );
  return found;
}

interface DiscoveryContext {
  ports: number[];
  timeoutMs: number;
  concurrency: number;
  probe: (host: string, port: number, timeoutMs: number) => Promise<PortProbe>;
  bannerFn: (host: string, port: number) => Promise<string | null>;
  ifaces: IfaceAddr[];
  seen: Set<string>;
  devices: DiscoveredDevice[];
  localAddresses: Set<string>;
}

async function recordCandidate(ctx: DiscoveryContext, host: string, port: number, source: DiscoverySource): Promise<void> {
  const key = `${host}:${port}`;
  if (ctx.seen.has(key)) return;
  const banner = await ctx.bannerFn(host, port);
  const info = classifySshServer(banner);
  ctx.seen.add(key);
  ctx.devices.push({
    host,
    port,
    banner,
    server: info.server,
    serverVersion: info.version,
    kindleLikely: info.kindleLikely,
    source,
  });
}

async function probeHostPorts(
  ctx: DiscoveryContext,
  host: string,
  source: DiscoverySource,
  portsToTry: number[],
): Promise<void> {
  // This Mac's own addresses answer on 22 and would otherwise look like candidates.
  if (source === "lan-scan" && ctx.localAddresses.has(host)) return;
  const results = await Promise.all(portsToTry.map((port) => ctx.probe(host, port, ctx.timeoutMs)));
  for (const result of results) {
    if (result.open) await recordCandidate(ctx, result.host, result.port, source);
  }
}

async function runMdnsLayer(ctx: DiscoveryContext, enabled: boolean): Promise<LayerReport> {
  if (!enabled) return { layer: "mDNS", status: "skipped", detail: "disabled with --no-mdns" };

  const resolved = await resolveMdnsHostnames(MDNS_HOST_CANDIDATES);
  if (resolved.length === 0) {
    return { layer: "mDNS", status: "empty", detail: `no answer for ${MDNS_HOST_CANDIDATES.join(", ")}` };
  }
  for (const entry of resolved) {
    await probeHostPorts(ctx, entry.host, "mdns", ctx.ports);
  }
  return { layer: "mDNS", status: "found", detail: resolved.map((r) => `${r.name} -> ${r.host}`).join(", ") };
}

async function runUsbLayer(ctx: DiscoveryContext, enabled: boolean): Promise<LayerReport> {
  if (!enabled) return { layer: "USB gadget", status: "skipped", detail: "disabled with --no-usb" };

  const hasUsbAddress = ctx.ifaces.some((iface) => iface.address.startsWith(USB_LINK_PREFIX));
  const hasLinkLocalHint = ctx.ifaces.some(
    (iface) => /^en\d+$/.test(iface.name) && iface.address.startsWith("169.254."),
  );
  const hasAmazonHint = ctx.ifaces.some((iface) => (iface.mac ?? "").startsWith(AMAZON_OUI));
  const usbTimeout = Math.max(ctx.timeoutMs, 600);

  for (const port of ctx.ports) {
    const result = await ctx.probe(KINDLE_USB_HOST, port, usbTimeout);
    if (!result.open) continue;
    await recordCandidate(ctx, KINDLE_USB_HOST, port, "usb");
    return { layer: "USB gadget", status: "found", detail: `${KINDLE_USB_HOST}:${port} answered` };
  }

  let detail: string;
  if (hasUsbAddress) {
    detail = `USB link is up but ${KINDLE_USB_HOST} did not answer on ${ctx.ports.join("/")}`;
  } else if (hasLinkLocalHint) {
    detail = `a 169.254 self-assigned en* is only a hint that the cable may be up: ${KINDLE_USB_HOST} did not answer on ${ctx.ports.join("/")} and this Mac holds no address on ${USB_LINK_PREFIX}0/24`;
  } else if (hasAmazonHint) {
    detail = `an Amazon-OUI adapter is present, which is only a hint (no address on ${USB_LINK_PREFIX}0/24 and no 169.254 en*); ${KINDLE_USB_HOST} unreachable`;
  } else {
    detail = `no USB link address evidence on this Mac (no address on ${USB_LINK_PREFIX}0/24 and no 169.254 en*); ${KINDLE_USB_HOST} unreachable`;
  }

  return { layer: "USB gadget", status: "empty", detail };
}

async function runLanLayer(
  ctx: DiscoveryContext,
): Promise<{ report: LayerReport; scannedHosts: number; targets: ScanTarget[] }> {
  const targets = deriveScanTargets(ctx.ifaces);
  if (targets.length === 0) {
    return {
      report: { layer: "LAN sweep", status: "skipped", detail: "no scannable IPv4 interface found" },
      scannedHosts: 0,
      targets,
    };
  }

  let probedHosts = 0;

  for (const target of targets) {
    const hosts = expandScanHosts(target);
    // Skip hosts an earlier layer already identified.
    const pending = hosts.filter((host) => !ctx.ports.every((port) => ctx.seen.has(`${host}:${port}`)));

    // Probe every address: Kindles drop ICMP, so a ping-first scan would skip
    // the device it is looking for.
    probedHosts += pending.length;

    await mapWithConcurrency(pending, ctx.concurrency, (host) => probeHostPorts(ctx, host, "lan-scan", ctx.ports));
  }

  const summary = targets.map((t) => `${t.network}/${t.prefix} (${t.hostCount} hosts on ${t.interface})`).join(", ");
  return {
    report: {
      layer: "LAN sweep",
      status: ctx.devices.some((device) => device.source === "lan-scan") ? "found" : "empty",
      detail: `${summary}; ${probedHosts} host(s) probed on ${ctx.ports.join("/")}`,
    },
    scannedHosts: probedHosts,
    targets,
  };
}

export async function discoverKindle(options: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const started = Date.now();
  const ifaces = options.ifaces ?? readLiveInterfaces();
  const ctx: DiscoveryContext = {
    ports: options.ports ?? [KINDLE_SSH_PORT, KINDLE_ALT_SSH_PORT],
    timeoutMs: options.timeoutMs ?? 1200,
    concurrency: options.concurrency ?? 64,
    probe: options.probe ?? ((host, port, t) => probeTcp(host, port, t)),
    bannerFn: options.banner ?? ((host, port) => readSshBanner(host, port)),
    ifaces,
    seen: new Set(),
    devices: [],
    localAddresses: new Set(ifaces.map((iface) => iface.address)),
  };

  const layers: LayerReport[] = [];

  layers.push(await runMdnsLayer(ctx, options.mdns !== false));
  layers.push(await runUsbLayer(ctx, options.includeUsb !== false));

  const lan = await runLanLayer(ctx);
  layers.push(lan.report);

  return {
    devices: ctx.devices,
    layers,
    scannedHosts: lan.scannedHosts,
    probedPorts: ctx.ports,
    scanTargets: lan.targets,
    durationMs: Date.now() - started,
  };
}
// ---------------------------------------------------------------------------
// Route evaluation / diagnosis
// ---------------------------------------------------------------------------

export type RouteState =
  | "verified"
  | "identity-mismatch"
  | "auth-failed"
  | "host-key-changed"
  | "ssh-unreachable"
  | "ssh-timeout"
  | "ssh-closed"
  | "not-found";

export interface RouteDecision {
  state: RouteState;
  /** Exit code callers and the CLI should use. */
  code: number;
  headline: string;
  body: string[];
  device?: DiscoveredDevice;
}

export interface DiagnosisInput {
  discovery: DiscoveryResult;
  alias: string;
  authResult?: { authenticated: boolean; error?: string; output?: string; timedOut?: boolean; failure?: SshFailure };
  /** Set when a specific device was requested but could not be selected. */
  selectionNote?: string;
  /** The device actually selected for this operation, if any. */
  selected?: DiscoveredDevice;
  /** SSH private key the caller used, so printed follow-up commands re-use it. */
  identityFile?: string;
  /** Serial (USID) the reached device reported, when it could be read. */
  serial?: string;
  /** Serial the caller asked to verify, making a different unit a hard failure. */
  expectedSerial?: string;
}

/**
 * Turn discovery evidence into one explicit verdict with an actionable body.
 * The whole point is that a caller never sees a bare timeout: every failure
 * names the condition and the next step.
 */
export function diagnoseRoute(input: DiagnosisInput): RouteDecision {
  const { discovery, alias, authResult, selectionNote, selected, identityFile, serial, expectedSerial } = input;
  const targets = discovery.scanTargets.map((t) => `${t.network}/${t.prefix}`).join(", ") || "no scannable subnet";
  const ports = discovery.probedPorts.join("/");
  const layerText: Record<string, string> = {
    mDNS: `mDNS (${MDNS_HOST_CANDIDATES.join(", ")})`,
    "USB gadget": `USB gadget ${KINDLE_USB_HOST}`,
    "LAN sweep": `a scan of ${targets} on ports ${ports}`,
  };
  const ranLayers = discovery.layers.filter((layer) => layer.status !== "skipped");
  const skippedLayers = discovery.layers.filter((layer) => layer.status === "skipped");

  const kindleCandidates = uniqueDevicesByHost(discovery.devices.filter((device) => device.kindleLikely));
  const otherCandidates = discovery.devices.filter((device) => !device.kindleLikely);

  // A specific device was asked for and discovery could not supply it. Say that
  // instead of describing a different device's state as if it were this one's.
  if (selectionNote) {
    const anythingAnswered = kindleCandidates.length > 0 || otherCandidates.length > 0;
    return {
      state: "not-found",
      code: anythingAnswered ? 2 : 1,
      headline: selectionNote,
      body: [
        kindleCandidates.length > 0
          ? `Reachable Kindle(s): ${kindleCandidates.map((d) => `${d.host}:${d.port}`).join(", ")}.`
          : "No Kindle answered discovery at all on this run.",
        "",
        "Confirm the device is powered on with Wi-Fi connected and KOReader's SSH server started,",
        `then re-run: bin/lighthouse kindle-ssh find${identityArg(identityFile)}`,
      ],
    };
  }

  // An already-open port can still exist on a device whose daemon then refuses auth.
  if (kindleCandidates.length === 0 && otherCandidates.length === 0) {
    return {
      state: "not-found",
      code: 1,
      headline: `No ${alias} SSH route is reachable from this Mac mini.`,
      body: [
        `Checked: ${
          ranLayers.length
            ? ranLayers.map((layer) => layerText[layer.layer] ?? layer.layer).join(", ")
            : "nothing - every discovery layer was disabled"
        }.`,
        ...(skippedLayers.length
          ? [`Skipped: ${skippedLayers.map((layer) => `${layer.layer} (${layer.detail})`).join(", ")}.`]
          : []),
        ranLayers.some((layer) => layer.layer === "LAN sweep")
          ? `${discovery.scannedHosts} address(es) were probed on ${targets}; none is serving Kindle SSH on ${ports}.`
          : "No LAN sweep was run, so no address on those subnets was probed.",
        "",
        "If hosts are up but nothing answers those ports, the network is fine and the SSH daemon is not running:",
        "KOReader's SSH server only exists while KOReader runs.",
        "  On the Kindle: open KOReader -> Tools (wrench) -> SSH -> start the server.",
        `  Then re-run: bin/lighthouse kindle-ssh find${identityArg(identityFile)}`,
        "",
        "If no host answered at all, the device is off/asleep or not associated with Wi-Fi.",
        "",
        "Fallback that works with Wi-Fi off:",
        `  Plug the device in over USB-C and run: bin/lighthouse kindle-ssh usb${identityArg(identityFile)}`,
        "  (requires USB networking enabled on the device; see RUNBOOK.md, Kindle SSH section).",
      ],
    };
  }

  if (kindleCandidates.length === 0) {
    const names = otherCandidates
      .map((d) => `${d.host}:${d.port} (${d.server}${d.serverVersion ? ` ${d.serverVersion}` : ""})`)
      .join(", ");
    return {
      state: "not-found",
      code: 2,
      headline: `Something answered on the Kindle port, but it is not the Kindle SSH daemon.`,
      body: [
        `Responders found: ${names}`,
        "",
        `The Kindle route is served by dropbear, so an OpenSSH responder is a different host.`,
        `If the device really is up, confirm KOReader's SSH server is what is listening on ${ports}.`,
      ],
    };
  }

  const device = selected ?? kindleCandidates[0];

  if (authResult?.authenticated) {
    if (expectedSerial && serial !== expectedSerial) {
      return {
        state: "identity-mismatch",
        code: 2,
        headline: `${alias} answered at ${device.host}:${device.port} as ${serial ?? "an unreadable serial"}, not the expected ${expectedSerial}.`,
        body: [
          "The route works, but it reached a different unit than the one you asked to verify.",
          "The DHCP lease moves between the Kindles, so an address is not an identity.",
          `  bin/lighthouse kindle-ssh find${identityArg(identityFile)}`,
          "Match the serial above against the device you meant before trusting any result from this route.",
        ],
        device,
      };
    }
    return {
      state: "verified",
      code: 0,
      headline: `${alias} is reachable and key-authenticated at ${device.host}:${device.port}${
        serial ? ` (serial ${serial})` : ""
      }.`,
      body: serial
        ? []
        : ["The device did not report /proc/usid, so which Kindle answered is unconfirmed."],
      device,
    };
  }

  if (authResult?.timedOut) {
    return {
      state: "ssh-timeout",
      code: 2,
      headline: `${alias} answered at ${device.host}:${device.port}, but it did not finish the key check within the budget.`,
      body: [
        "The daemon is up and the route exists; the key state is simply unknown because the session ran out of time.",
        "A busy or sleeping device looks exactly like this, so do not reinstall the key on the strength of it.",
        "",
        "Re-run with a longer budget, or read the identity by hand:",
        `  bin/lighthouse kindle-ssh probe${routeArgs(device.host, device.port, identityFile)} --timeout 1500`,
        `  ssh -p ${device.port} -i ${identityFile ?? defaultIdentityFile()} -o BatchMode=yes -o StrictHostKeyChecking=accept-new root@${device.host} 'cat /proc/usid'`,
        "",
        `SSH said: ${authResult.error ?? `ssh did not finish within its budget`}`,
      ],
      device,
    };
  }

  if (authResult?.failure === "host-key") {
    return {
      state: "host-key-changed",
      code: 2,
      headline: `${alias} answered at ${device.host}:${device.port}, but not with the host key this Mac remembers.`,
      body: [
        "The SSH daemon is running; what changed is the host key this Mac has on file for that address.",
        "That is what a moved DHCP lease or a reflashed device looks like, and installing the key cannot fix it.",
        "",
        "Clear the stale entry, then re-run the probe to confirm which unit answers:",
        `  ssh-keygen -R '[${device.host}]:${device.port}'`,
        `  bin/lighthouse kindle-ssh probe${routeArgs(device.host, device.port, identityFile)}`,
        "",
        `SSH said: ${authResult.error ?? "Host key verification failed"}`,
      ],
      device,
    };
  }

  if (authResult?.failure === "connect") {
    return {
      state: "ssh-unreachable",
      code: 2,
      headline: `${alias} could not be reached at ${device.host}:${device.port}: the connection itself failed.`,
      body: [
        "The banner answered a moment ago, so the daemon is up but the session did not get through.",
        "This is a network or routing condition on this Mac, not an untrusted key, so installing the key again will not help.",
        "",
        "Re-run the probe, and if it persists check the route to that address:",
        `  bin/lighthouse kindle-ssh probe${routeArgs(device.host, device.port, identityFile)}`,
        `  route -n get ${device.host}`,
        "",
        `SSH said: ${authResult.error ?? "connection failed"}`,
      ],
      device,
    };
  }

  if (authResult && !authResult.authenticated) {
    return {
      state: "auth-failed",
      code: 2,
      headline: `${alias} answered at ${device.host}:${device.port} but key authentication failed.`,
      body: [
        `This is a route that exists but cannot log in yet: the SSH daemon is running, the key is not trusted.`,
        "",
        "Install this Mac mini's public key on the device (one time, while a route works):",
        `  bin/lighthouse kindle-ssh key${routeArgs(device.host, device.port, identityFile)}`,
        "",
        "If a password prompt is acceptable for that one step, do it by hand instead:",
        `  ssh -p ${device.port} root@${device.host} "LIGHTHOUSE_PUBKEY='$(cat ${identityFile ?? defaultIdentityFile()}.pub)' sh -s" < scripts/kindle-key-install.sh`,
        "",
        `SSH said: ${authResult.error ?? "authentication failed"}`,
      ],
      device,
    };
  }

  // A Kindle-banner responder implies the port was open; reaching here means
  // discovery succeeded but no authentication attempt was made for this run.
  return {
    state: "ssh-closed",
    code: 2,
    headline: `${alias} answered on ${device.host}:${device.port} but authentication was not verified.`,
    body: [
      "Run a full probe to attempt key authentication and capture the remote identity:",
      `  bin/lighthouse kindle-ssh probe${routeArgs(device.host, device.port, identityFile)}`,
    ],
    device,
  };
}

// ---------------------------------------------------------------------------
// SSH invocation
// ---------------------------------------------------------------------------

export interface SshTarget {
  host: string;
  port: number;
  user?: string;
  identityFile?: string;
  connectTimeoutSec?: number;
}

export function resolveDeviceAlias(raw: string | undefined): string {
  if (!raw) return "kindle1";
  const key = raw.trim().toLowerCase();
  return ALIASES[key] ?? key;
}

export function defaultIdentityFile(): string {
  return path.join(os.homedir(), ".ssh", "id_ed25519");
}

/** Single-quote a value for a shell command line. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** `--identity` fragment for a printed command, omitted when it is the default key. */
function identityArg(identityFile?: string): string {
  if (!identityFile || identityFile === defaultIdentityFile()) return "";
  return ` --identity ${identityFile}`;
}

/**
 * Address/port/identity fragment for a printed follow-up command, so pasting it
 * re-runs the route that was actually tried rather than discovery's defaults.
 */
function routeArgs(host: string | undefined, port: number, identityFile?: string): string {
  return `${host ? ` --host ${host}` : ""} --port ${port}${identityArg(identityFile)}`;
}

export function expandHome(file: string): string {
  if (file === "~") return os.homedir();
  if (file.startsWith("~/")) return path.join(os.homedir(), file.slice(2));
  return file;
}

/**
 * Build the exact ssh argv used by the wrapper.
 *
 * BatchMode=yes is what makes the "no password prompt" guarantee real: when the
 * key is not trusted, ssh fails immediately with a message instead of blocking
 * on a hidden prompt in an unattended context.
 */
export function buildSshArgs(target: SshTarget, remoteCommand?: string[]): string[] {
  const args = [
    "-p",
    String(target.port),
    "-i",
    target.identityFile ?? defaultIdentityFile(),
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `ConnectTimeout=${target.connectTimeoutSec ?? 8}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    `${target.user ?? "root"}@${target.host}`,
  ];
  if (remoteCommand && remoteCommand.length > 0) args.push(remoteCommand.join(" "));
  return args;
}

/** The copy-pasteable raw login command matching what the wrapper runs. */
export function formatRawSshCommand(target: SshTarget, remoteCommand?: string[]): string {
  const parts = ["ssh"];
  const args = buildSshArgs(target, remoteCommand);
  for (const arg of args) parts.push(/[\s'"$]/.test(arg) ? `'${arg.replace(/'/g, `'\\''`)}'` : arg);
  return parts.join(" ");
}

/** Suggested ~/.ssh/config block. Printed, never written by this tool. */
export function formatSshConfigBlock(alias: string, target: SshTarget): string {
  return [
    `Host ${alias}`,
    `    HostName ${target.host}`,
    `    Port ${target.port}`,
    `    User ${target.user ?? "root"}`,
    `    IdentityFile ${target.identityFile ?? defaultIdentityFile()}`,
    "    IdentitiesOnly yes",
    "    BatchMode yes",
    "    StrictHostKeyChecking accept-new",
    "    ConnectTimeout 8",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Key authentication check
// ---------------------------------------------------------------------------

export interface AuthCheck {
  authenticated: boolean;
  output?: string;
  error?: string;
  rawCommand: string;
  /** The ssh session was killed at its budget, so the key state is unknown. */
  timedOut: boolean;
  /** Why ssh failed, so the caller can name the right next step. */
  failure: SshFailure;
}

export type SshFailure = "none" | "timeout" | "host-key" | "connect" | "key";

/**
 * Separate what ssh actually said from "the key is untrusted": a changed host key
 * or a connect failure needs a different remedy, and reinstalling the key cannot
 * fix either of them.
 */
export function classifySshFailure(text: string, timedOut: boolean): SshFailure {
  if (timedOut) return "timeout";
  if (/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|POSSIBLE DNS SPOOFING|host key for .* has changed/i.test(text)) {
    return "host-key";
  }
  if (/permission denied|no matching (host key|key exchange)|publickey/i.test(text)) return "key";
  if (
    /connection timed out|operation timed out|no route to host|network is unreachable|connection refused|connection closed|connection reset|broken pipe/i.test(
      text,
    )
  ) {
    return "connect";
  }
  return "key";
}

export async function verifyKeyAuth(target: SshTarget, timeoutMs = 15000): Promise<AuthCheck> {
  const connectTimeoutSec = Math.max(2, Math.floor(timeoutMs / 1000) - 2);
  const args = buildSshArgs(
    { ...target, connectTimeoutSec },
    [`sh -c ${JSON.stringify(VERIFY_REMOTE_COMMAND)}`],
  );
  const rawCommand = formatRawSshCommand({ ...target, connectTimeoutSec }, [
    `sh -c ${JSON.stringify(VERIFY_REMOTE_COMMAND)}`,
  ]);
  const result = await runWithTimeout(SSH_BIN, args, timeoutMs);
  if (result.status === 0) {
    return { authenticated: true, output: result.stdout.trim(), rawCommand, timedOut: false, failure: "none" };
  }
  const sshText = (result.stderr || result.stdout || "ssh exited non-zero").trim().split("\n").slice(-3).join(" | ");
  const error = result.timedOut
    ? `ssh did not finish within ${timeoutMs} ms, so the key state is unknown (a busy or sleeping device looks like this, not like an untrusted key)`
    : sshText;
  return { authenticated: false, error, rawCommand, timedOut: result.timedOut, failure: classifySshFailure(error, result.timedOut) };
}

// ---------------------------------------------------------------------------
// USB route
// ---------------------------------------------------------------------------

export interface HardwarePort {
  name: string;
  device: string;
  mac?: string;
}

export function parseHardwarePorts(text: string): HardwarePort[] {
  const ports: HardwarePort[] = [];
  let current: Partial<HardwarePort> = {};
  for (const line of text.split("\n")) {
    const nameMatch = line.match(/^\s*Hardware Port:\s*(.+)$/);
    if (nameMatch) {
      if (current.name && current.device) ports.push(current as HardwarePort);
      current = { name: nameMatch[1].trim() };
      continue;
    }
    const deviceMatch = line.match(/^\s*Device:\s*(\S+)$/);
    if (deviceMatch) {
      current.device = deviceMatch[1].trim();
      continue;
    }
    const macMatch = line.match(/^\s*Ethernet Address:\s*([0-9a-f:]{17})$/i);
    if (macMatch) current.mac = macMatch[1].toLowerCase();
  }
  if (current.name && current.device) ports.push(current as HardwarePort);
  return ports;
}

/**
 * The Mac-side end of the Kindle USB link.
 *
 * The Amazon OUI is only ever a positive hint: the host end of the gadget on
 * this Mac carries a locally administered address (masked by ifconfig to
 * 02:00:...). Link evidence is therefore an address on the gadget's own /24, or
 * - before this Mac has been given that address - a link-local 169.254 address
 * on a newly appeared en* interface.
 */
export function findUsbLinkInterface(ifaces: IfaceAddr[]): IfaceAddr | undefined {
  const byAddress = ifaces.find((iface) => iface.address.startsWith(USB_LINK_PREFIX));
  if (byAddress) return byAddress;
  const byLinkLocal = ifaces.find(
    (iface) => /^en\d+$/.test(iface.name) && iface.address.startsWith("169.254."),
  );
  if (byLinkLocal) return byLinkLocal;
  return ifaces.find((iface) => (iface.mac ?? "").startsWith(AMAZON_OUI));
}

/**
 * Find the device's USB network gadget from the macOS hardware-port list.
 *
 * Only a port macOS itself names as an RNDIS/CDC/ECM gadget qualifies; a USB
 * Ethernet dongle serving the LAN is not the gadget.
 */
export function findUsbEthernetPort(ports: HardwarePort[]): HardwarePort | undefined {
  return ports.find((port) => /^en\d+$/.test(port.device) && /rndis|cdc|ecm|gadget/i.test(port.name));
}

export interface UsbStatus {
  gadgetInterface?: string;
  gadgetConnected: boolean;
  kindleDeviceMounted?: string;
  usbnetInstalled?: boolean;
  /** Port on the USB link that answered SSH; undefined when nothing answered. */
  sshPort?: number;
  probeDetail: string;
}

export function summarizeUsbStatus(input: {
  ifaces: IfaceAddr[];
  ports: HardwarePort[];
  mountedVolumes: string[];
  probes?: PortProbe[];
}): UsbStatus {
  const sshPort = input.probes?.find((probe) => probe.open)?.port;
  const gadgetInterface =
    findUsbLinkInterface(input.ifaces)?.name ?? findUsbEthernetPort(input.ports)?.device;

  const kindleVolume = input.mountedVolumes.find((volume) => /kindle/i.test(volume));
  let usbnetInstalled: boolean | undefined;
  if (kindleVolume) {
    const usbnetPath = path.join("/Volumes", kindleVolume, "usbnet");
    usbnetInstalled = fs.existsSync(usbnetPath);
  }

  const connected = gadgetInterface !== undefined || sshPort !== undefined;
  const probedPorts = input.probes?.map((probe) => probe.port) ?? KINDLE_USB_PORTS;

  let probeDetail: string;
  if (sshPort !== undefined) probeDetail = `${KINDLE_USB_HOST}:${sshPort} answered`;
  else if (gadgetInterface)
    probeDetail = `${gadgetInterface} looks like the USB link, but ${KINDLE_USB_HOST} did not answer on ${probedPorts.join("/")} (USB networking may be off on the device, or this adapter is not the gadget)`;
  else
    probeDetail = `no USB link evidence on this Mac (no address on ${USB_LINK_PREFIX}0/24, no 169.254 self-assigned en*, no RNDIS/CDC hardware port), so ${KINDLE_USB_HOST} is unreachable until the device starts its gadget and this Mac holds an address on that link`;

  return {
    gadgetInterface,
    gadgetConnected: connected,
    kindleDeviceMounted: kindleVolume,
    usbnetInstalled,
    sshPort,
    probeDetail,
  };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

export function formatDiscoveryReport(
  result: DiscoveryResult,
  device: string,
  host?: string,
  identityFile?: string,
): string {
  const lines: string[] = [];
  lines.push(`Kindle SSH discovery (${result.durationMs} ms, ${result.scannedHosts} host probes)`);
  lines.push("");

  for (const layer of result.layers) {
    const marker =
      layer.status === "found" ? "FOUND" : layer.status === "empty" ? "empty" : layer.status === "error" ? "ERROR" : "skip ";
    lines.push(`  [${marker}] ${layer.layer}: ${layer.detail}`);
  }

  lines.push("");
  if (result.devices.length === 0) {
    lines.push("No SSH responder found.");
    return lines.join("\n");
  }

  lines.push("Candidates:");
  for (const candidate of result.devices) {
    const verdict = candidate.kindleLikely ? "kindle (dropbear)" : `not kindle (${candidate.server})`;
    lines.push(`  ${candidate.host}:${candidate.port}  ${verdict}  via ${candidate.source}`);
    if (candidate.banner) lines.push(`      banner: ${candidate.banner}`);
  }

  const { selected, note } = selectKindle(result.devices, device, host);
  if (!selected) {
    if (note) {
      lines.push("");
      lines.push(note);
    }
    return lines.join("\n");
  }

  const target: SshTarget = { host: selected.host, port: selected.port, identityFile };
  lines.push("");
  lines.push(`Requested device: ${device} -> ${target.host}:${target.port}`);
  lines.push("Login command:");
  lines.push(`  ${formatRawSshCommand(target, ["uname -srm"])}`);
  lines.push("");
  lines.push("Wrapper:");
  lines.push(`  bin/lighthouse kindle-ssh connect --device ${device}${routeArgs(host, selected.port, identityFile)}`);
  lines.push("");
  lines.push("Optional pin (paste into ~/.ssh/config yourself; this tool never edits your config):");
  for (const line of formatSshConfigBlock(device, target).split("\n")) lines.push(`  ${line}`);
  return lines.join("\n");
}

export function formatUsbReport(status: UsbStatus, identityFile?: string): string {
  const lines: string[] = [];
  lines.push("Kindle USB-cable route (fallback for Wi-Fi off / KOReader closed)");
  lines.push("");
  lines.push(
    `  USB network adapter : ${
      status.gadgetInterface ??
      (status.sshPort !== undefined ? `unidentified (the link answered on ${KINDLE_USB_HOST}:${status.sshPort})` : "none detected")
    }`,
  );
  lines.push(`  Mass-storage volume : ${status.kindleDeviceMounted ? `/Volumes/${status.kindleDeviceMounted}` : "none mounted"}`);
  const usbnetLabel =
    status.usbnetInstalled === undefined ? "unknown (volume not mounted)" : status.usbnetInstalled ? "yes (/Volumes/<Kindle>/usbnet)" : "no";
  lines.push(`  USBNetwork present  : ${usbnetLabel}`);
  lines.push(`  Link state          : ${status.probeDetail}`);
  lines.push("");
  lines.push(`  Kindle address on the USB link: ${KINDLE_USB_HOST}`);
  lines.push(`  This Mac must take          : ${MAC_USB_HOST} / ${USB_NETMASK}`);
  lines.push("");

  if (status.sshPort !== undefined) {
    lines.push("Next:");
    lines.push(
      `  ssh -p ${status.sshPort} -i ${identityFile ?? defaultIdentityFile()} -o BatchMode=yes -o StrictHostKeyChecking=accept-new root@${KINDLE_USB_HOST} uname -srm`,
    );
    return lines.join("\n");
  }

  lines.push("Device-side steps (runtime only; nothing survives a reboot):");
  lines.push("  1. Switch the USB gadget from mass storage to ethernet: modprobe g_ether dev_addr=c0:8d:51:03:31:52");
  lines.push(`  2. Address and raise it: ip addr add ${KINDLE_USB_HOST}/24 dev usb0; ip link set usb0 up`);
  lines.push("  3. Start an SSH daemon outside KOReader (see RUNBOOK.md, 'Kindle SSH Device Access').");
  lines.push("");
  lines.push(`An address on ${USB_LINK_PREFIX}0/24 proves the link is up; before this Mac has one, a 169.254 self-assigned`);
  lines.push(`en* or an RNDIS/CDC hardware port is the hint. The adapter's MAC need not be Amazon's (${AMAZON_OUI}:...).`);
  lines.push("");
  lines.push("Mac-side steps:");
  lines.push("  Identify the gadget: networksetup -listallhardwareports | grep -A3 -i rndis");
  lines.push(`  macOS normally takes ${MAC_USB_HOST} by DHCP from the device; only if it does not:`);
  lines.push(`  sudo ifconfig <usb-iface> inet ${MAC_USB_HOST} netmask ${USB_NETMASK} up`);
  lines.push(`  ping -c 2 ${KINDLE_USB_HOST}`);
  lines.push("");
  lines.push("Full install/uninstall detail: RUNBOOK.md -> 'Kindle SSH Device Access' -> USB route.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  subcommand: string;
  device: string;
  /** Explicit address override; still verified by banner before use. */
  host?: string;
  json: boolean;
  mdns: boolean;
  usb: boolean;
  ports: number[];
  timeoutMs: number;
  remote: string[];
  identityFile: string;
  /** Serial (USID) the caller expects the reached device to report. */
  expectSerial?: string;
  /** Set when --device / --host were passed, so a subcommand that ignores them can refuse. */
  deviceGiven?: boolean;
  hostGiven?: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions | { help: true } | { error: string } {
  const options: CliOptions = {
    subcommand: "find",
    device: "kindle1",
    json: false,
    mdns: true,
    usb: true,
    ports: [KINDLE_SSH_PORT, KINDLE_ALT_SSH_PORT],
    timeoutMs: 400,
    remote: [],
    identityFile: defaultIdentityFile(),
  };
  const args = [...argv];
  if (args.length === 0) return { help: true };

  const first = args[0];
  if (first === "-h" || first === "--help" || first === "help") return { help: true };
  if (!["find", "probe", "connect", "key", "usb"].includes(first)) {
    return { error: `unknown subcommand: ${first}` };
  }
  options.subcommand = first;
  args.shift();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--json":
        options.json = true;
        break;
      case "--no-mdns":
        options.mdns = false;
        break;
      case "--no-usb":
        options.usb = false;
        break;
      case "--device":
      case "-d": {
        const raw = (args[++i] ?? "").trim();
        if (!raw) return { error: "--device requires a value (1, 2, kindle1 or kindle2)" };
        const alias = resolveDeviceAlias(raw);
        if (!/^kindle[12]$/.test(alias)) {
          return { error: `--device must be 1, 2, kindle1 or kindle2, got: ${raw}` };
        }
        options.device = alias;
        options.deviceGiven = true;
        break;
      }
      case "--host": {
        const value = args[++i] ?? "";
        if (!isValidIpv4(value)) return { error: `--host requires an IPv4 address, got: ${value}` };
        options.host = value;
        options.hostGiven = true;
        break;
      }
      case "--port":
      case "-p":
        options.ports = [Number(args[++i])];
        break;
      case "--timeout": {
        const value = Number(args[++i]);
        if (!Number.isFinite(value) || value <= 0) return { error: "--timeout requires a positive millisecond value" };
        options.timeoutMs = value;
        break;
      }
      case "--identity":
      case "-i": {
        const value = args[++i];
        if (!value || value.trim() === "") return { error: "--identity requires a private key path" };
        options.identityFile = expandHome(value);
        break;
      }
      case "--expect-serial": {
        const value = (args[++i] ?? "").trim();
        if (!/^[A-Za-z0-9]{6,}$/.test(value)) return { error: `--expect-serial requires a Kindle serial (USID), got: ${value}` };
        options.expectSerial = value.toUpperCase();
        break;
      }
      case "--":
        options.remote = args.slice(i + 1);
        i = args.length;
        break;
      case "-h":
      case "--help":
        return { help: true };
      default:
        if (arg.startsWith("-")) return { error: `unknown option: ${arg}` };
        // Bare argument after connect becomes a remote command word.
        options.remote.push(arg);
        break;
    }
  }

  if (options.ports.some((port) => !Number.isInteger(port) || port <= 0 || port > 65535)) {
    return { error: "--port must be an integer between 1 and 65535" };
  }

  if (options.expectSerial && (options.subcommand === "find" || options.subcommand === "usb")) {
    return {
      error: `--expect-serial cannot be checked by ${options.subcommand}: it never logs in. Use probe, connect or key.`,
    };
  }

  if (options.subcommand === "usb" && (options.deviceGiven || options.hostGiven)) {
    return { error: "usb reports the cable link only: --device and --host do not apply. Use probe or connect for a device." };
  }

  return options;
}

const HELP_TEXT = `LightHouse Kindle SSH access

Usage:
  bin/lighthouse kindle-ssh <subcommand> [options] [-- <remote command>]

Subcommands:
  find      Discover the device from live evidence and print the login command
  probe     Diagnose one device end to end (port, banner, key auth, identity)
  connect   Log in or run a remote command over the working route
  key       Install this Mac mini's public key on the device (idempotent)
  usb       Report the USB-cable fallback route and the exact steps to bring it up

Options:
  --device <1|2|kindle1|kindle2>  Which Kindle to target (1 = first found, 2 = second)
  --host <ipv4>                   Pin an exact address (still banner-verified)
  --expect-serial <usid>          probe/connect/key: fail if the unit that answers reports another serial
  --timeout <ms>                  Per-host TCP probe timeout (default: 400)
  --port <port>                   Probe a single SSH port instead of 2222 and 22
  --identity <path>               SSH private key (default: ~/.ssh/id_ed25519)
  --no-mdns                       Skip the mDNS discovery layer
  --no-usb                        Skip the USB-gadget discovery layer
  --json                          Machine-readable output

Exit codes:
  0  find: a Kindle responder was discovered; probe/connect/key: the route is verified; usb: the USB
     link answered
  1  find: nothing answered discovery; probe/connect/key: no device could be found
  2  probe/connect/key: device found but the route is not usable yet (SSH closed / key missing),
     a different serial than --expect-serial, a changed host key, a failed connection, or a key
     check that ran out of time (retry - do not reinstall the key);
     usb: the USB route is not up (no candidate link interface, or nothing answered)
  3  usage error
  connect -- <command> instead exits with the remote command's own status, as ssh does,
  and 255 if the wrapper killed it at its 120 s budget

Notes:
  * The wireless route exists ONLY while KOReader is running with its SSH server started.
  * Addresses are never assumed: the device is discovered, then verified by banner and shell.
  * Every address on the subnet is probed; Kindles drop ICMP, so no ping pre-filter is used.
  * BatchMode=yes means a missing key fails loudly instead of blocking on a password prompt.
`;

/**
 * One entry per physical device: the first endpoint recorded for each host.
 *
 * Discovery records endpoints (`host:port`), and one Kindle can answer on two
 * ports (KOReader's plugin on 2222, the USB-link daemon on 22). Indexing those
 * endpoints would make `--device 2` mean "the second port", not the second unit.
 */
export function uniqueDevicesByHost(devices: DiscoveredDevice[]): DiscoveredDevice[] {
  const seen = new Set<string>();
  const unique: DiscoveredDevice[] = [];
  for (const device of devices) {
    if (seen.has(device.host)) continue;
    seen.add(device.host);
    unique.push(device);
  }
  return unique;
}

/**
 * Pick which Kindle to act on.
 *
 * `--device 1` / `--device 2` select the first / second Kindle found, ordered by
 * address - an ordering label, not an identity: the DHCP lease moves, so which
 * unit is "1" can change between runs. The serial readback (`--expect-serial`)
 * is what pins a run to one physical unit. `--host` pins an address explicitly.
 * A selection is never asserted blindly: the chosen address still has to answer
 * with a dropbear banner before it is used.
 */
export function selectKindle(
  devices: DiscoveredDevice[],
  device: string,
  host?: string,
): { selected?: DiscoveredDevice; note?: string } {
  const kindles = uniqueDevicesByHost(devices.filter((entry) => entry.kindleLikely)).sort(
    (a, b) => ipv4ToInt(a.host) - ipv4ToInt(b.host),
  );

  if (host) {
    const match = kindles.find((entry) => entry.host === host);
    if (match) return { selected: match };
    if (kindles.length === 0) return { note: `${host} was requested but no Kindle answered discovery.` };
    return {
      selected: undefined,
      note: `${host} was requested but did not answer; found ${kindles.map((k) => k.host).join(", ")}.`,
    };
  }

  const index = /2$/.test(device) ? 1 : 0;
  if (kindles[index]) return { selected: kindles[index] };
  if (kindles.length === 0) return {};
  return {
    selected: undefined,
    note: `${device} was requested but only ${kindles.length} Kindle(s) answered (${kindles
      .map((k) => k.host)
      .join(", ")}).`,
  };
}

async function resolveTarget(options: CliOptions): Promise<{
  target?: SshTarget;
  selected?: DiscoveredDevice;
  discovery: DiscoveryResult;
  auth?: AuthCheck;
  note?: string;
}> {
  const discovery = await discoverKindle({
    ports: options.ports,
    timeoutMs: options.timeoutMs,
    mdns: options.mdns,
    includeUsb: options.usb,
  });

  const { selected, note } = selectKindle(discovery.devices, options.device, options.host);
  if (!selected) return { discovery, note };

  const target: SshTarget = {
    host: selected.host,
    port: selected.port,
    identityFile: options.identityFile,
  };
  const auth = await verifyKeyAuth(target, Math.max(10000, options.timeoutMs * 20));
  return { target, selected, discovery, auth, note };
}

/**
 * Turn whatever resolveTarget produced into one verdict.
 *
 * Every subcommand builds its decision here so the selected device and the
 * "you asked for a device that did not answer" note can never be dropped by
 * one command while another reports them.
 */
function decideRoute(options: CliOptions, resolved: Awaited<ReturnType<typeof resolveTarget>>): RouteDecision {
  return diagnoseRoute({
    discovery: resolved.discovery,
    alias: options.device,
    selected: resolved.selected,
    selectionNote: resolved.note,
    identityFile: options.identityFile,
    serial: parseSerialFromIdentity(resolved.auth?.output),
    expectedSerial: options.expectSerial,
    authResult: resolved.auth
      ? {
          authenticated: resolved.auth.authenticated,
          error: resolved.auth.error,
          output: resolved.auth.output,
          timedOut: resolved.auth.timedOut,
          failure: resolved.auth.failure,
        }
      : undefined,
  });
}

async function cmdFind(options: CliOptions): Promise<number> {
  const result = await discoverKindle({
    ports: options.ports,
    timeoutMs: options.timeoutMs,
    mdns: options.mdns,
    includeUsb: options.usb,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatDiscoveryReport(result, options.device, options.host, options.identityFile));
  }

  if (result.devices.some((device) => device.kindleLikely)) return 0;
  return 1;
}

async function cmdProbe(options: CliOptions): Promise<number> {
  const resolved = await resolveTarget(options);
  const { discovery, auth } = resolved;
  const decision = decideRoute(options, resolved);

  if (options.json) {
    console.log(JSON.stringify({ decision, discovery, auth }, null, 2));
    return decision.code;
  }

  console.log(`Device: ${options.device}`);
  console.log("");
  for (const layer of discovery.layers) {
    console.log(`  [${layer.status}] ${layer.layer}: ${layer.detail}`);
  }
  console.log("");
  console.log(decision.headline);
  for (const line of decision.body) console.log(line ? `  ${line}` : "");

  if (auth?.rawCommand) {
    console.log("");
    console.log("Command that was run:");
    console.log(`  ${auth.rawCommand}`);
  }
  if (auth?.authenticated && auth.output) {
    console.log("");
    console.log("Remote command output:");
    for (const line of auth.output.split("\n")) console.log(`  ${line}`);
  }
  return decision.code;
}

async function cmdConnect(options: CliOptions): Promise<number> {
  const resolved = await resolveTarget(options);
  const { target, auth } = resolved;
  const decision = decideRoute(options, resolved);

  if (!target || decision.state !== "verified") {
    console.error(decision.headline);
    for (const line of decision.body) console.error(line);
    return decision.code;
  }

  const remote = options.remote.length > 0 ? options.remote : [];
  if (remote.length === 0) {
    console.log(decision.headline);
    console.log("");
    console.log("Remote identity:");
    for (const line of (auth?.output ?? "").split("\n")) console.log(`  ${line}`);
    console.log("");
    console.log("Login command:");
    console.log(`  ${formatRawSshCommand(target)}`);
    return 0;
  }

  const args = buildSshArgs(target, remote);
  const result = await runWithTimeout(SSH_BIN, args, 120000);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.timedOut) {
    console.error(`The remote command was killed at this wrapper's 120 s budget; the route itself verified fine.`);
    console.error("For a long-running command, use ssh directly so it is not killed:");
    console.error(`  ${formatRawSshCommand(target, remote)}`);
    return 255;
  }
  return result.status ?? 2;
}

async function cmdKey(options: CliOptions): Promise<number> {
  const pubKeyPath = `${options.identityFile}.pub`;
  if (!fs.existsSync(pubKeyPath)) {
    console.error(`No public key at ${pubKeyPath}. Create one with: ssh-keygen -t ed25519`);
    return 3;
  }
  const installerPath = path.resolve(import.meta.dir, "kindle-key-install.sh");
  if (!fs.existsSync(installerPath)) {
    console.error(`Installer script missing: ${installerPath}`);
    return 3;
  }

  const resolved = await resolveTarget(options);
  const { target, auth } = resolved;
  if (!target) {
    const decision = decideRoute(options, resolved);
    console.error(decision.headline);
    for (const line of decision.body) console.error(line);
    return decision.code;
  }

  const identity = decideRoute(options, resolved);
  if (identity.state === "identity-mismatch") {
    console.error(identity.headline);
    for (const line of identity.body) console.error(line);
    return identity.code;
  }

  if (auth?.authenticated) {
    console.log(`${options.device} already accepts this key at ${target.host}:${target.port}; nothing to install.`);
    return 0;
  }

  // The key is not trusted yet, so this step needs password (or existing) auth.
  console.log(`Installing ${pubKeyPath} into ${target.host}:${target.port} (this may ask for the root password)...`);
  const publicKey = fs.readFileSync(pubKeyPath, "utf8").trim();
  const remote = `LIGHTHOUSE_PUBKEY=${shellQuote(publicKey)} sh -s`;
  const args = [
    "-p",
    String(target.port),
    "-l",
    "root",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `ConnectTimeout=10`,
    "-o",
    "PreferredAuthentications=password,publickey,keyboard-interactive",
    "-t",
    target.host,
    remote,
  ];

  const installer = fs.readFileSync(installerPath, "utf8");
  const result = await runWithTimeoutWithInput(SSH_BIN, args, 60000, installer);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const installerWrote = /^(INSTALLED|ALREADY_PRESENT) /m.test(result.stdout);

  const verify = await verifyKeyAuth(target, 15000);
  if (verify.authenticated) {
    const serial = parseSerialFromIdentity(verify.output);
    if (options.expectSerial && serial !== options.expectSerial) {
      console.error(
        `Key installed at ${target.host}:${target.port}, but that unit reported ${
          serial ?? "an unreadable serial"
        }, not the expected ${options.expectSerial}.`,
      );
      return 2;
    }
    console.log("");
    console.log(`Verified: key login now works at ${target.host}:${target.port}.`);
    console.log(`  ${formatRawSshCommand(target, ["uname -srm"])}`);
    return 0;
  }
  console.error("");
  if (result.timedOut) {
    console.error("The installer session did not finish within 60s, so whether the key was written is unknown.");
  } else if (verify.timedOut) {
    console.error("Key install finished, but the verification session ran out of time: the key state is unknown, not necessarily broken.");
  } else if (verify.failure === "host-key") {
    console.error("Key install finished, but the verification session was refused because that address now presents a different host key.");
    console.error(`  ssh-keygen -R '[${target.host}]:${target.port}'`);
  } else if (verify.failure === "connect") {
    console.error("Key install finished, but the verification session could not connect: the key state is unknown, not untrusted.");
  } else if (!installerWrote) {
    console.error("The installer did not report installing the key, so the key was almost certainly not written.");
  } else {
    console.error("Key install ran but key authentication still fails.");
  }
  console.error(`  ${verify.error ?? "unknown error"}`);
  console.error("Re-run the installer over an interactive session: scripts/kindle-key-install.sh");
  return 2;
}

function runWithTimeoutWithInput(
  command: string,
  args: string[],
  timeoutMs: number,
  input: string,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ stdout: "", stderr: String(error), status: null, timedOut: false });
      return;
    }
    const finish = (status: number | null, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, status, timedOut });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish(null, true);
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      stderr += String(error);
      finish(null);
    });
    child.once("close", (code) => finish(code));
    child.stdin?.end(input);
  });
}

async function cmdUsb(options: CliOptions): Promise<number> {
  const ifaces = readLiveInterfaces();
  const portsText = spawnSync("networksetup", ["-listallhardwareports"], { encoding: "utf8", timeout: 8000 });
  const hwPorts = portsText.stdout ? parseHardwarePorts(portsText.stdout) : [];
  const mountedVolumes = fs.existsSync("/Volumes") ? fs.readdirSync("/Volumes") : [];
  const probes = await Promise.all(
    options.ports.map((port) => probeTcp(KINDLE_USB_HOST, port, Math.max(600, options.timeoutMs))),
  );

  const status = summarizeUsbStatus({ ifaces, ports: hwPorts, mountedVolumes, probes });

  if (options.json) {
    console.log(JSON.stringify({ status, probes }, null, 2));
  } else {
    console.log(formatUsbReport(status, options.identityFile));
  }

  return status.sshPort !== undefined ? 0 : 2;
}

async function main(): Promise<number> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if ("help" in parsed) {
    console.log(HELP_TEXT);
    return 0;
  }
  if ("error" in parsed) {
    console.error(parsed.error);
    console.error("Run 'bin/lighthouse kindle-ssh --help' for usage.");
    return 3;
  }

  switch (parsed.subcommand) {
    case "find":
      return cmdFind(parsed);
    case "probe":
      return cmdProbe(parsed);
    case "connect":
      return cmdConnect(parsed);
    case "key":
      return cmdKey(parsed);
    case "usb":
      return cmdUsb(parsed);
    default:
      console.error(`unknown subcommand: ${parsed.subcommand}`);
      return 3;
  }
}

if ((import.meta as { main?: boolean }).main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error("Fatal:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
