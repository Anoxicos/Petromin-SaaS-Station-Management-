import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";

const issuer = process.env.AUTH_ISSUER;
const clientId = process.env.AUTH0_CLIENT_ID;
const clientSecret = process.env.AUTH0_CLIENT_SECRET;
const callbackUrl = process.env.AUTH0_CALLBACK_URL ?? "http://localhost:3000/auth/callback";
const audience = process.env.AUTH_AUDIENCE;
const clientKeys = issuer && clientId
  ? createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, "")}/.well-known/jwks.json`))
  : null;

function cookie(request: IncomingMessage, name: string): string | undefined {
  const cookies = request.headers.cookie?.split(";") ?? [];
  const pair = cookies.map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!pair) return undefined;
  try {
    return decodeURIComponent(pair.slice(name.length + 1));
  } catch {
    return undefined;
  }
}

function secureCookie(): string {
  return process.env.NODE_ENV === "production" ? "; Secure" : "";
}

function send(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

function configurationReady(): boolean {
  return Boolean(issuer && clientId && clientSecret && callbackUrl && audience && clientKeys);
}

export async function handleAuth0Login(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
  const url = new URL(request.url ?? "/", callbackUrl);
  if (url.pathname === "/login" && request.method === "GET") {
    if (!configurationReady()) {
      send(response, 503, "<!doctype html><title>Login unavailable</title><p>Auth0 login is not configured.</p>");
      return true;
    }
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const requestedReturn = url.searchParams.get("returnTo");
    const returnTo = requestedReturn && ["/app", "/admin/platform", "/"].includes(requestedReturn) ? requestedReturn : null;
    const domain = new URL(issuer!).origin;
    const authorize = new URL("/authorize", domain);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId!,
      redirect_uri: callbackUrl,
      scope: "openid profile email",
      audience: audience!,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    const flow = Buffer.from(JSON.stringify({ state, nonce, returnTo, codeVerifier })).toString("base64url");
    response.writeHead(302, {
      location: authorize.toString(),
      "cache-control": "no-store",
      "set-cookie": `station_oidc_flow=${flow}; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=300${secureCookie()}`,
    });
    response.end();
    return true;
  }

  if (url.pathname === "/auth/callback" && request.method === "GET") {
    if (!configurationReady()) {
      send(response, 503, "<!doctype html><title>Login unavailable</title><p>Auth0 login is not configured.</p>");
      return true;
    }
    const fail = (status: number, message: string) => {
      response.setHeader("set-cookie", `station_oidc_flow=; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=0${secureCookie()}`);
      send(response, status, `<!doctype html><title>Sign-in failed</title><h1>Sign-in failed</h1><p>${message}</p><a href="/login">Try again</a>`);
      return true;
    };
    const flowCookie = cookie(request, "station_oidc_flow");
    let flow: { state: string; nonce: string; returnTo?: string | null; codeVerifier?: string } | undefined;
    try {
      flow = flowCookie ? JSON.parse(Buffer.from(flowCookie, "base64url").toString("utf8")) as typeof flow : undefined;
    } catch {
      flow = undefined;
    }
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!flow || !state || flow.state !== state || !flow.codeVerifier) return fail(400, "The sign-in state check failed. Start again from this app.");
    if (url.searchParams.has("error") || !code) return fail(401, "Auth0 did not complete sign-in.");

    try {
      const tokensResponse = await fetch(`${new URL(issuer!).origin}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId!,
          client_secret: clientSecret!,
          code,
          redirect_uri: callbackUrl,
          code_verifier: flow.codeVerifier,
        }),
      });
      if (!tokensResponse.ok) return fail(401, "Auth0 could not exchange the sign-in response.");
      const tokens = await tokensResponse.json() as { access_token?: string; id_token?: string; expires_in?: number };
      if (!tokens.access_token || !tokens.id_token) return fail(401, "Auth0 returned an incomplete sign-in response.");
      const { payload } = await jwtVerify(tokens.id_token, clientKeys!, {
        issuer,
        audience: clientId,
        algorithms: ["RS256"],
      });
      if (payload.nonce !== flow.nonce || typeof payload.sub !== "string") {
        return fail(401, "The sign-in identity check failed.");
      }
      const maxAge = Math.min(Math.max(Number(tokens.expires_in ?? 3600), 60), 86_400);
      const cookies = [
        `station_access_token=${encodeURIComponent(tokens.access_token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureCookie()}`,
        `station_oidc_flow=; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=0${secureCookie()}`,
      ];
      if (flow.returnTo && ["/app", "/admin/platform", "/"].includes(flow.returnTo)) {
        response.writeHead(302, { location: flow.returnTo, "cache-control": "no-store", "set-cookie": cookies });
        response.end();
        return true;
      }
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "set-cookie": cookies,
      });
      response.end(`<!doctype html><title>Signed in</title><h1>Signed in</h1><p>Auth0 authenticated this account.</p><dl><dt>Subject</dt><dd>${escapeHtml(payload.sub)}</dd><dt>Email</dt><dd>${escapeHtml(typeof payload.email === "string" ? payload.email : "")}</dd><dt>Name</dt><dd>${escapeHtml(typeof payload.name === "string" ? payload.name : "")}</dd></dl><p><a href="/me">Open platform identity</a></p>`);
      return true;
    } catch {
      return fail(401, "Sign-in could not be verified.");
    }
  }

  if (url.pathname === "/logout" && request.method === "GET") {
    if (!configurationReady()) {
      response.writeHead(302, {
        location: "/",
        "cache-control": "no-store",
        "set-cookie": `station_access_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie()}`,
      });
      response.end();
      return true;
    }
    const returnTo = new URL("/", callbackUrl).origin;
    const domain = issuer ? new URL(issuer).origin : "";
    const logout = new URL("/v2/logout", domain);
    logout.search = new URLSearchParams({ client_id: clientId ?? "", returnTo }).toString();
    response.writeHead(302, {
      location: logout.toString(),
      "cache-control": "no-store",
      "set-cookie": `station_access_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie()}`,
    });
    response.end();
    return true;
  }

  return false;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

export function auth0AccessToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? cookie(request, "station_access_token");
}
