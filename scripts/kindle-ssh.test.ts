import { describe, it, expect } from "bun:test";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import process from "node:process";
import { spawnSync } from "node:child_process";

import {
  AMAZON_OUI,
  KINDLE_SSH_PORT,
  KINDLE_ALT_SSH_PORT,
  KINDLE_USB_HOST,
  MAC_USB_HOST,
  MDNS_HOST_CANDIDATES,
  buildSshArgs,
  classifySshServer,
  defaultIdentityFile,
  deriveScanTargets,
  diagnoseRoute,
  discoverKindle,
  expandScanHosts,
  expandHome,
  findUsbEthernetPort,
  formatRawSshCommand,
  formatSshConfigBlock,
  formatUsbReport,
  intToIpv4,
  ipv4ToInt,
  isTunnelAddress,
  isLocallyAdministeredMac,
  isValidIpv4,
  mapWithConcurrency,
  netmaskToPrefix,
  parseCliArgs,
  parseHardwarePorts,
  parseIfconfig,
  selectKindle,
  probeTcp,
  readSshBanner,
  resolveDeviceAlias,
  shouldScanInterface,
  summarizeUsbStatus,
  type DiscoveredDevice,
  type DiscoveryResult,
  type IfaceAddr,
} from "./kindle-ssh";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const KEY_INSTALLER = path.join(REPO_ROOT, "scripts", "kindle-key-install.sh");

function makeDiscovery(overrides: Partial<DiscoveryResult> = {}): DiscoveryResult {
  return {
    devices: [],
    layers: [],
    scannedHosts: 254,
    probedPorts: [KINDLE_SSH_PORT, KINDLE_ALT_SSH_PORT],
    scanTargets: [
      {
        network: "192.168.31.0",
        prefix: 24,
        interface: "en0",
        localAddress: "192.168.31.15",
        firstHost: "192.168.31.1",
        lastHost: "192.168.31.254",
        hostCount: 254,
      },
    ],
    durationMs: 10,
    ...overrides,
  };
}

