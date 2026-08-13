import { createHmac, randomUUID } from "node:crypto";

const REQUIRED_SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "chat:write",
  "im:history",
  "im:read",
  "im:write",
  "users:read",
];

const SLACK_WEBHOOK_PATH = "/api/agents/agent/channels/slack/webhook";
const DEFAULT_MASTRA_BASE_URL = "http://127.0.0.1:4111";

function requireSlackCredential(name) {
  const value = process.env[name]?.trim();

  if (!value || /^(?:\*+|\.+|replace|your-)/i.test(value)) {
    throw new Error(`Slack setup check failed: ${name} is missing or still a placeholder.`);
  }

  return value;
}

function resolveMastraBaseUrl() {
  const cliArguments = process.argv.slice(2).filter((argument) => argument !== "--");
  const namedBaseUrl = cliArguments
    .find((argument) => argument.startsWith("--base-url="))
    ?.split("=", 2)[1];
  const positionalBaseUrl = cliArguments.find((argument) => !argument.startsWith("--"));
  const configuredBaseUrl =
    namedBaseUrl ||
    positionalBaseUrl ||
    process.env.MASTRA_PUBLIC_URL?.trim() ||
    DEFAULT_MASTRA_BASE_URL;
  const baseUrl = new URL(configuredBaseUrl);

  if (!["http:", "https:"].includes(baseUrl.protocol)) {
    throw new Error("Slack setup check failed: Mastra base URL must use HTTP or HTTPS.");
  }

  return baseUrl;
}

async function verifySlackBotScopes(botToken) {
  const response = await fetch("https://slack.com/api/auth.test", {
    headers: { authorization: `Bearer ${botToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();

  if (!response.ok || body.ok !== true) {
    throw new Error(
      `Slack setup check failed: Slack bot authentication returned ${body.error ?? response.status}.`,
    );
  }

  const grantedScopes = new Set(
    (response.headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
  );

  if (grantedScopes.size === 0) {
    console.warn(
      "WARN Slack bot authenticated, but Slack did not return OAuth scope headers. Check scopes manually.",
    );
    return;
  }

  const missingScopes = REQUIRED_SLACK_BOT_SCOPES.filter((scope) => !grantedScopes.has(scope));
  if (missingScopes.length > 0) {
    throw new Error(`Slack setup check failed: missing bot scopes: ${missingScopes.join(", ")}.`);
  }

  console.log(
    `PASS Slack bot authentication and ${REQUIRED_SLACK_BOT_SCOPES.length} required scopes`,
  );
}

function createSignedSlackHeaders(signingSecret, body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");

  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${signature}`,
  };
}

async function verifySlackWebhook(baseUrl, signingSecret) {
  const webhookUrl = new URL(SLACK_WEBHOOK_PATH, baseUrl);
  const challenge = `mastra-slack-check-${randomUUID()}`;
  const body = JSON.stringify({ type: "url_verification", challenge });

  const unsignedResponse = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  if (unsignedResponse.status !== 401) {
    throw new Error(
      `Slack setup check failed: unsigned webhook request returned ${unsignedResponse.status}; expected 401.`,
    );
  }

  console.log("PASS Slack webhook rejects unsigned requests");

  const signedResponse = await fetch(webhookUrl, {
    method: "POST",
    headers: createSignedSlackHeaders(signingSecret, body),
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const responseText = await signedResponse.text();
  let responseBody;

  try {
    responseBody = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Slack setup check failed: signed webhook returned non-JSON status ${signedResponse.status}.`,
    );
  }

  if (!signedResponse.ok || responseBody.challenge !== challenge) {
    throw new Error(
      `Slack setup check failed: signed webhook challenge returned status ${signedResponse.status}.`,
    );
  }

  console.log(`PASS Signed Slack webhook challenge at ${webhookUrl}`);
}

async function checkSlackSetup() {
  const botToken = requireSlackCredential("SLACK_BOT_TOKEN");
  const signingSecret = requireSlackCredential("SLACK_SIGNING_SECRET");
  const baseUrl = resolveMastraBaseUrl();

  await verifySlackBotScopes(botToken);
  await verifySlackWebhook(baseUrl, signingSecret);

  console.log("PASS Slack credential, scope, signature, and webhook checks complete");
  console.log(`Set both Slack Request URLs to ${new URL(SLACK_WEBHOOK_PATH, baseUrl)}`);
}

checkSlackSetup().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
