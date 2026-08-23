// The Xbox Live token chain, dependency-free.
//
// This is the MSAL device-code path, and the choice matters twice over. It is the
// right shape for a television - the person types an 8-character code on their
// phone, no keyboard on the sofa - and it needs no proof-of-possession signing at
// all: no P-256 key to generate, no device token, no sisu round trip, no request
// signature. The alternative (XAL) buys nothing here and is several hundred lines
// of crypto to keep correct.
//
//   1. POST login.microsoftonline.com /consumers/oauth2/v2.0/devicecode  -> user_code
//   2. poll   login.microsoftonline.com /consumers/oauth2/v2.0/token     -> refresh_token
//   3. POST user.auth.xboxlive.com     /user/authenticate               -> XSTS user token
//   4. POST xsts.auth.xboxlive.com     /xsts/authorize                  -> relying-party token
//   5. POST <offering>.gssv-play-prod  /v2/login/user                    -> gsToken + regions
//
// Step 5's token is what every gssv API call is bearer-authenticated with, and its
// `offeringSettings.regions` is where the streaming host comes from.
const http = require("./http");
const store = require("./tokenstore");

// The public client id of the Xbox app family. It is not a secret (a device-code
// client cannot hold one) and it is what makes `xboxlive.signin` grantable.
const CLIENT_ID = "1f907974-e22b-4810-a9de-d9647380c97e";
const SCOPE = "xboxlive.signin openid profile offline_access";

const RP_XBOXLIVE = "http://xboxlive.com";
const RP_GSSV = "http://gssv.xboxlive.com/";

const OFFERING_CLOUD = "xgpuweb"; // Game Pass Ultimate
const OFFERING_CLOUD_F2P = "xgpuwebf2p"; // free-to-play only, where Ultimate is not sold
const OFFERING_HOME = "xhome"; // streaming from one's own console

// A failure the person on the sofa has to act on, separated from a transport error
// so the UI can say WHICH of the two it is. `code` is stable, the message is not.
// `Number(x) || fallback` swallows a legitimate zero, which is not academic here:
// an `expires_in` of 0 became a 15-minute deadline and an `interval` of 0 became
// 5 seconds, so a poll that should have stopped at once ran on.
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

class AuthError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.detail = detail;
  }
}

// XSTS refuses with a 401 carrying an XErr number, and the numbers mean entirely
// different things to do next: "sign in again" is wrong advice for an account that
// has no Xbox profile, and worse for a child account that needs a parent. Anything
// unlisted keeps its number so a log is still actionable.
const XERR = {
  2148916227: ["account_banned", "This Xbox account has been suspended."],
  2148916233: ["no_xbox_account", "This Microsoft account has no Xbox profile yet. Create one at xbox.com, then sign in again."],
  2148916234: ["terms_not_accepted", "The Xbox terms of service have not been accepted for this account."],
  2148916235: ["region_unsupported", "Xbox Live is not available in this account's country or region."],
  2148916236: ["adult_verification_required", "This account needs adult verification before it can be used."],
  2148916237: ["adult_verification_required", "This account needs adult verification before it can be used."],
  2148916238: ["child_account", "This is a child account. An adult in the family group has to add it to a family first."],
  2148916262: ["proof_of_possession_required", "Microsoft asked for a device-bound sign-in this client cannot do."],
  2148916265: ["account_maintenance", "The Xbox account service is under maintenance. Try again later."],
};

function xstsFailure(res) {
  const body = res.json() || {};
  const xerr = Number(body.XErr || 0);
  const known = XERR[xerr];
  if (known) return new AuthError(known[0], known[1], { xerr, redirect: body.Redirect });
  if (res.status === 401) return new AuthError("xsts_denied", "Xbox Live refused the sign-in (XErr " + (xerr || "unknown") + ").", { xerr });
  return new AuthError("xsts_failed", "Xbox Live authorization failed: " + http.describe(res), { status: res.status });
}

// ---------------------------------------------------------------- device code

async function startDeviceCodeAuth() {
  const res = await http.postForm("login.microsoftonline.com", "/consumers/oauth2/v2.0/devicecode", {}, {
    client_id: CLIENT_ID,
    scope: SCOPE,
  });
  const body = res.json();
  if (!res.ok || !body || !body.device_code) {
    throw new AuthError("devicecode_failed", "Could not start sign-in: " + http.describe(res), { status: res.status });
  }
  return {
    userCode: body.user_code,
    deviceCode: body.device_code,
    verificationUri: body.verification_uri,
    // Seconds. Microsoft's own value, not ours: the code really does stop working.
    expiresIn: num(body.expires_in, 900),
    interval: Math.max(1, num(body.interval, 5)),
  };
}

