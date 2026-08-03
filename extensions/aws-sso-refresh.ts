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

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER = "amazon-bedrock";

/** Refresh when the token expires within this window (clock skew + turn duration). */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** `aws sso login` blocks on a browser round trip. */
const LOGIN_TIMEOUT_MS = 180_000;

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
 * from the env scoped to the stored `amazon-bedrock` credential in auth.json.
 */
export function resolveBedrockProfile(): string | undefined {
  if (process.env.AWS_BEARER_TOKEN_BEDROCK) return undefined;
  if (process.env.AWS_BEDROCK_SKIP_AUTH === "1") return undefined;

  // No profile at all means static keys or a container/instance role, not SSO.
  const profile = process.env.AWS_PROFILE ?? storedAuthProfile();
  if (!profile) return undefined;

  return resolveSsoStartUrl(profile) ? profile : undefined;
}

function storedAuthProfile(): string | undefined {
  try {
    const auth = JSON.parse(
      readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"),
    ) as Record<string, { env?: Record<string, string> }>;
    return auth[PROVIDER]?.env?.AWS_PROFILE;
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

// -------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
  /** Deduplicates concurrent refreshes (queued turns, retries, /aws-sso). */
  let inFlight: Promise<boolean> | undefined;
  /** Profiles the user declined this session; do not nag again. */
  const declined = new Set<string>();

  async function runLogin(profile: string, ctx: ExtensionContext): Promise<boolean> {
    ctx.ui.setStatus("aws-sso", `aws sso login (${profile})...`);
    try {
      const result = await pi.exec("aws", ["sso", "login", "--profile", profile], {
        timeout: LOGIN_TIMEOUT_MS,
      });
      if (result.code === 0) {
        ctx.ui.notify(`AWS SSO session refreshed for profile "${profile}".`, "info");
        return true;
      }
      // Output is buffered until exit, so surface the tail rather than swallow it.
      const detail = (result.stderr || result.stdout || "")
        .trim()
        .split("\n")
        .slice(-3)
        .join(" ");
      ctx.ui.notify(
        `aws sso login failed (exit ${result.code})${detail ? `: ${detail}` : ""}. ` +
          `Run 'aws sso login --profile ${profile}' manually.`,
        "error",
      );
      return false;
    } catch (error) {
      ctx.ui.notify(
        `Could not run 'aws sso login --profile ${profile}': ` +
          `${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return false;
    } finally {
      ctx.ui.setStatus("aws-sso", "");
    }
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
    if (ctx.model?.provider !== PROVIDER) return;

    const profile = resolveBedrockProfile();
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
    if (message.provider !== PROVIDER && ctx.model?.provider !== PROVIDER) return;

    const errorMessage = message.errorMessage ?? "";
    if (!isSsoExpiredError(errorMessage)) return;

    const profile = resolveBedrockProfile() ?? process.env.AWS_PROFILE ?? "default";

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
      const profile =
        args.trim() || resolveBedrockProfile() || process.env.AWS_PROFILE || "default";
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
    ctx.ui.setStatus("aws-sso", "");
  });
}
