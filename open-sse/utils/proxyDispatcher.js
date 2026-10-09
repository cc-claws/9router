// Proxy dispatcher factory shared by the runtime fetch layer
// (open-sse/utils/proxyFetch.js) and the proxy-pool test endpoint
// (src/lib/network/proxyTest.js).
//
// undici's built-in ProxyAgent only implements HTTP/HTTPS `CONNECT` tunnels —
// it has no SOCKS support. For socks/socks4/socks4a/socks5/socks5h we build an
// undici Agent with a custom `connect` that tunnels through socks-proxy-agent.
//
// `insecure` mirrors the runtime's self-signed/MITM TLS fallback: it disables
// certificate verification for the origin connection (direct or per SOCKS).

const SOCKS_PROTOCOLS = new Set([
  "socks:",
  "socks4:",
  "socks4a:",
  "socks5:",
  "socks5h:",
]);

export function isSocksProxyUrl(proxyUrl) {
  try {
    return SOCKS_PROTOCOLS.has(new URL(proxyUrl).protocol);
  } catch {
    return false;
  }
}

let socksProxyAgentPromise = null;

// Lazily load socks-proxy-agent (optional at runtime — degrade gracefully).
async function loadSocksProxyAgent() {
  if (!socksProxyAgentPromise) {
    socksProxyAgentPromise = import("socks-proxy-agent")
      .then(
        (mod) =>
          mod?.SocksProxyAgent || mod?.default?.SocksProxyAgent || mod?.default
      )
      .catch((e) => {
        console.warn(
          `[ProxyDispatcher] socks-proxy-agent unavailable: ${e?.message || e}`
        );
        socksProxyAgentPromise = null;
        return null;
      });
  }
  return socksProxyAgentPromise;
}

/**
 * Build an undici-compatible `connect(opts, callback)` that establishes the
 * origin connection through a SOCKS proxy.
 *
 * undici calls the connector with
 * `{ host, hostname, protocol, port, servername, localAddress }` and expects a
 * Duplex socket (already TLS-wrapped for `https:` origins) on the callback.
 */
async function createSocksConnect(socksUrl, insecure = false) {
  const SocksProxyAgent = await loadSocksProxyAgent();
  if (!SocksProxyAgent) {
    throw new Error("socks-proxy-agent is not available");
  }

  const socksAgent = new SocksProxyAgent(socksUrl);

  return function socksConnect({ hostname, protocol, port, servername }, callback) {
    const secureEndpoint = protocol === "https:";
    let settled = false;
    const done = (err, socket) => {
      if (settled) return;
      settled = true;
      callback(err, socket);
    };

    // socks-proxy-agent only touches `req` to destroy it on timeout/TLS error.
    const req = { destroy() {} };
    const connectOpts = {
      host: hostname,
      port: port || (secureEndpoint ? 443 : 80),
      servername: servername || undefined,
      secureEndpoint,
      // Match undici's default connector so ALPN never negotiates h2 here.
      ALPNProtocols: ["http/1.1"],
      ...(insecure ? { rejectUnauthorized: false } : {}),
    };

    socksAgent
      .connect(req, connectOpts)
      .then((socket) => {
        if (typeof socket?.setNoDelay === "function") socket.setNoDelay(true);
        if (secureEndpoint) {
          // TLS handshake runs over the tunneled socket.
          socket.once("secureConnect", () => done(null, socket));
          socket.once("error", (err) => done(err));
        } else {
          // SOCKS socket is already connected; hand it over immediately.
          done(null, socket);
        }
      })
      .catch((err) => done(err));
  };
}

/**
 * Create an undici dispatcher for a proxy URL.
 * - socks / socks4 / socks4a / socks5 / socks5h -> undici Agent with a SOCKS connector
 * - http/https proxy -> undici ProxyAgent (CONNECT tunnel)
 * - no proxy + insecure -> direct undici Agent with verification disabled
 */
export async function createProxyDispatcher(proxyUrl, { insecure = false } = {}) {
  const { Agent, ProxyAgent } = await import("undici");

  if (isSocksProxyUrl(proxyUrl)) {
    const connect = await createSocksConnect(proxyUrl, insecure);
    return new Agent({ connect });
  }

  if (proxyUrl) {
    return new ProxyAgent({
      uri: proxyUrl,
      ...(insecure ? { requestTls: { rejectUnauthorized: false } } : {}),
    });
  }

  // No proxy but insecure TLS requested (direct connection fallback).
  return new Agent({
    connect: insecure ? { rejectUnauthorized: false } : undefined,
  });
}
