/**
 * One-time script to get your Google OAuth refresh token.
 *
 * Reads CLIENT_ID + CLIENT_SECRET from credentials/google-oauth.json,
 * spins up a local HTTP server, prints the auth URL, waits for redirect,
 * then writes the refresh token into .env.local.
 *
 * Run with: deno run --allow-net --allow-read --allow-write --allow-env scripts/get-google-tokens.ts
 */

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const CRED_PATH = "credentials/google-oauth.json";
const ENV_PATH = ".env.local";

// Load credentials
const credText = await Deno.readTextFile(CRED_PATH);
const cred = JSON.parse(credText).installed;
const clientId: string = cred.client_id;
const clientSecret: string = cred.client_secret;

const scopes = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",          // for sending SMS via email-to-SMS gateway
  "https://www.googleapis.com/auth/calendar.readonly",
].join(" ");

const authUrl =
  `https://accounts.google.com/o/oauth2/auth` +
  `?client_id=${encodeURIComponent(clientId)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(scopes)}` +
  `&access_type=offline` +
  `&prompt=consent`;

console.log("\n=== AUTH URL ===");
console.log(authUrl);
console.log("=== END AUTH URL ===\n");
console.log(`Waiting for OAuth redirect on ${REDIRECT_URI} ...`);

// Promise that resolves when we capture the code
let resolveCode: (code: string) => void;
const codePromise = new Promise<string>((res) => (resolveCode = res));

const server = Deno.serve({ port: PORT, onListen: () => {} }, (req) => {
  const url = new URL(req.url);
  if (url.pathname !== "/oauth2callback") {
    return new Response("Not found", { status: 404 });
  }
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");
  if (err) {
    return new Response(`OAuth error: ${err}. You can close this tab.`, { status: 400 });
  }
  if (!code) {
    return new Response("Missing code", { status: 400 });
  }
  // Defer resolution so the HTTP response goes out first
  setTimeout(() => resolveCode(code), 50);
  return new Response(
    `<html><body style="font-family:system-ui;padding:2em;background:#111;color:#eee">
      <h2>✓ Alfred is authorized</h2>
      <p>You can close this tab. The script is finishing up in your terminal.</p>
    </body></html>`,
    { headers: { "content-type": "text/html" } },
  );
});

const code = await codePromise;
console.log("Got authorization code, exchanging for refresh token...");

const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  }),
});

const tokens = await tokenRes.json();

if (!tokens.refresh_token) {
  console.error("\n❌ Failed to get refresh_token. Response:");
  console.error(JSON.stringify(tokens, null, 2));
  await server.shutdown();
  Deno.exit(1);
}

// Update .env.local — replace GOOGLE_REFRESH_TOKEN line
let env = "";
try {
  env = await Deno.readTextFile(ENV_PATH);
} catch {
  // file may not exist; we'll create it
}

if (env.includes("GOOGLE_REFRESH_TOKEN=")) {
  env = env.replace(/GOOGLE_REFRESH_TOKEN=.*/m, `GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
} else {
  env += `\nGOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`;
}
await Deno.writeTextFile(ENV_PATH, env);

console.log("\n✅ Success! Refresh token saved to .env.local");
console.log(`   GOOGLE_REFRESH_TOKEN=${tokens.refresh_token.slice(0, 12)}... (redacted)`);
console.log("\nWhen you reach Step 8 of ALFRED-MANUAL.md, run:");
console.log(`  supabase secrets set GOOGLE_REFRESH_TOKEN=$(grep ^GOOGLE_REFRESH_TOKEN .env.local | cut -d= -f2)`);

await server.shutdown();
Deno.exit(0);
