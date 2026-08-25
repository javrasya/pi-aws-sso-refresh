/**
 * pi-aws-sso-refresh
 *
 * pi's Amazon Bedrock provider authenticates through the AWS SDK default
 * credential chain, so pi holds no credential of its own to refresh. When an SSO
 * session expires, the failure surfaces mid-stream as an opaque provider error
 * ("The SSO session associated with this profile has expired...") with no
 * `/login` affordance, because pi's re-auth prompt only covers OAuth providers.
 *
 * This extension closes that gap:
 *
 *   1. `before_agent_start` — pre-flight the local SSO token cache and refresh
 *      *before* the request is built, so the turn never fails.
 *   2. `message_end` — fallback for sessions that expire mid-turn: rewrite the
 *      error into something actionable and offer to re-login.
 *   3. `/aws-sso` — manual refresh.
 *
 * Refreshing runs `aws sso login --profile <profile>`, which opens a browser.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const BEDROCK_PROVIDERS = new Set([
  "amazon-bedrock",
  "bedrock-mantle",
  "bedrock-mantle-anthropic",
  "bedrock-mantle-openai",
]);

/** Refresh when the token expires within this window (clock skew + turn duration). */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** `aws sso login` blocks on a browser round trip. */
const LOGIN_TIMEOUT_MS = 180_000;

/** AWS device codes are two groups of four uppercase alphanumerics. */
const DEVICE_CODE_PATTERN = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;

/** The autofill form of the portal URL carries the code as a query param. */
const AUTOFILL_URL_PATTERN = /(https?:\/\/\S*[?&]user_code=[A-Z0-9]{4}-[A-Z0-9]{4})/;
const ANY_URL_PATTERN = /(https?:\/\/\S+)/;

/** Older AWS CLI builds predate `--no-browser`. */
const UNSUPPORTED_FLAG_PATTERN =
  /(?:unknown option|unrecognized argument|invalid choice|argument (?:operation|subcommand))/i;

const SSO_EXPIRED_PATTERN =
  /SSO session associated with this profile has expired|Token (?:has expired|is expired) and refresh failed|The security token included in the request is (?:expired|invalid)/i;

// ---------------------------------------------------------------- AWS config

type IniSections = Map<string, Map<string, string>>;

function parseIni(path: string): IniSections {
  const sections: IniSections = new Map();
  let current: Map<string, string> | undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return sections;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/[;#].*$/, "").trim();
    if (!line) continue;
    const header = line.match(/^\[(.+)\]$/)?.[1];
    if (header !== undefined) {
      // Collapse inner whitespace so "[profile   foo]" matches "profile foo".
      current = new Map();
      sections.set(header.trim().replace(/\s+/g, " "), current);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1 || !current) continue;
    current.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return sections;
}

export function configPath(): string {
  return process.env.AWS_CONFIG_FILE ?? join(homedir(), ".aws", "config");
}

/** The AWS CLI always caches SSO tokens here, regardless of AWS_CONFIG_FILE. */
function ssoCacheDir(): string {
  return join(homedir(), ".aws", "sso", "cache");
}

/**
 * SSO start URL for a profile, or undefined when the profile does not use SSO
 * (static keys, credential_process, instance role, ...).
 *
 * Handles both the modern `sso_session` indirection and the legacy inline
 * `sso_start_url` form.
 */
export function resolveSsoStartUrl(profile: string): string | undefined {
  const sections = parseIni(configPath());
  const section =
    sections.get(profile === "default" ? "default" : `profile ${profile}`) ??
    sections.get(profile);
  if (!section) return undefined;

  const sessionName = section.get("sso_session");
  if (sessionName) {
    return sections.get(`sso-session ${sessionName}`)?.get("sso_start_url");
  }
  return section.get("sso_start_url");
}

/**
 * Latest expiry among cached SSO tokens for this start URL, in epoch ms.
 * Undefined means no usable cached token — a login is required.
 *
 * We read the cache from disk rather than calling `aws sts get-caller-identity`:
 * this runs before every turn, so it must be a local check, not a network
 * round trip.
 */
export function cachedTokenExpiry(startUrl: string): number | undefined {
  const dir = ssoCacheDir();
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((file) => file.endsWith(".json"));
  } catch {
    return undefined;
  }

  const wanted = startUrl.replace(/\/$/, "");
  let latest: number | undefined;
  for (const file of entries) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        startUrl?: string;
        expiresAt?: string;
        accessToken?: string;
      };
      // Client-registration files live in the same directory and have no startUrl.
      if (!raw.accessToken || !raw.expiresAt) continue;
      if (raw.startUrl?.replace(/\/$/, "") !== wanted) continue;
      const expiresAt = Date.parse(raw.expiresAt);
      if (Number.isNaN(expiresAt)) continue;
      if (latest === undefined || expiresAt > latest) latest = expiresAt;
    } catch {
      // Unreadable or partially written cache file: treat as absent.
    }
  }
  return latest;
}

