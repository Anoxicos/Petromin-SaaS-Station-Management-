import assert from "node:assert/strict";
import { createServer } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const clientId = "station-test-client";
const clientSecret = "local-test-secret";
const audience = "https://station-api.test";
const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048 });
const { privateKey: unrelatedPrivateKey } = await generateKeyPair("RS256", { modulusLength: 2048 });
const jwk = await exportJWK(publicKey);
jwk.kid = "station-flow-test-key";
jwk.use = "sig";
jwk.alg = "RS256";

let currentNonce = "";
let tokenMode = "valid";
let tokenCalls = 0;
const provider = createServer(async (request, response) => {
  if (request.url === "/.well-known/jwks.json") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [jwk] }));
    return;
  }
  if (request.url === "/oauth/token" && request.method === "POST") {
    tokenCalls += 1;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const form = new URLSearchParams(Buffer.concat(chunks).toString());
    assert.equal(form.get("client_id"), clientId);
    assert.equal(form.get("client_secret"), clientSecret);
    assert.equal(form.get("redirect_uri"), callbackUrl);
    assert.equal(form.get("code_verifier"), currentCodeVerifier, "code exchange must present the original PKCE verifier");
    if (tokenMode === "exchange-error") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }
    const idToken = await new SignJWT({
      nonce: tokenMode === "wrong-nonce" ? "incorrect-nonce" : currentNonce,
      email: "pilot@example.invalid",
      name: "<script>alert(1)</script>",
    }).setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .setIssuer(tokenMode === "wrong-issuer" ? `${issuer}wrong` : issuer)
      .setAudience(tokenMode === "wrong-audience" ? "https://unexpected-audience.test" : clientId)
      .setSubject("auth0|station-flow-test")
      .setIssuedAt()
      .setExpirationTime("2m")
      .sign(tokenMode === "wrong-signature" ? unrelatedPrivateKey : privateKey);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ access_token: "local-test-access-token", id_token: idToken, expires_in: 3600 }));
    return;
  }
  if (request.url?.startsWith("/v2/logout")) {
    response.writeHead(200);
    response.end("logged out");
    return;
  }
  response.writeHead(404);
  response.end();
});

await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerAddress = provider.address();
const issuer = `http://127.0.0.1:${providerAddress.port}/`;
let auth0;
let callbackUrl;
let currentCodeVerifier = "";
const app = createServer(async (request, response) => {
  if (request.url === "/__test/access-token") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(auth0.auth0AccessToken(request) ?? "");
    return;
  }
  if (await auth0.handleAuth0Login(request, response)) return;
  response.writeHead(404);
  response.end();
});