// Polls until the person finishes on their phone. Microsoft's `interval` is
// honoured and `slow_down` widens it - xal-node polls at a flat 1 s regardless,
// which is what earns that response in the first place.
//
// `signal` is an AbortSignal so leaving the sign-in screen actually stops the
// poll; an orphaned poll keeps a dead code alive for its full 15 minutes.
async function pollForDeviceCode(deviceCode, opts) {
  const o = opts || {};
  let interval = Math.max(1, num(o.interval, 5));
  const deadline = Date.now() + num(o.expiresIn, 900) * 1000;

  for (;;) {
    if (o.signal && o.signal.aborted) throw new AuthError("cancelled", "Sign-in cancelled.");
    if (Date.now() >= deadline) throw new AuthError("code_expired", "The sign-in code expired. Start again.");

    await sleep(interval * 1000, o.signal);
    if (o.signal && o.signal.aborted) throw new AuthError("cancelled", "Sign-in cancelled.");

    const res = await http.postForm("login.microsoftonline.com", "/consumers/oauth2/v2.0/token", {}, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: CLIENT_ID,
      device_code: deviceCode,
    });
    const body = res.json() || {};

    if (res.ok && body.refresh_token) return store.setUserToken(body);

    // The pending states are 400s with a body, which is exactly why http.js does
    // not reject on status.
    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5;
        continue;
      case "authorization_declined":
        throw new AuthError("declined", "Sign-in was declined on the phone.");
      case "expired_token":
        throw new AuthError("code_expired", "The sign-in code expired. Start again.");
      case "bad_verification_code":
        throw new AuthError("bad_code", "Microsoft did not recognise this sign-in request. Start again.");
      default:
        throw new AuthError("devicecode_failed", "Sign-in failed: " + (body.error_description || http.describe(res)), {
          status: res.status,
          error: body.error,
        });
    }
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// ---------------------------------------------------------------- token chain

async function refreshUserToken() {
  const user = store.getUserToken();
  if (!user || !user.refresh_token) throw new AuthError("not_signed_in", "No Xbox account on this box. Sign in first.");

  const res = await http.postForm("login.microsoftonline.com", "/consumers/oauth2/v2.0/token", {}, {
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: user.refresh_token,
    scope: SCOPE,
  });
  const body = res.json() || {};
  if (!res.ok || !body.refresh_token) {
    // A 400 here means the refresh token is dead (revoked, password changed, or
    // 90 days idle) and no retry can fix it - the person has to sign in again, so
    // say that rather than reporting a network failure.
    if (res.status === 400) {
      store.clear();
      throw new AuthError("reauth_required", "The Xbox sign-in expired. Sign in again.", { error: body.error });
    }
    throw new AuthError("refresh_failed", "Could not refresh the Xbox sign-in: " + http.describe(res), { status: res.status });
  }
  return store.setUserToken(body);
}

async function getAccessToken() {
  if (store.accessTokenIsFresh()) return store.getUserToken().access_token;
  return (await refreshUserToken()).access_token;
}

// Everything below is short-lived and stays in memory (see tokenstore.js).
const cache = { xstsUser: null, rp: {}, streaming: {} };
const expired = (t) => !t || !t.notAfter || t.notAfter - store.SKEW_SECONDS * 1000 <= Date.now();

async function getXstsUserToken() {
  if (!expired(cache.xstsUser)) return cache.xstsUser;

  const accessToken = await getAccessToken();
  const res = await http.postJson("user.auth.xboxlive.com", "/user/authenticate", {
    "x-xbl-contract-version": "1",
    "Cache-Control": "no-cache",
    Accept: "application/json",
  }, {
    Properties: { AuthMethod: "RPS", RpsTicket: "d=" + accessToken, SiteName: "user.auth.xboxlive.com" },
    RelyingParty: "http://auth.xboxlive.com",
    TokenType: "JWT",
  });
  if (!res.ok) throw xstsFailure(res);
  const body = res.json() || {};
  if (!body.Token) throw new AuthError("xsts_failed", "Xbox Live returned no user token.");

  cache.xstsUser = { token: body.Token, notAfter: Date.parse(body.NotAfter) || Date.now() + 3600e3 };
  return cache.xstsUser;
}

async function authorize(relyingParty) {
  if (!expired(cache.rp[relyingParty])) return cache.rp[relyingParty];

  const user = await getXstsUserToken();
  const res = await http.postJson("xsts.auth.xboxlive.com", "/xsts/authorize", {
    "x-xbl-contract-version": "1",
    "Cache-Control": "no-cache",
    Accept: "application/json",
  }, {
    Properties: { SandboxId: "RETAIL", UserTokens: [user.token] },
    RelyingParty: relyingParty,
    TokenType: "JWT",
  });
  if (!res.ok) throw xstsFailure(res);
  const body = res.json() || {};
  if (!body.Token) throw new AuthError("xsts_failed", "Xbox Live returned no token for " + relyingParty + ".");

  const xui = (body.DisplayClaims && body.DisplayClaims.xui && body.DisplayClaims.xui[0]) || {};
  cache.rp[relyingParty] = {
    token: body.Token,
    userHash: xui.uhs || "",
    gamertag: xui.gtg || "",
    xuid: xui.xid || "",
    notAfter: Date.parse(body.NotAfter) || Date.now() + 3600e3,
  };
  return cache.rp[relyingParty];
}