// --------------------------------------------------------------- profile

/**
 * The profile pi will actually use for Bedrock, or undefined when this setup is
 * not SSO-based and we should stay out of the way.
 *
 * Mirrors the precedence in pi-ai's `bedrock-converse-stream`: a bearer token or
 * skip-auth proxy wins, otherwise `AWS_PROFILE` from the process environment or
 * from the env scoped to the active Bedrock provider's credential in auth.json.
 * Custom Mantle providers fall back to the built-in `amazon-bedrock` credential
 * so an existing `/login amazon-bedrock` setup keeps working.
 */
export function isBedrockProvider(provider: string | undefined): boolean {
  return provider !== undefined && BEDROCK_PROVIDERS.has(provider);
}

export function resolveBedrockProfile(provider = "amazon-bedrock"): string | undefined {
  if (process.env.AWS_BEARER_TOKEN_BEDROCK) return undefined;
  if (process.env.AWS_BEDROCK_SKIP_AUTH === "1") return undefined;

  // No profile at all means static keys or a container/instance role, not SSO.
  const profile = process.env.AWS_PROFILE ?? storedAuthProfile(provider);
  if (!profile) return undefined;

  return resolveSsoStartUrl(profile) ? profile : undefined;
}

function storedAuthProfile(provider: string): string | undefined {
  try {
    const auth = JSON.parse(
      readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"),
    ) as Record<string, { env?: Record<string, string> }>;
    return (
      auth[provider]?.env?.AWS_PROFILE ??
      (provider === "amazon-bedrock" ? undefined : auth["amazon-bedrock"]?.env?.AWS_PROFILE)
    );
  } catch {
    return undefined;
  }
}

export function formatRelative(epochMs: number, now = Date.now()): string {
  const minutes = Math.round((epochMs - now) / 60_000);
  if (minutes < 0) return `${Math.abs(minutes)}m ago`;
  if (minutes < 60) return `in ${minutes}m`;
  return `in ${Math.round(minutes / 60)}h`;
}

export function isSsoExpiredError(message: string): boolean {
  return SSO_EXPIRED_PATTERN.test(message);
}

// ------------------------------------------------------- login subprocess

/**
 * The device code and portal URL from `aws sso login --no-browser` output.
 *
 * The browser's authorization page asks the user to confirm that the code shown
 * there matches "the one given to you" — so the code has to reach the user
 * *before* the login completes, which is why the login is streamed rather than
 * run through `pi.exec` (which buffers until exit).
 */
export function parseSsoPrompt(output: string): { code?: string; url?: string } {
  const code = output.match(DEVICE_CODE_PATTERN)?.[1];
  // Prefer the autofill URL: it carries the code, so the user does not retype it.
  const url = output.match(AUTOFILL_URL_PATTERN)?.[1] ?? output.match(ANY_URL_PATTERN)?.[1];
  return { ...(code !== undefined && { code }), ...(url !== undefined && { url }) };
}

type ChunkStream = { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;

export type SpawnedChild = {
  stdout: ChunkStream;
  stderr: ChunkStream;
  on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
};

function defaultOpenUrl(url: string): void {
  if (process.env.PI_AWS_SSO_NO_OPEN === "1") return;
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = nodeSpawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {}); // The URL is displayed anyway; opening is best-effort.
    child.unref();
  } catch {
    // Same: the user can still click or paste the URL.
  }
}

/** Injection seam for tests, which must not shell out or open a browser. */
export const deps = {
  spawn: (command: string, args: string[]): SpawnedChild =>
    nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }),
  openUrl: defaultOpenUrl,
};

/** Portal host, so the user can confirm the login targets the expected tenant. */
function tenantOf(startUrl: string | undefined): string | undefined {
  if (!startUrl) return undefined;
  try {
    return new URL(startUrl).host;
  } catch {
    return undefined;
  }
}

/**
 * Keeps the device code on screen for the whole login, next to the profile and
 * tenant it belongs to, so the user can match it against the browser's
 * "Confirm this code matches the one given to you" page and cancel if it differs.
 */