try {
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  const appAddress = app.address();
  const base = `http://127.0.0.1:${appAddress.port}`;
  callbackUrl = `${base}/auth/callback`;
  process.env.AUTH_ISSUER = issuer;
  process.env.AUTH0_CLIENT_ID = clientId;
  process.env.AUTH0_CLIENT_SECRET = clientSecret;
  process.env.AUTH0_CALLBACK_URL = callbackUrl;
  process.env.AUTH_AUDIENCE = audience;
  auth0 = await import("../src/infrastructure/auth0-login.ts");

  async function begin(returnTo) {
    const suffix = returnTo === undefined ? "" : `?returnTo=${encodeURIComponent(returnTo)}`;
    const response = await fetch(`${base}/login${suffix}`, { redirect: "manual" });
    assert.equal(response.status, 302, "login should redirect to the configured OIDC provider");
    const authorization = new URL(response.headers.get("location"));
    assert.equal(authorization.origin, new URL(issuer).origin);
    assert.equal(authorization.pathname, "/authorize");
    assert.equal(authorization.searchParams.get("client_id"), clientId);
    assert.equal(authorization.searchParams.get("audience"), audience);
    assert.equal(authorization.searchParams.get("response_type"), "code");
    const cookieHeader = response.headers.get("set-cookie");
    assert.match(cookieHeader ?? "", /HttpOnly/);
    assert.match(cookieHeader ?? "", /SameSite=Lax/);
    assert.match(cookieHeader ?? "", /Path=\/auth\/callback/);
    currentNonce = authorization.searchParams.get("nonce");
    assert.match(authorization.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    const flow = JSON.parse(Buffer.from(cookieHeader.split(";")[0].slice("station_oidc_flow=".length), "base64url").toString("utf8"));
    currentCodeVerifier = flow.codeVerifier;
    assert.match(currentCodeVerifier, /^[A-Za-z0-9_-]{43}$/);
    const { createHash } = await import("node:crypto");
    const expectedChallenge = createHash("sha256").update(currentCodeVerifier).digest("base64url");
    assert.equal(authorization.searchParams.get("code_challenge"), expectedChallenge);
    return {
      state: authorization.searchParams.get("state"),
      cookie: cookieHeader.split(";")[0],
      setCookie: cookieHeader,
    };
  }

  async function callback(flow, query) {
    return fetch(`${base}/auth/callback?${query}`, {
      headers: { cookie: flow.cookie },
      redirect: "manual",
    });
  }

  tokenCalls = 0;
  const protectedFlow = await begin("/app");
  const wrongState = await callback(protectedFlow, `code=test-code&state=${encodeURIComponent(`${protectedFlow.state}-wrong`)}`);
  assert.equal(wrongState.status, 400, "state mismatch must be rejected");
  assert.equal(tokenCalls, 0, "state mismatch must not exchange an authorization code");
  console.log("PASS OIDC state validation before token exchange");

  tokenMode = "wrong-nonce";
  const nonceFlow = await begin("/app");
  const wrongNonce = await callback(nonceFlow, `code=test-code&state=${encodeURIComponent(nonceFlow.state)}`);
  assert.equal(wrongNonce.status, 401, "nonce mismatch must be rejected");
  assert.match(wrongNonce.headers.get("set-cookie") ?? "", /Max-Age=0/);
  tokenMode = "valid";
  console.log("PASS OIDC nonce validation and failed-flow cookie clearing");

  for (const [mode, label] of [
    ["wrong-issuer", "issuer"],
    ["wrong-audience", "audience"],
    ["wrong-signature", "signature"],
  ]) {
    tokenMode = mode;
    const invalidFlow = await begin("/app");
    const invalidToken = await callback(invalidFlow, `code=test-code&state=${encodeURIComponent(invalidFlow.state)}`);
    assert.equal(invalidToken.status, 401, `invalid JWT ${label} must be rejected`);
    assert.match(invalidToken.headers.get("set-cookie") ?? "", /Max-Age=0/);
    console.log(`PASS JWT ${label} validation`);
  }
  tokenMode = "valid";

  const acceptedFlow = await begin("/app");
  const accepted = await callback(acceptedFlow, `code=test-code&state=${encodeURIComponent(acceptedFlow.state)}`);
  assert.equal(accepted.status, 302);
  assert.equal(accepted.headers.get("location"), "/app");
  const authCookies = accepted.headers.getSetCookie();
  assert.equal(authCookies.length, 2);
  assert.match(authCookies[0], /^station_access_token=/);
  assert.match(authCookies[0], /HttpOnly/);
  assert.match(authCookies[0], /SameSite=Lax/);
  assert.match(authCookies[0], /Path=\//);
  assert.match(authCookies[0], /Max-Age=3600/);
  assert.match(authCookies[1], /station_oidc_flow=/);
  assert.match(authCookies[1], /Max-Age=0/);
  assert.equal(await (await fetch(`${base}/__test/access-token`, { headers: { cookie: `${authCookies[0].split(";")[0]}` } })).text(), "local-test-access-token");
  console.log("PASS allowlisted app return, HTTP-only access cookie, and flow-cookie clearing");

  const logout = await fetch(`${base}/logout`, {
    headers: { cookie: authCookies[0].split(";")[0] },
    redirect: "manual",
  });
  assert.equal(logout.status, 302);
  const logoutUrl = new URL(logout.headers.get("location"));
  assert.equal(logoutUrl.origin, new URL(issuer).origin);
  assert.equal(logoutUrl.pathname, "/v2/logout");
  assert.equal(logoutUrl.searchParams.get("client_id"), clientId);
  assert.equal(logoutUrl.searchParams.get("returnTo"), new URL(base).origin);
  assert.match(logout.headers.get("set-cookie") ?? "", /^station_access_token=/);
  assert.match(logout.headers.get("set-cookie") ?? "", /HttpOnly/);
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
  console.log("PASS logout provider return and access-cookie clearing");

  const directFlow = await begin(undefined);
  const direct = await callback(directFlow, `code=test-code&state=${encodeURIComponent(directFlow.state)}`);
  assert.equal(direct.status, 200, "direct login should retain the identity bootstrap page");
  const identityPage = await direct.text();
  assert.match(identityPage, /auth0\|station-flow-test/);
  assert.match(identityPage, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(identityPage, /<script>alert\(1\)<\/script>/);
  console.log("PASS direct identity bootstrap page and HTML escaping");

  const externalFlow = await begin("https://outside.example/collect");
  const external = await callback(externalFlow, `code=test-code&state=${encodeURIComponent(externalFlow.state)}`);
  assert.equal(external.status, 200, "external return destinations must not become redirects");
  assert.equal(external.headers.get("location"), null);
  console.log("PASS external return URL rejection");

  tokenMode = "exchange-error";
  const failedExchangeFlow = await begin("/app");
  const failedExchange = await callback(failedExchangeFlow, `code=test-code&state=${encodeURIComponent(failedExchangeFlow.state)}`);
  assert.equal(failedExchange.status, 401);
  assert.match(await failedExchange.text(), /could not exchange/);
  tokenMode = "valid";
  console.log("PASS authorization-code exchange failure handling");

  process.env.NODE_ENV = "production";
  const secureFlow = await begin("/admin/platform");
  assert.match(secureFlow.setCookie, /; Secure/);
  const secureCallback = await callback(secureFlow, `code=test-code&state=${encodeURIComponent(secureFlow.state)}`);
  assert.equal(secureCallback.status, 302);
  assert.ok(secureCallback.headers.getSetCookie().every((cookie) => cookie.includes("; Secure")));
  delete process.env.NODE_ENV;
  console.log("PASS Secure cookie flag in production mode");
} finally {
  await new Promise((resolve) => app.close(resolve));
  await new Promise((resolve) => provider.close(resolve));
}