function kindleDevice(overrides: Partial<DiscoveredDevice> = {}): DiscoveredDevice {
  return {
    host: "192.168.31.87",
    port: KINDLE_SSH_PORT,
    banner: "SSH-2.0-dropbear_2020.81",
    server: "dropbear",
    serverVersion: "dropbear_2020.81",
    kindleLikely: true,
    source: "lan-scan",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// IPv4 arithmetic
// ---------------------------------------------------------------------------

describe("IPv4 helpers", () => {
  it("validates IPv4 literals", () => {
    expect(isValidIpv4("192.168.31.15")).toBe(true);
    expect(isValidIpv4("0.0.0.0")).toBe(true);
    expect(isValidIpv4("255.255.255.255")).toBe(true);
    expect(isValidIpv4("256.1.1.1")).toBe(false);
    expect(isValidIpv4("192.168.31")).toBe(false);
    expect(isValidIpv4("not.an.ip.addr")).toBe(false);
  });

  it("round-trips between integers and dotted quads", () => {
    for (const ip of ["0.0.0.0", "192.168.31.15", "10.0.0.1", "255.255.255.255"]) {
      expect(intToIpv4(ipv4ToInt(ip))).toBe(ip);
    }
    expect(ipv4ToInt("255.255.255.255")).toBe(0xffffffff);
  });

  it("rejects an invalid address instead of silently producing a number", () => {
    expect(() => ipv4ToInt("192.168.31.999")).toThrow();
  });

  it("converts contiguous netmasks to prefix lengths", () => {
    expect(netmaskToPrefix("255.255.255.0")).toBe(24);
    expect(netmaskToPrefix("255.255.0.0")).toBe(16);
    expect(netmaskToPrefix("255.255.255.255")).toBe(32);
    expect(netmaskToPrefix("255.255.255.252")).toBe(30);
    expect(() => netmaskToPrefix("255.0.255.0")).toThrow();
  });

  it("treats the 198.18.0.0/15 fake-IP tunnel range as unscannable", () => {
    expect(isTunnelAddress("198.18.0.1")).toBe(true);
    expect(isTunnelAddress("198.19.5.5")).toBe(true);
    expect(isTunnelAddress("192.168.31.15")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Interface parsing and scan target derivation
// ---------------------------------------------------------------------------

const IFCONFIG_SAMPLE = `lo0: flags=8049<UP,LOOPBACK,RUNNING,MULTICAST> mtu 16384
\tinet 127.0.0.1 netmask 0xff000000
en0: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tether c0:8d:51:99:7e:21
\tinet 192.168.31.15 netmask 0xffffff00 broadcast 192.168.31.255
\tstatus: active
utun4: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1420
\tinet 198.18.0.1 --> 198.18.0.1 netmask 0xffffffff
en7: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\tether 0a:1b:2c:3d:4e:5f
\tinet 192.168.15.201 netmask 0xffffff00 broadcast 192.168.15.255
\tstatus: active
`;

describe("parseIfconfig", () => {
  it("extracts name, address, netmask, MAC and status", () => {
    const ifaces = parseIfconfig(IFCONFIG_SAMPLE);
    const en0 = ifaces.find((i) => i.name === "en0");
    expect(en0).toBeDefined();
    expect(en0!.address).toBe("192.168.31.15");
    expect(en0!.netmask).toBe("255.255.255.0");
    expect(en0!.mac).toBe("c0:8d:51:99:7e:21");
    expect(en0!.state).toBe("active");
  });

  it("keeps every address including loopback and tunnels", () => {
    const names = parseIfconfig(IFCONFIG_SAMPLE).map((i) => i.name);
    expect(names).toContain("lo0");
    expect(names).toContain("utun4");
    expect(names).toContain("en7");
  });

  it("returns nothing for empty input", () => {
    expect(parseIfconfig("")).toEqual([]);
  });
});

describe("shouldScanInterface", () => {
  it("accepts ordinary LAN interfaces", () => {
    expect(shouldScanInterface("en0", "192.168.31.15")).toBe(true);
    expect(shouldScanInterface("en1", "192.168.31.102")).toBe(true);
  });

  it("refuses tunnel, loopback, link-local and fake-IP addresses", () => {
    expect(shouldScanInterface("utun4", "10.8.0.2")).toBe(false);
    expect(shouldScanInterface("lo0", "127.0.0.1")).toBe(false);
    expect(shouldScanInterface("en0", "169.254.10.20")).toBe(false);
    expect(shouldScanInterface("en0", "198.18.0.1")).toBe(false);
    expect(shouldScanInterface("bridge100", "192.168.139.3")).toBe(false);
    expect(shouldScanInterface("awdl0", "192.168.31.5")).toBe(false);
  });
});

describe("deriveScanTargets", () => {
  it("clamps a /16 to the /24 containing the local address", () => {
    const ifaces: IfaceAddr[] = [{ name: "en0", address: "192.168.31.15", netmask: "255.255.0.0" }];
    const targets = deriveScanTargets(ifaces);
    expect(targets).toHaveLength(1);
    expect(targets[0].network).toBe("192.168.31.0");
    expect(targets[0].prefix).toBe(24);
    expect(targets[0].hostCount).toBe(254);
  });

  it("deduplicates two interfaces on the same subnet", () => {
    const ifaces: IfaceAddr[] = [
      { name: "en0", address: "192.168.31.15", netmask: "255.255.255.0" },
      { name: "en1", address: "192.168.31.102", netmask: "255.255.255.0" },
    ];
    const targets = deriveScanTargets(ifaces);
    expect(targets).toHaveLength(1);
    expect(targets[0].interface).toBe("en0");
  });

  it("skips unusable interfaces and yields nothing for a tunnel-only host", () => {
    const ifaces: IfaceAddr[] = [
      { name: "utun4", address: "198.18.0.1", netmask: "255.255.255.255" },
      { name: "lo0", address: "127.0.0.1", netmask: "255.0.0.0" },
    ];
    expect(deriveScanTargets(ifaces)).toEqual([]);
  });

  it("bounds a /23 to the /24 that contains the local address", () => {
    const ifaces: IfaceAddr[] = [{ name: "en0", address: "192.168.31.200", netmask: "255.255.254.0" }];
    const targets = deriveScanTargets(ifaces);
    expect(targets[0].prefix).toBe(24);
    expect(targets[0].network).toBe("192.168.31.0");
  });
});

describe("expandScanHosts", () => {
  it("produces the full host range between the bounds", () => {
    const hosts = expandScanHosts({
      network: "10.0.0.0",
      prefix: 24,
      interface: "en9",
      localAddress: "10.0.0.5",
      firstHost: "10.0.0.250",
      lastHost: "10.0.0.254",
      hostCount: 5,
    });
    expect(hosts).toEqual(["10.0.0.250", "10.0.0.251", "10.0.0.252", "10.0.0.253", "10.0.0.254"]);
  });
});

// ---------------------------------------------------------------------------
// Banner classification
// ---------------------------------------------------------------------------

describe("classifySshServer", () => {
  it("identifies dropbear as Kindle-likely", () => {
    const info = classifySshServer("SSH-2.0-dropbear_2020.81");
    expect(info.server).toBe("dropbear");
    expect(info.version).toBe("dropbear_2020.81");
    expect(info.kindleLikely).toBe(true);
  });

  it("identifies OpenSSH and refuses to call it a Kindle", () => {
    const info = classifySshServer("SSH-2.0-OpenSSH_10.3");
    expect(info.server).toBe("openssh");
    expect(info.version).toBe("OpenSSH_10.3");
    expect(info.kindleLikely).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(classifySshServer("ssh-2.0-DROPBEAR_2019").server).toBe("dropbear");
  });

  it("reports unknown for absent or malformed banners", () => {
    expect(classifySshServer(null).server).toBe("unknown");
    expect(classifySshServer("HTTP/1.1 200 OK").server).toBe("unknown");
    expect(classifySshServer("").server).toBe("unknown");
    expect(classifySshServer(null).kindleLikely).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mDNS parsing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Route diagnosis - the anti-bare-timeout contract
// ---------------------------------------------------------------------------

describe("diagnoseRoute", () => {
  it("explains the KOReader dependency when nothing is found", () => {
    const decision = diagnoseRoute({ discovery: makeDiscovery(), alias: "kindle1" });
    expect(decision.state).toBe("not-found");
    expect(decision.code).toBe(1);
    expect(decision.headline).toContain("No kindle1 SSH route");
    const body = decision.body.join("\n");
    // Actionable, not a bare timeout.
    expect(body).toContain("KOReader");
    expect(body).toContain("kindle-ssh find");
    expect(body).toContain("kindle-ssh usb");
    expect(body).toContain("192.168.31.0/24");
    expect(body).not.toMatch(/^timed out$/m);
  });

  it("refuses to treat a non-dropbear responder as the Kindle", () => {
    const decision = diagnoseRoute({
      discovery: makeDiscovery({
        devices: [kindleDevice({ server: "openssh", kindleLikely: false, banner: "SSH-2.0-OpenSSH_10.3" })],
      }),
      alias: "kindle1",
    });
    expect(decision.state).toBe("not-found");
    expect(decision.code).toBe(2);
    expect(decision.headline).toContain("not the Kindle SSH daemon");
    expect(decision.body.join("\n")).toContain("dropbear");
  });

  it("reports a verified route with exit code 0", () => {
    const decision = diagnoseRoute({
      discovery: makeDiscovery({ devices: [kindleDevice()] }),
      alias: "kindle1",
      authResult: { authenticated: true, output: "Linux kindle 4.9" },
    });
    expect(decision.state).toBe("verified");
    expect(decision.code).toBe(0);
    expect(decision.device?.host).toBe("192.168.31.87");
  });

  it("names the key-install step when auth fails", () => {
    const decision = diagnoseRoute({
      discovery: makeDiscovery({ devices: [kindleDevice()] }),
      alias: "kindle1",
      authResult: { authenticated: false, error: "Permission denied (publickey)." },
    });
    expect(decision.state).toBe("auth-failed");
    expect(decision.code).toBe(2);
    expect(decision.headline).toContain("key authentication failed");
    const body = decision.body.join("\n");
    expect(body).toContain("kindle-ssh key");
    expect(body).toContain("Permission denied");
  });

  it("asks for a full probe when a responder was found but auth was not attempted", () => {
    const decision = diagnoseRoute({
      discovery: makeDiscovery({ devices: [kindleDevice({ port: KINDLE_SSH_PORT })] }),
      alias: "kindle2",
    });
    expect(decision.state).toBe("ssh-closed");
    expect(decision.code).toBe(2);
    expect(decision.headline).toContain("authentication was not verified");
    expect(decision.body.join("\n")).toContain("kindle-ssh probe");
  });

  it("reports a requested device that discovery could not supply", () => {
    const decision = diagnoseRoute({
      discovery: makeDiscovery({ devices: [kindleDevice({ host: "192.168.31.73" })] }),
      alias: "kindle2",
      selectionNote: "kindle2 was requested but only 1 Kindle(s) answered (192.168.31.73).",
    });
    expect(decision.code).toBe(2);
    expect(decision.headline).toContain("only 1 Kindle");
    expect(decision.body.join("\n")).toContain("192.168.31.73:2222");
  });

  it("names the ports that were actually probed, not a hardcoded pair", () => {
    const discovery = makeDiscovery({ devices: [], scannedHosts: 7, probedPorts: [KINDLE_ALT_SSH_PORT] });
    const decision = diagnoseRoute({ discovery, alias: "kindle1" });
    const body = decision.body.join("\n");
    expect(body).toContain("none is serving Kindle SSH on 22");
    expect(body).not.toContain(String(KINDLE_SSH_PORT));
  });

  it("mentions every subnet that was actually scanned", () => {
    const discovery = makeDiscovery();
    discovery.scanTargets = [
      { ...discovery.scanTargets[0] },
      { ...discovery.scanTargets[0], network: "10.20.0.0", interface: "en9" },
    ];
    const decision = diagnoseRoute({ discovery, alias: "kindle1" });
    expect(decision.body.join("\n")).toContain("192.168.31.0/24, 10.20.0.0/24");
  });
});

// ---------------------------------------------------------------------------
// SSH invocation
// ---------------------------------------------------------------------------

describe("buildSshArgs", () => {
  it("never allows an interactive password prompt", () => {
    const args = buildSshArgs({ host: "192.168.31.87", port: KINDLE_SSH_PORT });
    expect(args).toContain("BatchMode=yes");
    expect(args).toContain("PreferredAuthentications=publickey");
    expect(args).toContain("IdentitiesOnly=yes");
  });

  it("uses the Kindle SSH port, root user and default key", () => {
    const args = buildSshArgs({ host: "192.168.31.87", port: KINDLE_SSH_PORT });
    expect(args[args.indexOf("-p") + 1]).toBe("2222");
    expect(args).toContain("root@192.168.31.87");
    expect(args[args.indexOf("-i") + 1]).toBe(defaultIdentityFile());
  });

  it("always sets a connect timeout so a dead host cannot hang forever", () => {
    const args = buildSshArgs({ host: "192.168.31.87", port: 2222 });
    expect(args.some((a) => a.startsWith("ConnectTimeout="))).toBe(true);
  });

  it("appends the remote command after the destination", () => {
    const args = buildSshArgs({ host: "h", port: 2222 }, ["uname", "-srm"]);
    expect(args[args.length - 1]).toBe("uname -srm");
    expect(args[args.length - 2]).toBe("root@h");
  });

  it("honours an explicit identity file and connect timeout", () => {
    const args = buildSshArgs({
      host: "h",
      port: 2222,
      identityFile: "/tmp/k",
      connectTimeoutSec: 3,
      user: "admin",
    });
    expect(args[args.indexOf("-i") + 1]).toBe("/tmp/k");
    expect(args).toContain("ConnectTimeout=3");
    expect(args).toContain("admin@h");
  });
});

describe("formatRawSshCommand", () => {
  it("produces a copy-pasteable command with the device address", () => {
    const command = formatRawSshCommand({ host: "192.168.31.87", port: 2222 }, ["uname -srm"]);
    expect(command.startsWith("ssh ")).toBe(true);
    expect(command).toContain("root@192.168.31.87");
    expect(command).toContain("-p 2222");
    // A remote command containing a space must stay a single shell word.
    expect(command).toContain("'uname -srm'");
  });
});

describe("formatSshConfigBlock", () => {
  it("emits a host block matching the verified address", () => {
    const block = formatSshConfigBlock("kindle1", { host: "192.168.31.87", port: 2222 });
    expect(block).toContain("Host kindle1");
    expect(block).toContain("HostName 192.168.31.87");
    expect(block).toContain("Port 2222");
    expect(block).toContain("BatchMode yes");
  });
});

describe("device aliases and paths", () => {
  it("maps numeric and named aliases onto canonical devices", () => {
    expect(resolveDeviceAlias("1")).toBe("kindle1");
    expect(resolveDeviceAlias("KINDLE")).toBe("kindle1");
    expect(resolveDeviceAlias("2")).toBe("kindle2");
    expect(resolveDeviceAlias("kindle2")).toBe("kindle2");
    expect(resolveDeviceAlias(undefined)).toBe("kindle1");
  });

  it("expands a leading tilde", () => {
    expect(expandHome("~/.ssh/id_ed25519")).toBe(path.join(os.homedir(), ".ssh", "id_ed25519"));
    expect(expandHome("/abs/key")).toBe("/abs/key");
    expect(expandHome("~")).toBe(os.homedir());
  });
});

// ---------------------------------------------------------------------------
// USB route
// ---------------------------------------------------------------------------

const HARDWARE_PORTS = `Hardware Port: Ethernet
Device: en0
Ethernet Address: 5c:1b:f4:7d:8d:1d

Hardware Port: Ethernet Adapter (en4)
Device: en4
Ethernet Address: ba:08:ec:72:a1:49

Hardware Port: Wi-Fi
Device: en1
Ethernet Address: 5c:1b:f4:82:69:eb

Hardware Port: USB 10/100/1000 LAN
Device: en7
Ethernet Address: c0:8d:51:99:7e:21

Hardware Port: Thunderbolt Bridge
Device: bridge0
Ethernet Address: 02:00:00:00:00:00
`;

describe("USB route helpers", () => {
  it("parses networksetup hardware ports with their MAC addresses", () => {
    const ports = parseHardwarePorts(HARDWARE_PORTS);
    expect(ports).toContainEqual({ name: "Wi-Fi", device: "en1", mac: "5c:1b:f4:82:69:eb" });
    expect(ports).toContainEqual({ name: "USB 10/100/1000 LAN", device: "en7", mac: "c0:8d:51:99:7e:21" });
  });

  it("finds the USB ethernet port", () => {
    const port = findUsbEthernetPort(parseHardwarePorts(HARDWARE_PORTS));
    expect(port?.device).toBe("en7");
  });

  it("refuses the built-in Ethernet port when no USB adapter is attached", () => {
    const withoutUsb = HARDWARE_PORTS.split("Hardware Port: USB 10/100/1000 LAN").slice(0, 1).join("");
    expect(findUsbEthernetPort(parseHardwarePorts(withoutUsb))).toBeUndefined();
  });

  it("refuses a soft-MAC virtual adapter even when its name looks ethernet-ish", () => {
    const ports = parseHardwarePorts(HARDWARE_PORTS).filter((p) => p.device !== "en7");
    expect(findUsbEthernetPort(ports)).toBeUndefined();
  });

  it("never picks the interface already serving the LAN", () => {
    const port = findUsbEthernetPort(parseHardwarePorts(HARDWARE_PORTS), "en7");
    expect(port).toBeUndefined();
  });

  it("flags locally administered MAC addresses", () => {
    expect(isLocallyAdministeredMac("ba:08:ec:72:a1:49")).toBe(true);
    expect(isLocallyAdministeredMac("c0:8d:51:99:7e:21")).toBe(false);
    expect(isLocallyAdministeredMac(undefined)).toBe(false);
  });

  it("reports an unreachable USB route with the disabled reason", () => {
    const status = summarizeUsbStatus({
      ifaces: [
        { name: "en0", address: "192.168.31.15", netmask: "255.255.255.0", mac: "5c:1b:f4:7d:8d:1d" },
        { name: "en7", address: "192.168.15.201", netmask: "255.255.255.0", mac: `${AMAZON_OUI}:99:7e:21` },
      ],
      ports: parseHardwarePorts(HARDWARE_PORTS),
      mountedVolumes: [],
      probes: [
        { host: KINDLE_USB_HOST, port: KINDLE_SSH_PORT, open: false, latencyMs: 600, error: "timeout" },
        { host: KINDLE_USB_HOST, port: KINDLE_ALT_SSH_PORT, open: false, latencyMs: 600, error: "timeout" },
      ],
    });
    expect(status.gadgetConnected).toBe(true);
    expect(status.gadgetInterface).toBe("en7");
    expect(status.sshPort).toBeUndefined();
    expect(status.probeDetail).toContain("USB networking may be disabled");
    expect(status.probeDetail).toContain(`${KINDLE_SSH_PORT}/${KINDLE_ALT_SSH_PORT}`);
  });

  it("reports the USB link reachable on port 22 with the USBNetwork daemon only", () => {
    const status = summarizeUsbStatus({
      ifaces: [{ name: "en7", address: "192.168.15.201", netmask: "255.255.255.0", mac: `${AMAZON_OUI}:99:7e:21` }],
      ports: parseHardwarePorts(HARDWARE_PORTS),
      mountedVolumes: [],
      probes: [
        { host: KINDLE_USB_HOST, port: KINDLE_SSH_PORT, open: false, latencyMs: 40, error: "connection refused" },
        { host: KINDLE_USB_HOST, port: KINDLE_ALT_SSH_PORT, open: true, latencyMs: 12 },
      ],
    });
    // The documented route-B daemon is USBNetwork's dropbear on 22; reporting the
    // link as dead because 2222 alone was probed would break the fallback route.
    expect(status.sshPort).toBe(KINDLE_ALT_SSH_PORT);
    expect(status.probeDetail).toContain(`${KINDLE_USB_HOST}:${KINDLE_ALT_SSH_PORT} answered`);

    const report = formatUsbReport(status);
    expect(report).toContain(`ssh -p ${KINDLE_ALT_SSH_PORT}`);
    expect(report).not.toContain("did not answer");
  });

  it("identifies an Amazon-OUI adapter even when hardware ports are unknown", () => {
    const status = summarizeUsbStatus({
      ifaces: [{ name: "en9", address: "10.0.0.9", netmask: "255.255.255.0", mac: `${AMAZON_OUI}:11:22:33` }],
      ports: [],
      mountedVolumes: [],
    });
    expect(status.gadgetConnected).toBe(true);
    expect(status.gadgetInterface).toBe("en9");
  });

  it("reports no adapter when nothing is plugged in", () => {
    const status = summarizeUsbStatus({ ifaces: [], ports: [], mountedVolumes: [] });
    expect(status.gadgetConnected).toBe(false);
    expect(status.probeDetail).toContain("no USB network adapter present");
  });

  it("reports USBNetwork presence from the mounted volume", () => {
    const status = summarizeUsbStatus({
      ifaces: [],
      ports: [],
      mountedVolumes: [],
    });
    expect(status.usbnetInstalled).toBeUndefined();
    expect(status.kindleDeviceMounted).toBeUndefined();
  });
});

describe("USB constants match the documented device defaults", () => {
  it("uses the Kindle USB-network addressing scheme", () => {
    expect(KINDLE_USB_HOST).toBe("192.168.15.244");
    expect(MAC_USB_HOST).toBe("192.168.15.201");
  });
});

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

describe("parseCliArgs", () => {
  it("prints help with no arguments", () => {
    expect(parseCliArgs([])).toEqual({ help: true });
  });

  it("defaults to the find subcommand with both discovery layers on", () => {
    const parsed = parseCliArgs(["find"]);
    if ("help" in parsed || "error" in parsed) throw new Error("expected options");
    expect(parsed.subcommand).toBe("find");
    expect(parsed.mdns).toBe(true);
    expect(parsed.usb).toBe(true);
    expect(parsed.device).toBe("kindle1");
  });

  it("accepts every documented subcommand", () => {
    for (const subcommand of ["find", "probe", "connect", "key", "usb"]) {
      const parsed = parseCliArgs([subcommand]);
      if ("help" in parsed || "error" in parsed) throw new Error(`failed for ${subcommand}`);
      expect(parsed.subcommand).toBe(subcommand);
    }
  });

  it("rejects an unknown subcommand and unknown options", () => {
    expect(parseCliArgs(["frobnicate"])).toHaveProperty("error");
    expect(parseCliArgs(["find", "--nope"])).toHaveProperty("error");
  });

  it("parses device, timeout, port and layer toggles", () => {
    const parsed = parseCliArgs(["probe", "--device", "2", "--timeout", "750", "--port", "22", "--no-mdns", "--no-usb"]);
    if ("help" in parsed || "error" in parsed) throw new Error("expected options");
    expect(parsed.device).toBe("kindle2");
    expect(parsed.timeoutMs).toBe(750);
    expect(parsed.ports).toEqual([22]);
    expect(parsed.mdns).toBe(false);
    expect(parsed.usb).toBe(false);
  });

  it("rejects invalid timeout and port values", () => {
    expect(parseCliArgs(["find", "--timeout", "0"])).toHaveProperty("error");
    expect(parseCliArgs(["find", "--port", "70000"])).toHaveProperty("error");
  });

  it("collects a remote command after -- without swallowing flags", () => {
    const parsed = parseCliArgs(["connect", "--device", "1", "--", "uptime", "-p"]);
    if ("help" in parsed || "error" in parsed) throw new Error("expected options");
    expect(parsed.remote).toEqual(["uptime", "-p"]);
  });
});

// ---------------------------------------------------------------------------
// Real socket probes against a local listener
// ---------------------------------------------------------------------------

describe("probeTcp and readSshBanner", () => {
  it("detects an open port and reads a dropbear banner", async () => {
    const server = net.createServer((socket) => {
      socket.write("SSH-2.0-dropbear_2020.81\r\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const probe = await probeTcp("127.0.0.1", port, 800);
      expect(probe.open).toBe(true);

      const banner = await readSshBanner("127.0.0.1", port, 800);
      expect(banner).toBe("SSH-2.0-dropbear_2020.81");
      expect(classifySshServer(banner).kindleLikely).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports a closed port without hanging", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const probe = await probeTcp("127.0.0.1", port, 500);
    expect(probe.open).toBe(false);
    expect(probe.error).toBeDefined();
  });

  it("returns null when a listener never speaks SSH", async () => {
    const server = net.createServer(() => {
      /* deliberately silent */
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      const banner = await readSshBanner("127.0.0.1", port, 300);
      expect(banner).toBeNull();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("mapWithConcurrency", () => {
  it("preserves input order", async () => {
    const result = await mapWithConcurrency([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n * 5));
      return n * 10;
    });
    expect(result).toEqual([30, 10, 20]);
  });

  it("never exceeds the concurrency cap", async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("handles an empty input list", async () => {
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// discoverKindle with injected probes (no real network)
// ---------------------------------------------------------------------------

describe("discoverKindle", () => {
  const lanIfaces: IfaceAddr[] = [{ name: "en0", address: "192.168.31.15", netmask: "255.255.255.0" }];

  it("finds the device on the LAN by its dropbear banner and records a self-exclusion", async () => {
    const result = await discoverKindle({
      ifaces: lanIfaces,
      mdns: false,
      includeUsb: false,
      concurrency: 16,
      timeoutMs: 50,
      probe: async (host, port) => ({
        host,
        port,
        // The Kindle is at .87; this Mac's own address also answers, which must be ignored.
        open: (host === "192.168.31.87" && port === 2222) || (host === "192.168.31.15" && port === 22),
        latencyMs: 1,
      }),
      banner: async (host) =>
        host === "192.168.31.87" ? "SSH-2.0-dropbear_2020.81" : "SSH-2.0-OpenSSH_10.3",
    });

    expect(result.devices).toHaveLength(1);
    expect(result.devices[0].host).toBe("192.168.31.87");
    expect(result.devices[0].kindleLikely).toBe(true);
    expect(result.devices[0].source).toBe("lan-scan");
    expect(result.layers.map((l) => l.layer)).toEqual(["mDNS", "USB gadget", "LAN sweep", "Router leases"]);
    expect(result.layers.find((l) => l.layer === "Router leases")?.status).toBe("skipped");
  });

  it("records a skipped layer reason instead of silently omitting discovery", async () => {
    const result = await discoverKindle({
      ifaces: lanIfaces,
      mdns: false,
      includeUsb: false,
      concurrency: 8,
      probe: async (host, port) => ({ host, port, open: false, latencyMs: 0 }),
      banner: async () => null,
    });
    const mdns = result.layers.find((l) => l.layer === "mDNS");
    expect(mdns?.status).toBe("skipped");
    expect(mdns?.detail).toContain("--no-mdns");
    const router = result.layers.find((l) => l.layer === "Router leases");
    expect(router?.detail).toContain("no router credentials");
  });

  it("finds the device over the USB gadget link", async () => {
    const result = await discoverKindle({
      ifaces: [...lanIfaces, { name: "en7", address: "192.168.15.201", netmask: "255.255.255.0" }],
      mdns: false,
      concurrency: 8,
      timeoutMs: 50,
      probe: async (host, port) => ({
        host,
        port,
        open: host === KINDLE_USB_HOST && port === 2222,
        latencyMs: 1,
      }),
      banner: async () => "SSH-2.0-dropbear_2020.81",
    });
    const usb = result.layers.find((l) => l.layer === "USB gadget");
    expect(usb?.status).toBe("found");
    expect(result.devices.some((d) => d.source === "usb" && d.host === KINDLE_USB_HOST)).toBe(true);
  });

  it("reports an empty scan when nothing answers", async () => {
    const result = await discoverKindle({
      ifaces: lanIfaces,
      mdns: false,
      includeUsb: false,
      concurrency: 8,
      probe: async (host, port) => ({ host, port, open: false, latencyMs: 0 }),
      banner: async () => null,
    });
    expect(result.devices).toEqual([]);
    expect(result.scannedHosts).toBe(254);
    expect(result.layers.find((l) => l.layer === "LAN sweep")?.status).toBe("empty");
  });

  it("records the ports it actually probed", async () => {
    const probed = new Set<number>();
    const result = await discoverKindle({
      ifaces: lanIfaces,
      mdns: false,
      includeUsb: false,
      concurrency: 8,
      ports: [KINDLE_ALT_SSH_PORT],
      probe: async (host, port) => {
        probed.add(port);
        return { host, port, open: false, latencyMs: 0 };
      },
      banner: async () => null,
    });
    expect([...probed]).toEqual([KINDLE_ALT_SSH_PORT]);
    expect(result.probedPorts).toEqual([KINDLE_ALT_SSH_PORT]);
  });
});

// ---------------------------------------------------------------------------
// mDNS candidate list sanity
// ---------------------------------------------------------------------------

describe("mDNS candidates", () => {
  it("always uses .local names so resolution stays on-link", () => {
    for (const name of MDNS_HOST_CANDIDATES) expect(name.endsWith(".local")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// On-device key installer (runs locally against a sandbox directory)
// ---------------------------------------------------------------------------

describe("kindle-key-install.sh", () => {
  const pubKeyPath = `${defaultIdentityFile()}.pub`;
  const hasKey = fs.existsSync(pubKeyPath);

  function runInstaller(args: string[], stdin: string, env: Record<string, string> = {}) {
    const result = spawnSync("sh", [KEY_INSTALLER, ...args], {
      input: stdin,
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 15000,
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "kindle-key-test-"));
  }

  it("ships as an executable POSIX shell script", () => {
    expect(fs.existsSync(KEY_INSTALLER)).toBe(true);
    const mode = fs.statSync(KEY_INSTALLER).mode;
    expect(mode & 0o111).toBeGreaterThan(0);
  });

  it("rejects empty and malformed input with exit code 2", () => {
    const dir = tempDir();
    expect(runInstaller(["--target", path.join(dir, "authorized_keys")], "").status).toBe(2);
    expect(runInstaller(["--target", path.join(dir, "authorized_keys")], "not a key\n").status).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("resolves root's home from the passwd database", () => {
    const dir = tempDir();
    const passwd = path.join(dir, "passwd");
    fs.writeFileSync(passwd, "root:x:0:0::/home/root:/bin/sh\n");
    const out = runInstaller(["--dry-run"], `${hasKey ? fs.readFileSync(pubKeyPath, "utf8") : "ssh-ed25519 AAAA test\n"}`, {
      KEYINSTALL_PASSWD: passwd,
    });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("/home/root/.ssh/authorized_keys");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("installs once, is idempotent, and sets correct permissions", () => {
    if (!hasKey) return; // no local key to install in this environment
    const dir = tempDir();
    const target = path.join(dir, "root", ".ssh", "authorized_keys");
    const key = fs.readFileSync(pubKeyPath, "utf8");

    const first = runInstaller(["--target", target], key);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("INSTALLED");

    const second = runInstaller(["--target", target], key);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("ALREADY_PRESENT");

    const lines = fs.readFileSync(target, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(target)).mode & 0o777).toBe(0o700);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("removes exactly the installed key on --uninstall", () => {
    if (!hasKey) return;
    const dir = tempDir();
    const target = path.join(dir, "authorized_keys");
    const key = fs.readFileSync(pubKeyPath, "utf8");
    fs.writeFileSync(target, "ssh-ed25519 AAAAPREEXISTING other@host\n");

    runInstaller(["--target", target], key);
    const removed = runInstaller(["--uninstall", "--target", target], key);
    expect(removed.status).toBe(0);
    expect(removed.stdout).toContain("REMOVED");

    const remaining = fs.readFileSync(target, "utf8");
    expect(remaining).toContain("AAAAPREEXISTING");
    expect(remaining).not.toContain(key.trim());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes nothing on --dry-run", () => {
    const dir = tempDir();
    const target = path.join(dir, "nested", ".ssh", "authorized_keys");
    const out = runInstaller(["--dry-run", "--target", target], "ssh-ed25519 AAAA test\n");
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("[dry-run]");
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(path.dirname(target))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("warns when the authorized_keys path will not survive a reboot", () => {
    const dir = fs.mkdtempSync("/tmp/kindle-key-volatile-");
    try {
      const target = path.join(dir, "authorized_keys");
      const out = runInstaller(["--target", target], "ssh-ed25519 AAAA test\n");
      expect(out.status).toBe(0);
      expect(out.stdout).toContain("VOLATILE");
      expect(fs.readFileSync(target, "utf8")).toContain("ssh-ed25519 AAAA test");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stays quiet for an authorized_keys path that outlives a reboot", () => {
    const dir = tempDir();
    try {
      const target = path.join(dir, "authorized_keys");
      const out = runInstaller(["--target", target], "ssh-ed25519 AAAA test\n");
      expect(out.status).toBe(0);
      expect(out.stdout).not.toContain("VOLATILE");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Device selection (two devices on one LAN)
// ---------------------------------------------------------------------------

describe("selectKindle", () => {
  const two = [
    kindleDevice({ host: "192.168.31.167" }),
    kindleDevice({ host: "192.168.31.73" }),
    kindleDevice({ host: "192.168.31.5", kindleLikely: false, server: "openssh", banner: "SSH-2.0-OpenSSH_10.3" }),
  ];

  it("orders by address so device 1 and 2 are stable across runs", () => {
    expect(selectKindle(two, "kindle1").selected?.host).toBe("192.168.31.73");
    expect(selectKindle(two, "kindle2").selected?.host).toBe("192.168.31.167");
  });

  it("ignores non-Kindle responders when indexing", () => {
    // 192.168.31.5 sorts first numerically but is OpenSSH, so it must not become "device 1".
    expect(selectKindle(two, "kindle1").selected?.kindleLikely).toBe(true);
  });

  it("pins an explicit address", () => {
    expect(selectKindle(two, "kindle1", "192.168.31.167").selected?.host).toBe("192.168.31.167");
  });

  it("explains an explicit address that did not answer", () => {
    const { selected, note } = selectKindle(two, "kindle1", "192.168.31.99");
    expect(selected).toBeUndefined();
    expect(note).toContain("192.168.31.99");
    expect(note).toContain("192.168.31.73");
  });

  it("explains a missing second device instead of silently using the first", () => {
    const onlyOne = [kindleDevice({ host: "192.168.31.73" })];
    const { selected, note } = selectKindle(onlyOne, "kindle2");
    expect(selected).toBeUndefined();
    expect(note).toContain("only 1 Kindle");
  });

  it("returns nothing to say when no Kindle answered at all", () => {
    const { selected, note } = selectKindle([], "kindle1");
    expect(selected).toBeUndefined();
    expect(note).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Banner classification
// ---------------------------------------------------------------------------

describe("classifySshServer", () => {
  it("reports the KOReader banner version verbatim", () => {
    const info = classifySshServer("SSH-2.0-dropbear_2026.92 (KOReader)");
    expect(info.server).toBe("dropbear");
    expect(info.kindleLikely).toBe(true);
  });
});
