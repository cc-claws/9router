/**
 * SOCKS support for the proxy pool / outbound proxy path.
 *
 * undici's ProxyAgent only speaks HTTP CONNECT; SOCKS proxies are handled by a
 * custom undici Agent built on socks-proxy-agent (open-sse/utils/proxyDispatcher.js).
 * These tests spin up a minimal local SOCKS5 server (with user/pass auth) plus a
 * local HTTP origin and verify the real request path works end to end.
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import selfsigned from "selfsigned";
import { Agent as UndiciAgent, ProxyAgent as UndiciProxyAgent, fetch as undiciFetch } from "undici";
import {
  createProxyDispatcher,
  isSocksProxyUrl,
} from "open-sse/utils/proxyDispatcher.js";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { testProxyUrl } from "../../src/lib/network/proxyTest.js";

// ─── Minimal SOCKS5 server (RFC 1928) supporting no-auth or user/pass ────────
function createSocks5Server({ username, password } = {}) {
  const requireAuth = Boolean(username || password);

  return net.createServer((socket) => {
    let stage = "greeting";
    let buffer = Buffer.alloc(0);

    const parse = () => {
      if (stage === "greeting") {
        if (buffer.length < 2) return;
        const nmethods = buffer[1];
        if (buffer.length < 2 + nmethods) return;
        const methods = buffer.subarray(2, 2 + nmethods);
        buffer = buffer.subarray(2 + nmethods);

        const wantMethod = requireAuth ? 0x02 : 0x00;
        if (!methods.includes(wantMethod)) {
          socket.end(Buffer.from([0x05, 0xff]));
          return;
        }
        socket.write(Buffer.from([0x05, wantMethod]));
        stage = requireAuth ? "auth" : "request";
        return parse();
      }

      if (stage === "auth") {
        if (buffer.length < 2) return;
        const ulen = buffer[1];
        if (buffer.length < 2 + ulen + 1) return;
        const plen = buffer[2 + ulen];
        if (buffer.length < 3 + ulen + plen) return;
        const user = buffer.subarray(2, 2 + ulen).toString();
        const pass = buffer.subarray(3 + ulen, 3 + ulen + plen).toString();
        buffer = buffer.subarray(3 + ulen + plen);

        if (user !== username || pass !== password) {
          socket.end(Buffer.from([0x01, 0x01]));
          return;
        }
        socket.write(Buffer.from([0x01, 0x00]));
        stage = "request";
        return parse();
      }

      if (stage === "request") {
        if (buffer.length < 4) return;
        const atyp = buffer[3];
        let host;
        let port;
        let offset;

        if (atyp === 0x01) {
          if (buffer.length < 10) return;
          host = `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`;
          port = buffer.readUInt16BE(8);
          offset = 10;
        } else if (atyp === 0x03) {
          const len = buffer[4];
          if (buffer.length < 7 + len) return;
          host = buffer.subarray(5, 5 + len).toString();
          port = buffer.readUInt16BE(5 + len);
          offset = 7 + len;
        } else {
          socket.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }

        const leftover = buffer.subarray(offset);
        stage = "pipe";
        socket.removeAllListeners("data");

        const upstream = net.connect(port, host, () => {
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          if (leftover.length) upstream.write(leftover);
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
        return;
      }
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      parse();
    });
    socket.on("error", () => {});
  });
}

const openServers = [];
const openDispatchers = [];

function track(list, item) {
  list.push(item);
  return item;
}

async function startOrigin() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("socks-ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return track(openServers, server);
}

async function startTlsOrigin() {
  const pems = await selfsigned.generate(
    [{ name: "commonName", value: "localhost" }],
    { days: 1, keySize: 2048, algorithm: "sha256" }
  );
  const server = https.createServer(
    { key: pems.private, cert: pems.cert },
    (req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("socks-tls-ok");
    }
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return track(openServers, server);
}

async function startSocks(opts) {
  const server = createSocks5Server(opts);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return track(openServers, server);
}

function portOf(server) {
  return server.address().port;
}

afterEach(async () => {
  await Promise.all(
    openDispatchers.splice(0).map((d) => d?.close?.().catch(() => {}))
  );
  await Promise.all(
    openServers.splice(0).map((s) => new Promise((resolve) => s.close(resolve)))
  );
});

describe("isSocksProxyUrl", () => {
  it("detects socks schemes and rejects http/https", () => {
    expect(isSocksProxyUrl("socks5://u:p@127.0.0.1:1080")).toBe(true);
    expect(isSocksProxyUrl("socks5h://127.0.0.1:1080")).toBe(true);
    expect(isSocksProxyUrl("socks4://127.0.0.1:1080")).toBe(true);
    expect(isSocksProxyUrl("socks4a://127.0.0.1:1080")).toBe(true);
    expect(isSocksProxyUrl("http://127.0.0.1:8080")).toBe(false);
    expect(isSocksProxyUrl("https://127.0.0.1:8080")).toBe(false);
    expect(isSocksProxyUrl("not a url")).toBe(false);
  });
});

describe("createProxyDispatcher", () => {
  it("returns ProxyAgent for http and a SOCKS Agent for socks5", async () => {
    const httpDispatcher = track(
      openDispatchers,
      await createProxyDispatcher("http://127.0.0.1:8080")
    );
    expect(httpDispatcher).toBeInstanceOf(UndiciProxyAgent);

    const socksDispatcher = track(
      openDispatchers,
      await createProxyDispatcher("socks5://127.0.0.1:1080")
    );
    expect(socksDispatcher).toBeInstanceOf(UndiciAgent);
    expect(socksDispatcher).not.toBeInstanceOf(UndiciProxyAgent);
  });
});

describe("SOCKS5 end-to-end", () => {
  it("connects to an HTTP origin through an authenticated SOCKS5 proxy", async () => {
    const origin = await startOrigin();
    const socks = await startSocks({ username: "uyrao8Ne", password: "omEbLyzk6V" });

    const dispatcher = track(
      openDispatchers,
      await createProxyDispatcher(
        `socks5://uyrao8Ne:omEbLyzk6V@127.0.0.1:${portOf(socks)}`
      )
    );

    const res = await undiciFetch(`http://127.0.0.1:${portOf(origin)}/`, { dispatcher });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("socks-ok");
  });

  it("routes through the runtime proxyAwareFetch path", async () => {
    const origin = await startOrigin();
    const socks = await startSocks({ username: "user", password: "pass" });

    const res = await proxyAwareFetch(`http://127.0.0.1:${portOf(origin)}/`, {}, {
      connectionProxyEnabled: true,
      connectionProxyUrl: `socks5://user:pass@127.0.0.1:${portOf(socks)}`,
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("socks-ok");
  });

  it("is usable by the proxy-pool test helper", async () => {
    const origin = await startOrigin();
    const socks = await startSocks({ username: "user", password: "pass" });

    const result = await testProxyUrl({
      proxyUrl: `socks5://user:pass@127.0.0.1:${portOf(socks)}`,
      testUrl: `http://127.0.0.1:${portOf(origin)}/`,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it("upgrades https origins over the SOCKS5 tunnel", async () => {
    const origin = await startTlsOrigin();
    const socks = await startSocks({ username: "user", password: "pass" });

    const dispatcher = track(
      openDispatchers,
      await createProxyDispatcher(`socks5://user:pass@127.0.0.1:${portOf(socks)}`)
    );

    // Self-signed origin — trust is not what we are testing here, the TLS-over-
    // SOCKS upgrade is.
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    try {
      const res = await undiciFetch(`https://127.0.0.1:${portOf(origin)}/`, { dispatcher });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("socks-tls-ok");
    } finally {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  });
});