// The gssv token, i.e. the credential every streaming API call carries. Its
// `offeringSettings.regions` also decides which host those calls go to, so this
// response is configuration as much as it is a credential.
async function getStreamingToken(offering) {
  const cached = cache.streaming[offering];
  if (cached && cached.expiresAt - store.SKEW_SECONDS * 1000 > Date.now()) return cached;

  const gssv = await authorize(RP_GSSV);
  const res = await http.postJson(offering + ".gssv-play-prod.xboxlive.com", "/v2/login/user", {
    "x-gssv-client": "XboxComBrowser",
    Accept: "application/json",
    "Cache-Control": "no-store, must-revalidate, no-cache",
  }, { token: gssv.token, offeringId: offering });

  if (!res.ok) {
    throw new AuthError(
      res.status === 401 || res.status === 403 ? "offering_unavailable" : "streaming_token_failed",
      "Could not get a streaming token for " + offering + ": " + http.describe(res),
      { status: res.status, offering },
    );
  }
  const body = res.json() || {};
  if (!body.gsToken) throw new AuthError("streaming_token_failed", "The streaming token response carried no gsToken.", { offering });

  const regions = (body.offeringSettings && body.offeringSettings.regions) || [];
  const token = {
    offering,
    gsToken: body.gsToken,
    market: body.market || "",
    regions,
    // The default region is the one Microsoft picked for this account; the rest
    // are ordered fallbacks and are what a region override would choose among.
    host: hostOf(regions.find((r) => r.isDefault) || regions[0]),
    expiresAt: Date.now() + num(body.durationInSeconds, 0) * 1000,
  };
  if (!token.host) throw new AuthError("streaming_token_failed", "The streaming token offered no region to connect to.", { offering });

  cache.streaming[offering] = token;
  return token;
}

// `baseUri` is a full URL and every gssv path is appended to its HOST, so take
// the hostname rather than string-concatenating onto the URL.
function hostOf(region) {
  if (!region || !region.baseUri) return "";
  try {
    return new URL(region.baseUri).hostname;
  } catch {
    return "";
  }
}

// Game Pass Ultimate first, free-to-play second: a country where Ultimate is not
// sold still streams the f2p titles, and greenlight's own order proves the 401
// there is a "not for sale here" rather than a broken sign-in.
async function getCloudStreamingToken() {
  try {
    return await getStreamingToken(OFFERING_CLOUD);
  } catch (e) {
    if (e.code !== "offering_unavailable") throw e;
    return await getStreamingToken(OFFERING_CLOUD_F2P);
  }
}

// A session reaching state `ReadyToConnect` wants this - a Passport transfer
// token ("lpt"), which is a DIFFERENT credential from everything above and comes
// from login.live.com rather than the MSAL endpoint. Without it the session sits
// in that state until it times out.
async function getTransferToken() {
  const user = store.getUserToken();
  if (!user || !user.refresh_token) throw new AuthError("not_signed_in", "No Xbox account on this box. Sign in first.");

  const res = await http.postForm("login.live.com", "/oauth20_token.srf", {}, {
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    scope: "service::http://Passport.NET/purpose::PURPOSE_XBOX_CLOUD_CONSOLE_TRANSFER_TOKEN",
    refresh_token: user.refresh_token,
  });
  const body = res.json() || {};
  if (!res.ok || !body.access_token) {
    throw new AuthError("transfer_token_failed", "Could not get the session transfer token: " + http.describe(res), { status: res.status });
  }
  return { lpt: body.access_token, userId: body.user_id || "" };
}

async function getWebToken() {
  return authorize(RP_XBOXLIVE);
}

function signOut() {
  store.clear();
  cache.xstsUser = null;
  cache.rp = {};
  cache.streaming = {};
}

module.exports = {
  AuthError,
  CLIENT_ID,
  OFFERING_CLOUD,
  OFFERING_CLOUD_F2P,
  OFFERING_HOME,
  startDeviceCodeAuth,
  pollForDeviceCode,
  refreshUserToken,
  getAccessToken,
  getXstsUserToken,
  authorize,
  getStreamingToken,
  getCloudStreamingToken,
  getTransferToken,
  getWebToken,
  signOut,
  isSignedIn: store.hasAccount,
  _cache: cache, // test seam
};
