import { proxy as dashboardProxy } from "./dashboardGuard";
import {
  sessionFromRequest,
  decodeSessionCookie,
  isAccountProxyPath,
  isMimoTakeoverPath,
  takeoverUpstreamPath,
  proxyAccountRequest,
  runTakeover,
  attachSessionCookie,
  originOf,
} from "./lib/mimoLoginSession";

export default async function proxy(request) {
  // Xiaomi account session-login proxy (src/lib/mimoLoginSession.js).
  // Session state (region + accumulated cookie jar) travels in the httpOnly
  // 9r_mimo_login cookie — route handlers and this proxy run in separate
  // bundles, so module-level maps are NOT shared. As a fallback the session
  // can also arrive as ?__9r_sess= on the first proxied navigation (covers
  // browsers that drop the cookie on the opening popup request).
  const cookies = request.headers.get("cookie") || "";
  const hasSessionCookie = cookies.includes("9r_mimo_login=");
  const paramSession = request.nextUrl.searchParams.get("__9r_sess");
  const { pathname } = request.nextUrl;
  if (!hasSessionCookie && !paramSession && /^\/(fe\/|pass)/.test(pathname) && !pathname.startsWith("/_next")) {
    // Anomaly: a login-flow XHR arrived without the session — the classic
    // cause of silent SPA "Something went wrong" 404s. Narrow to login paths
    // so unrelated unknown routes don't spam this.
    console.log(`${new Date().toISOString().slice(11,23)} [mimo-login] no-session ${pathname} (cookie header: ${cookies ? cookies.slice(0, 80) : "<none>"})`);
  }
  if (hasSessionCookie || paramSession) {
    const sess = sessionFromRequest(request) || (paramSession ? decodeSessionCookie(paramSession) : null);
    if (sess) {
      const origin = originOf(request);
      try {
        if (isMimoTakeoverPath(pathname)) {
          const upstreamUrl = `${sess.upstreamBase}${takeoverUpstreamPath(pathname)}${request.nextUrl.search || ""}`;
          return attachSessionCookie(await runTakeover(sess, upstreamUrl, origin), sess);
        }
        if (isAccountProxyPath(pathname)) {
          return attachSessionCookie(await proxyAccountRequest(sess, request, origin), sess);
        }
      } catch (e) {
        console.log(`${new Date().toISOString().slice(11,23)} [mimo-login] proxy error:`, e?.message || e);
        return new Response("mimo login proxy error", { status: 502 });
      }
    } else {
      // Anomaly (should not happen in a healthy flow): cookie present but unparseable.
      console.log(`${new Date().toISOString().slice(11,23)} [mimo-login] session cookie undecodable — falling through (${pathname})`);
    }
  }

  // Cookie present but expired/invalid — clear it on the way past.
  if (hasSessionCookie) {
    const res = await dashboardProxy(request);
    const headers = new Headers(res.headers);
    headers.append("Set-Cookie", "9r_mimo_login=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  return dashboardProxy(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