function renderLoginWidget(
  ctx: ExtensionContext,
  profile: string,
  tenant: string | undefined,
  code: string | undefined,
): void {
  const accent = (text: string) => ctx.ui.theme?.fg?.("accent", text) ?? text;
  const dim = (text: string) => ctx.ui.theme?.fg?.("dim", text) ?? text;

  const lines = [
    accent("AWS SSO login"),
    dim(`  profile   ${profile}${tenant ? `   tenant   ${tenant}` : ""}`),
    code === undefined
      ? dim("  requesting device code...")
      : `  code      ${accent(code)}`,
  ];
  if (code !== undefined) {
    lines.push(dim("  this must match the code shown in your browser — cancel there if not"));
  }
  ctx.ui.setWidget("aws-sso", lines);
}

// -------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
  /** Deduplicates concurrent refreshes (queued turns, retries, /aws-sso). */
  let inFlight: Promise<boolean> | undefined;
  /** Profiles the user declined this session; do not nag again. */
  const declined = new Set<string>();

  async function runLogin(profile: string, ctx: ExtensionContext): Promise<boolean> {
    const tenant = tenantOf(resolveSsoStartUrl(profile));

    // --no-browser makes the CLI print the code and URL instead of racing ahead
    // to the browser, so we can show the code first and open the URL after.
    const attempt = await streamLogin(profile, tenant, ctx, true);
    if (attempt.unsupportedFlag) {
      // Older CLI: let it open the browser itself. The code is still streamed,
      // just possibly after the browser is already up.
      return (await streamLogin(profile, tenant, ctx, false)).ok;
    }
    return attempt.ok;
  }

  async function streamLogin(
    profile: string,
    tenant: string | undefined,
    ctx: ExtensionContext,
    noBrowser: boolean,
  ): Promise<{ ok: boolean; unsupportedFlag?: boolean }> {
    const args = ["sso", "login", "--profile", profile];
    if (noBrowser) args.push("--no-browser");

    ctx.ui.setStatus("aws-sso", `aws sso login (${profile})...`);
    renderLoginWidget(ctx, profile, tenant, undefined);

    let output = "";
    let shownCode: string | undefined;

    const result = await new Promise<{ code: number | null; spawnError?: Error }>((resolve) => {
      let child: SpawnedChild;
      try {
        child = deps.spawn("aws", args);
      } catch (error) {
        resolve({ code: null, spawnError: error as Error });
        return;
      }

      let settled = false;
      const finish = (value: { code: number | null; spawnError?: Error }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish({ code: null });
      }, LOGIN_TIMEOUT_MS);
      // Never hold the process open on this timer.
      (timer as unknown as { unref?: () => void }).unref?.();

      const onChunk = (chunk: unknown) => {
        output += String(chunk);
        const { code, url } = parseSsoPrompt(output);
        if (code === undefined || code === shownCode) return;

        // Surface the code the moment it appears. This is the whole point: the
        // browser asks the user to confirm it matches "the one given to you".
        shownCode = code;
        renderLoginWidget(ctx, profile, tenant, code);
        ctx.ui.setStatus("aws-sso", `aws sso ${code}`);
        ctx.ui.notify(
          `AWS SSO code ${code} for profile "${profile}"${tenant ? ` (${tenant})` : ""}. ` +
            `Confirm it matches the code in your browser; cancel there if it does not.`,
          "warning",
        );
        if (noBrowser && url) deps.openUrl(url);
      };

      child.stdout?.on("data", onChunk);
      child.stderr?.on("data", onChunk);
      child.on("error", (error) => finish({ code: null, spawnError: error }));
      child.on("exit", (code) => finish({ code }));
    });

    ctx.ui.setWidget("aws-sso", undefined);
    ctx.ui.setStatus("aws-sso", undefined);

    if (result.spawnError) {
      ctx.ui.notify(
        `Could not run 'aws sso login --profile ${profile}': ${result.spawnError.message}`,
        "error",
      );
      return { ok: false };
    }

    if (result.code === 0) {
      ctx.ui.notify(`AWS SSO session refreshed for profile "${profile}".`, "info");
      return { ok: true };
    }

    if (noBrowser && UNSUPPORTED_FLAG_PATTERN.test(output) && output.includes("no-browser")) {
      return { ok: false, unsupportedFlag: true };
    }

    const detail = output.trim().split("\n").slice(-3).join(" ");
    ctx.ui.notify(
      `aws sso login ${result.code === null ? "timed out" : `failed (exit ${result.code})`}` +
        `${detail ? `: ${detail}` : ""}. Run 'aws sso login --profile ${profile}' manually.`,
      "error",
    );
    return { ok: false };
  }

  async function refresh(
    profile: string,
    ctx: ExtensionContext,
    opts: { ask: boolean; reason: string },
  ): Promise<boolean> {
    // Single-flight the whole sequence, prompt included. Guarding only the exec
    // would let concurrent turns each open their own confirm dialog and then
    // each start a login.
    if (inFlight) return inFlight;

    inFlight = (async () => {
      if (opts.ask) {
        if (declined.has(profile)) return false;
        if (!ctx.hasUI) {
          // Headless: a browser flow cannot succeed, so fail loudly instead.
          ctx.ui.notify(
            `${opts.reason} Run 'aws sso login --profile ${profile}' and retry.`,
            "error",
          );
          return false;
        }
        const confirmed = await ctx.ui.confirm(
          "AWS SSO session expired",
          `${opts.reason}\n\nRun 'aws sso login --profile ${profile}' now? This opens your browser.`,
        );
        if (!confirmed) {
          declined.add(profile);
          return false;
        }
      }
      return runLogin(profile, ctx);
    })().finally(() => {
      inFlight = undefined;
    });

    return inFlight;
  }

  // 1. Pre-flight, so the request never fails on an expired session.
  pi.on("before_agent_start", async (_event, ctx) => {
    const provider = ctx.model?.provider;
    if (!isBedrockProvider(provider)) return;

    const profile = resolveBedrockProfile(provider);
    if (!profile) return;

    const startUrl = resolveSsoStartUrl(profile);
    if (!startUrl) return;

    const expiry = cachedTokenExpiry(startUrl);
    const expiresSoon = expiry === undefined || expiry - Date.now() < EXPIRY_SKEW_MS;
    if (!expiresSoon) {
      declined.delete(profile); // Healthy again: re-arm prompting for later.
      return;
    }

    await refresh(profile, ctx, {
      ask: true,
      reason:
        expiry === undefined
          ? `No cached AWS SSO token for profile "${profile}".`
          : `The AWS SSO session for profile "${profile}" expires ${formatRelative(expiry)}.`,
    });
  });

  // 2. Fallback for sessions that expire mid-turn. pi has no auth classifier for
  //    this error, so make it actionable and offer a refresh.
  pi.on("message_end", async (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.stopReason !== "error") return;
    const provider = isBedrockProvider(message.provider)
      ? message.provider
      : isBedrockProvider(ctx.model?.provider)
        ? ctx.model?.provider
        : undefined;
    if (!provider) return;

    const errorMessage = message.errorMessage ?? "";
    if (!isSsoExpiredError(errorMessage)) return;

    const profile = resolveBedrockProfile(provider) ?? process.env.AWS_PROFILE ?? "default";

    // Fire and forget: message finalization must not block on a browser flow.
    void refresh(profile, ctx, {
      ask: true,
      reason: `The AWS SSO session for profile "${profile}" expired during this request.`,
    }).then((ok) => {
      if (ok) ctx.ui.notify("Resend your last message to retry.", "info");
    });

    return {
      message: {
        ...message,
        errorMessage:
          `AWS SSO session expired for profile "${profile}". ` +
          `Run 'aws sso login --profile ${profile}' (or /aws-sso), then resend. ` +
          `Original error: ${errorMessage}`,
      },
    };
  });

  // 3. Manual escape hatch: /aws-sso [profile]
  pi.registerCommand("aws-sso", {
    description: "Refresh the AWS SSO session used for Amazon Bedrock",
    handler: async (args, ctx) => {
      const provider = isBedrockProvider(ctx.model?.provider)
        ? ctx.model?.provider
        : undefined;
      const profile =
        args.trim() ||
        resolveBedrockProfile(provider) ||
        process.env.AWS_PROFILE ||
        "default";
      const startUrl = resolveSsoStartUrl(profile);
      if (!startUrl) {
        ctx.ui.notify(
          `Profile "${profile}" is not SSO-based (no sso_session/sso_start_url in ${configPath()}).`,
          "warning",
        );
        return;
      }
      const expiry = cachedTokenExpiry(startUrl);
      ctx.ui.notify(
        expiry === undefined
          ? `No cached token for "${profile}". Logging in...`
          : `Token for "${profile}" expires ${formatRelative(expiry)}. Refreshing...`,
        "info",
      );
      await refresh(profile, ctx, { ask: false, reason: "" });
    },
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("aws-sso", undefined);
    ctx.ui.setWidget("aws-sso", undefined);
  });
}
