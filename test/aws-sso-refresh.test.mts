import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

// os.homedir() reads $HOME on POSIX, so a fixture HOME isolates these tests
// from the developer's real ~/.aws. Must be set before the module is imported.
const fixtureHome = mkdtempSync(join(tmpdir(), "pi-aws-sso-"));
const realHome = process.env.HOME;
process.env.HOME = fixtureHome;

const AWS_ENV_KEYS = [
  "PI_AWS_SSO_PROFILE",
  "AWS_PROFILE",
  "AWS_CONFIG_FILE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_BEDROCK_SKIP_AUTH",
] as const;

const START_URL = "https://example.awsapps.com/start";

function writeAwsConfig(body: string): void {
  mkdirSync(join(fixtureHome, ".aws"), { recursive: true });
  writeFileSync(join(fixtureHome, ".aws", "config"), body);
}

function writeSsoCache(name: string, payload: unknown): void {
  const dir = join(fixtureHome, ".aws", "sso", "cache");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(payload));
}

function clearSsoCache(): void {
  rmSync(join(fixtureHome, ".aws", "sso", "cache"), { recursive: true, force: true });
}

const mod = await import("../extensions/aws-sso-refresh.ts");
const {
  resolveSsoStartUrl,
  cachedTokenExpiry,
  isBedrockProvider,
  configuredBedrockProfile,
  resolveBedrockProfile,
  formatRelative,
  isSsoExpiredError,
  parseSsoPrompt,
  deps,
} = mod;
const createExtension = mod.default;

/**
 * Verbatim `aws sso login --profile <p> --no-browser` output, captured from
 * aws-cli/2.34.38. The device code arrives on stdout ~375ms in, roughly 180s
 * before the process exits, which is what makes streaming it worthwhile.
 */
const REAL_CLI_OUTPUT = `Browser will not be automatically opened.
Please visit the following URL:

https://d-c3671a531d.awsapps.com/start/#/device

Then enter the code:

CLJH-CFGF

Alternatively, you may visit the following URL which will autofill the code upon loading:
https://d-c3671a531d.awsapps.com/start/#/device?user_code=CLJH-CFGF
`;

before(() => {
  writeAwsConfig(`
[default]
region = eu-west-1

[profile sso-modern]
sso_session = corp
sso_account_id = 111122223333

[profile   sso-legacy  ]
sso_start_url = ${START_URL}
sso_region = eu-west-1

[profile static-keys]
aws_access_key_id = AKIAEXAMPLE
aws_secret_access_key = secret

[sso-session corp]
sso_start_url = ${START_URL}   ; trailing comment
sso_region = eu-west-1
`);
});

beforeEach(() => {
  for (const key of AWS_ENV_KEYS) delete process.env[key];
});

after(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(fixtureHome, { recursive: true, force: true });
});

describe("resolveSsoStartUrl", () => {
  it("follows the sso_session indirection", () => {
    assert.equal(resolveSsoStartUrl("sso-modern"), START_URL);
  });

  it("reads the legacy inline sso_start_url and tolerates messy headers", () => {
    assert.equal(resolveSsoStartUrl("sso-legacy"), START_URL);
  });

  it("returns undefined for non-SSO and unknown profiles", () => {
    assert.equal(resolveSsoStartUrl("static-keys"), undefined);
    assert.equal(resolveSsoStartUrl("does-not-exist"), undefined);
    assert.equal(resolveSsoStartUrl("default"), undefined);
  });

  it("honours AWS_CONFIG_FILE", () => {
    const alt = join(fixtureHome, "alt-config");
    writeFileSync(alt, "[profile other]\nsso_start_url = https://other.example/start\n");
    process.env.AWS_CONFIG_FILE = alt;
    assert.equal(resolveSsoStartUrl("other"), "https://other.example/start");
    assert.equal(resolveSsoStartUrl("sso-modern"), undefined);
  });
});

describe("cachedTokenExpiry", () => {
  beforeEach(clearSsoCache);

  it("returns undefined when no cache directory exists", () => {
    assert.equal(cachedTokenExpiry(START_URL), undefined);
  });

  it("picks the latest matching token and ignores registrations and junk", () => {
    writeSsoCache("registration", { clientId: "x", clientSecret: "y" });
    writeSsoCache("other-tenant", {
      startUrl: "https://other.example/start",
      accessToken: "t",
      expiresAt: "2099-01-01T00:00:00Z",
    });
    writeSsoCache("older", {
      startUrl: START_URL,
      accessToken: "t",
      expiresAt: "2030-01-01T00:00:00Z",
    });
    writeSsoCache("newer", {
      // Trailing slash must still match.
      startUrl: `${START_URL}/`,
      accessToken: "t",
      expiresAt: "2031-01-01T00:00:00Z",
    });
    assert.equal(cachedTokenExpiry(START_URL), Date.parse("2031-01-01T00:00:00Z"));
  });

  it("ignores tokens with no accessToken or an unparseable expiry", () => {
    writeSsoCache("no-token", { startUrl: START_URL, expiresAt: "2030-01-01T00:00:00Z" });
    writeSsoCache("bad-date", { startUrl: START_URL, accessToken: "t", expiresAt: "nope" });
    assert.equal(cachedTokenExpiry(START_URL), undefined);
  });

  it("survives a partially written cache file", () => {
    const dir = join(fixtureHome, ".aws", "sso", "cache");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "truncated.json"), '{"startUrl": "https://exa');
    writeSsoCache("good", {
      startUrl: START_URL,
      accessToken: "t",
      expiresAt: "2030-01-01T00:00:00Z",
    });
    assert.equal(cachedTokenExpiry(START_URL), Date.parse("2030-01-01T00:00:00Z"));
  });
});

describe("resolveBedrockProfile", () => {
  it("gives the explicit SSO profile override highest precedence", () => {
    process.env.PI_AWS_SSO_PROFILE = " sso-legacy ";
    process.env.AWS_PROFILE = "sso-modern";
    assert.equal(configuredBedrockProfile(), "sso-legacy");
    assert.equal(resolveBedrockProfile(), "sso-legacy");
  });

  it("ignores empty overrides", () => {
    process.env.PI_AWS_SSO_PROFILE = "  ";
    process.env.AWS_PROFILE = "sso-modern";
    assert.equal(configuredBedrockProfile(), "sso-modern");
  });

  it("returns the profile when it is SSO-based", () => {
    process.env.AWS_PROFILE = "sso-modern";
    assert.equal(resolveBedrockProfile(), "sso-modern");
  });

  it("opts out for non-SSO profiles and for no profile at all", () => {
    process.env.AWS_PROFILE = "static-keys";
    assert.equal(resolveBedrockProfile(), undefined);
    delete process.env.AWS_PROFILE;
    // Fixture HOME has no ~/.pi/agent/auth.json, so there is no stored profile.
    assert.equal(resolveBedrockProfile(), undefined);
  });

  it("opts out when a bearer token or skip-auth proxy is configured", () => {
    process.env.AWS_PROFILE = "sso-modern";
    process.env.AWS_BEARER_TOKEN_BEDROCK = "token";
    assert.equal(resolveBedrockProfile(), undefined);
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    process.env.AWS_BEDROCK_SKIP_AUTH = "1";
    assert.equal(resolveBedrockProfile(), undefined);
  });

  it("falls back to AWS_PROFILE stored on the amazon-bedrock credential", () => {
    mkdirSync(join(fixtureHome, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(fixtureHome, ".pi", "agent", "auth.json"),
      JSON.stringify({ "amazon-bedrock": { type: "api_key", env: { AWS_PROFILE: "sso-legacy" } } }),
    );
    try {
      assert.equal(resolveBedrockProfile(), "sso-legacy");
    } finally {
      rmSync(join(fixtureHome, ".pi"), { recursive: true, force: true });
    }
  });

  it("prefers AWS_PROFILE stored on the active Mantle credential", () => {
    mkdirSync(join(fixtureHome, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(fixtureHome, ".pi", "agent", "auth.json"),
      JSON.stringify({
        "amazon-bedrock": { env: { AWS_PROFILE: "sso-legacy" } },
        "bedrock-mantle-openai": { env: { AWS_PROFILE: "sso-modern" } },
      }),
    );
    try {
      assert.equal(resolveBedrockProfile("bedrock-mantle-openai"), "sso-modern");
      assert.equal(resolveBedrockProfile("bedrock-mantle-anthropic"), "sso-legacy");
    } finally {
      rmSync(join(fixtureHome, ".pi"), { recursive: true, force: true });
    }
  });
});

describe("Bedrock provider classification", () => {
  it("includes the built-in and Mantle providers only", () => {
    assert.equal(isBedrockProvider("amazon-bedrock"), true);
    assert.equal(isBedrockProvider("bedrock-mantle"), true);
    assert.equal(isBedrockProvider("bedrock-mantle-openai"), true);
    assert.equal(isBedrockProvider("bedrock-mantle-anthropic"), true);
    assert.equal(isBedrockProvider("anthropic"), false);
    assert.equal(isBedrockProvider("bedrock-mantle-proxy"), false);
    assert.equal(isBedrockProvider(undefined), false);
  });
});

describe("error classification", () => {
  it("matches the AWS SDK expiry messages", () => {
    assert.ok(
      isSsoExpiredError(
        "The SSO session associated with this profile has expired. To refresh this SSO session run aws sso login with the corresponding profile.",
      ),
    );
    assert.ok(isSsoExpiredError("Token has expired and refresh failed"));
    assert.ok(
      isSsoExpiredError("ExpiredTokenException: The security token included in the request is expired"),
    );
  });

  it("does not match unrelated provider errors", () => {
    assert.ok(!isSsoExpiredError("ThrottlingException: Too many requests"));
    assert.ok(!isSsoExpiredError("ValidationException: context_length_exceeded"));
    assert.ok(!isSsoExpiredError("AccessDeniedException: not authorized to invoke this model"));
  });
});

describe("formatRelative", () => {
  const now = Date.parse("2030-01-01T12:00:00Z");
  it("formats past, near-future, and far-future", () => {
    assert.equal(formatRelative(now - 90 * 60_000, now), "90m ago");
    assert.equal(formatRelative(now + 20 * 60_000, now), "in 20m");
    assert.equal(formatRelative(now + 5 * 3_600_000, now), "in 5h");
  });
});

// --------------------------------------------------------------- wiring

type SpawnScript = {
  /** Chunks emitted on stdout before exit, in order. */
  chunks?: string[];
  stderrChunks?: string[];
  /** Exit code; null simulates a process that never exits (timeout path). */
  code?: number | null;
  /** Throw from spawn(), e.g. aws not on PATH. */
  spawnError?: Error;
};

type Harness = {
  hook: (name: string) => (event: unknown, ctx: unknown) => Promise<unknown>;
  hookNames: () => string[];
  command: (name: string) => (args: string, ctx: unknown) => Promise<void>;
  commandNames: () => string[];
  /** Args of each spawn("aws", [...]) call. */
  spawnArgs: string[][];
  openedUrls: string[];
  notices: { message: string; level: string }[];
  widgets: (string[] | undefined)[];
  statuses: (string | undefined)[];
  /** Widget/status/notify state observed *while* the login was still running. */
  duringLogin: () => { widgets: (string[] | undefined)[]; notices: string[] };
  ctx: (provider: string, opts?: { confirm?: boolean; hasUI?: boolean }) => unknown;
  script: (script: SpawnScript | SpawnScript[]) => void;
};

function harness(): Harness {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const spawnArgs: string[][] = [];
  const openedUrls: string[] = [];
  const notices: { message: string; level: string }[] = [];
  const widgets: (string[] | undefined)[] = [];
  const statuses: (string | undefined)[] = [];
  let scripts: SpawnScript[] = [{ chunks: [REAL_CLI_OUTPUT], code: 0 }];
  let snapshot: { widgets: (string[] | undefined)[]; notices: string[] } = {
    widgets: [],
    notices: [],
  };

  deps.spawn = (command: string, args: string[]) => {
    assert.equal(command, "aws");
    spawnArgs.push(args);
    const script = scripts[Math.min(spawnArgs.length - 1, scripts.length - 1)] ?? {};
    if (script.spawnError) throw script.spawnError;

    const listeners = new Map<string, ((...a: never[]) => void)[]>();
    const on = (event: string, listener: (...a: never[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    };
    const emit = (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) {
        (listener as (...a: unknown[]) => void)(...args);
      }
    };

    // Emit asynchronously, like a real child process: the login promise must
    // already be awaiting when the code arrives.
    setTimeout(() => {
      for (const chunk of script.chunks ?? []) emit("stdout", Buffer.from(chunk));
      for (const chunk of script.stderrChunks ?? []) emit("stderr", Buffer.from(chunk));
      // Capture what the user could see while the login was still in flight.
      snapshot = { widgets: [...widgets], notices: notices.map((n) => n.message) };
      if (script.code !== null) emit("exit", script.code ?? 0, null);
    }, 1);

    return {
      stdout: { on: (_e: "data", listener: (chunk: unknown) => void) => on("stdout", listener as never) },
      stderr: { on: (_e: "data", listener: (chunk: unknown) => void) => on("stderr", listener as never) },
      on: on as never,
      kill: () => emit("exit", null, "SIGTERM"),
    };
  };
  deps.openUrl = (url: string) => {
    openedUrls.push(url);
  };

  const pi = {
    on: (event: string, handler: never) => {
      handlers.set(event, handler);
    },
    registerCommand: (name: string, options: never) => {
      commands.set(name, options);
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: test double for ExtensionAPI
  createExtension(pi as any);

  return {
    hook: (name) => {
      const handler = handlers.get(name);
      assert.ok(handler, `no handler registered for "${name}"`);
      return handler;
    },
    hookNames: () => [...handlers.keys()],
    command: (name) => {
      const command = commands.get(name);
      assert.ok(command, `no command registered for "${name}"`);
      return command.handler;
    },
    commandNames: () => [...commands.keys()],
    spawnArgs,
    openedUrls,
    notices,
    widgets,
    statuses,
    duringLogin: () => snapshot,
    script: (script) => {
      scripts = Array.isArray(script) ? script : [script];
    },
    ctx: (provider, opts = {}) => ({
      hasUI: opts.hasUI ?? true,
      model: { provider, id: "test-model" },
      ui: {
        notify: (message: string, level: string) => notices.push({ message, level }),
        setStatus: (_id: string, text?: string) => statuses.push(text),
        setWidget: (_id: string, lines?: string[]) => widgets.push(lines),
        confirm: async () => opts.confirm ?? true,
        select: async () => undefined,
        input: async () => undefined,
      },
    }),
  };
}

/** Every message notified so far, joined for loose matching. */
function messages(h: Harness): string {
  return h.notices.map((n) => n.message).join("\n");
}

function assistantError(errorMessage: string, provider = "amazon-bedrock") {
  return { message: { role: "assistant", stopReason: "error", provider, errorMessage } };
}

describe("extension wiring", () => {
  it("registers the expected hooks and command", () => {
    const h = harness();
    assert.deepEqual(h.hookNames().sort(), [
      "before_agent_start",
      "message_end",
      "session_shutdown",
    ]);
    assert.deepEqual(h.commandNames(), ["aws-sso"]);
  });

  it("rewrites an expired-SSO error and triggers a login", async () => {
    process.env.AWS_PROFILE = "sso-modern";
    const h = harness();
    const result = (await h.hook("message_end")(
      assistantError("The SSO session associated with this profile has expired."),
      h.ctx("amazon-bedrock"),
    )) as { message: { errorMessage: string } };

    assert.match(result.message.errorMessage, /^AWS SSO session expired for profile "sso-modern"/);
    assert.match(result.message.errorMessage, /Original error: The SSO session/);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(h.spawnArgs[0], ["sso", "login", "--profile", "sso-modern", "--no-browser"]);
  });

  it("rewrites expired-SSO errors for Mantle providers", async () => {
    process.env.AWS_PROFILE = "sso-modern";
    for (const provider of [
      "bedrock-mantle",
      "bedrock-mantle-openai",
      "bedrock-mantle-anthropic",
    ]) {
      const h = harness();
      const result = (await h.hook("message_end")(
        assistantError("Token has expired and refresh failed", provider),
        h.ctx(provider),
      )) as { message: { errorMessage: string } };

      assert.match(result.message.errorMessage, /^AWS SSO session expired/);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(h.spawnArgs[0], ["sso", "login", "--profile", "sso-modern", "--no-browser"]);
    }
  });

  it("leaves unrelated errors and other providers untouched", async () => {
    process.env.AWS_PROFILE = "sso-modern";
    const h = harness();
    assert.equal(
      await h.hook("message_end")(
        assistantError("ThrottlingException: slow down"),
        h.ctx("amazon-bedrock"),
      ),
      undefined,
    );
    assert.equal(
      await h.hook("message_end")(
        assistantError("SSO session associated with this profile has expired", "anthropic"),
        h.ctx("anthropic"),
      ),
      undefined,
    );
    assert.equal(
      await h.hook("message_end")(
        { message: { role: "user", content: "hi" } },
        h.ctx("amazon-bedrock"),
      ),
      undefined,
    );
    assert.equal(h.spawnArgs.length, 0);
  });

  it("reports a failed login instead of claiming success", async () => {
    process.env.AWS_PROFILE = "sso-modern";
    const h = harness();
    h.script({ stderrChunks: ["Error loading SSO Token"], code: 1 });
    await h.hook("message_end")(
      assistantError("Token has expired and refresh failed"),
      h.ctx("amazon-bedrock"),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.match(messages(h), /aws sso login failed \(exit 1\).*Error loading SSO Token/);
  });

  it("does not attempt a browser login without a UI", async () => {
    process.env.AWS_PROFILE = "sso-modern";
    const h = harness();
    await h.hook("message_end")(
      assistantError("Token has expired and refresh failed"),
      h.ctx("amazon-bedrock", { hasUI: false }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.spawnArgs.length, 0);
    assert.match(messages(h), /Run 'aws sso login --profile sso-modern' and retry/);
  });

  it("stops prompting for a profile once the user declines", async () => {
    process.env.AWS_PROFILE = "sso-modern";
    clearSsoCache();
    const h = harness();
    const ctx = h.ctx("amazon-bedrock", { confirm: false });
    await h.hook("before_agent_start")({ prompt: "hi" }, ctx);
    await h.hook("before_agent_start")({ prompt: "hi" }, ctx);
    assert.equal(h.spawnArgs.length, 0);
  });
});

describe("before_agent_start pre-flight", () => {
  beforeEach(clearSsoCache);

  it("refreshes when the cached token is missing or near expiry", async () => {
    process.env.AWS_PROFILE = "sso-modern";
    const missing = harness();
    await missing.hook("before_agent_start")({ prompt: "hi" }, missing.ctx("amazon-bedrock"));
    assert.equal(missing.spawnArgs.length, 1);

    writeSsoCache("soon", {
      startUrl: START_URL,
      accessToken: "t",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const soon = harness();
    await soon.hook("before_agent_start")({ prompt: "hi" }, soon.ctx("amazon-bedrock"));
    assert.equal(soon.spawnArgs.length, 1);
  });

  it("pre-flights all Mantle providers", async () => {
    process.env.AWS_PROFILE = "sso-modern";
    for (const provider of [
      "bedrock-mantle",
      "bedrock-mantle-openai",
      "bedrock-mantle-anthropic",
    ]) {
      const h = harness();
      await h.hook("before_agent_start")({ prompt: "hi" }, h.ctx(provider));
      assert.equal(h.spawnArgs.length, 1);
    }
  });

  it("uses the explicit shared profile for Mantle pre-flight", async () => {
    process.env.PI_AWS_SSO_PROFILE = "sso-legacy";
    process.env.AWS_PROFILE = "sso-modern";
    const h = harness();
    await h.hook("before_agent_start")(
      { prompt: "hi" },
      h.ctx("bedrock-mantle-openai"),
    );
    assert.deepEqual(h.spawnArgs[0], [
      "sso",
      "login",
      "--profile",
      "sso-legacy",
      "--no-browser",
    ]);
  });

  it("stays quiet for a healthy token, another provider, or a non-SSO profile", async () => {
    writeSsoCache("healthy", {
      startUrl: START_URL,
      accessToken: "t",
      expiresAt: new Date(Date.now() + 8 * 3_600_000).toISOString(),
    });
    const h = harness();

    process.env.AWS_PROFILE = "sso-modern";
    await h.hook("before_agent_start")({ prompt: "hi" }, h.ctx("amazon-bedrock"));
    await h.hook("before_agent_start")({ prompt: "hi" }, h.ctx("anthropic"));

    process.env.AWS_PROFILE = "static-keys";
    await h.hook("before_agent_start")({ prompt: "hi" }, h.ctx("amazon-bedrock"));

    assert.equal(h.spawnArgs.length, 0);
    assert.deepEqual(h.notices, []);
    assert.deepEqual(h.widgets, []);
  });

  it("collapses concurrent refreshes into one login", async () => {
    process.env.AWS_PROFILE = "sso-modern";
    const h = harness();
    await Promise.all([
      h.hook("before_agent_start")({ prompt: "a" }, h.ctx("amazon-bedrock")),
      h.hook("before_agent_start")({ prompt: "b" }, h.ctx("amazon-bedrock")),
      h.hook("before_agent_start")({ prompt: "c" }, h.ctx("amazon-bedrock")),
    ]);
    assert.equal(h.spawnArgs.length, 1);
  });
});

describe("/aws-sso command", () => {
  beforeEach(clearSsoCache);

  it("logs in without asking for confirmation", async () => {
    const h = harness();
    await h.command("aws-sso")("sso-modern", h.ctx("amazon-bedrock", { confirm: false }));
    assert.deepEqual(h.spawnArgs[0], ["sso", "login", "--profile", "sso-modern", "--no-browser"]);
  });

  it("refuses a non-SSO profile", async () => {
    const h = harness();
    await h.command("aws-sso")("static-keys", h.ctx("amazon-bedrock"));
    assert.equal(h.spawnArgs.length, 0);
    assert.match(messages(h), /is not SSO-based/);
  });

  it("uses the explicit shared profile when no argument is supplied", async () => {
    process.env.PI_AWS_SSO_PROFILE = "sso-legacy";
    process.env.AWS_PROFILE = "sso-modern";
    const h = harness();
    await h.command("aws-sso")("", h.ctx("bedrock-mantle-openai"));
    assert.deepEqual(h.spawnArgs[0], [
      "sso",
      "login",
      "--profile",
      "sso-legacy",
      "--no-browser",
    ]);
  });

  it("uses the active Mantle profile without leaking an unrelated provider profile", async () => {
    mkdirSync(join(fixtureHome, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(fixtureHome, ".pi", "agent", "auth.json"),
      JSON.stringify({
        "amazon-bedrock": { env: { AWS_PROFILE: "sso-legacy" } },
        anthropic: { env: { AWS_PROFILE: "sso-modern" } },
        "bedrock-mantle-openai": { env: { AWS_PROFILE: "sso-modern" } },
      }),
    );
    try {
      const unrelated = harness();
      await unrelated.command("aws-sso")("", unrelated.ctx("anthropic"));
      assert.deepEqual(unrelated.spawnArgs[0], [
        "sso",
        "login",
        "--profile",
        "sso-legacy",
        "--no-browser",
      ]);

      const mantle = harness();
      await mantle.command("aws-sso")("", mantle.ctx("bedrock-mantle-openai"));
      assert.deepEqual(mantle.spawnArgs[0], [
        "sso",
        "login",
        "--profile",
        "sso-modern",
        "--no-browser",
      ]);
    } finally {
      rmSync(join(fixtureHome, ".pi"), { recursive: true, force: true });
    }
  });
});

describe("parseSsoPrompt", () => {
  it("extracts the code and prefers the autofill URL from real CLI output", () => {
    assert.deepEqual(parseSsoPrompt(REAL_CLI_OUTPUT), {
      code: "CLJH-CFGF",
      url: "https://d-c3671a531d.awsapps.com/start/#/device?user_code=CLJH-CFGF",
    });
  });

  it("handles a chunk that arrives before the code is printed", () => {
    const partial = "Browser will not be automatically opened.\nPlease visit the following URL:\n";
    assert.deepEqual(parseSsoPrompt(partial), {});
  });

  it("falls back to a plain URL when no autofill variant is offered", () => {
    const output = "open https://device.sso.eu-west-1.amazonaws.com/\nThen enter: ABCD-1234\n";
    assert.deepEqual(parseSsoPrompt(output), {
      code: "ABCD-1234",
      url: "https://device.sso.eu-west-1.amazonaws.com/",
    });
  });

  it("does not mistake lowercase host fragments for a code", () => {
    assert.equal(parseSsoPrompt("https://d-c3671a531d.awsapps.com/start").code, undefined);
  });
});

describe("device code visibility", () => {
  beforeEach(clearSsoCache);

  it("shows the code in a widget, the footer, and a notice before login finishes", async () => {
    process.env.AWS_PROFILE = "sso-modern";
    const h = harness();
    await h.command("aws-sso")("sso-modern", h.ctx("amazon-bedrock"));

    // What the user could actually see while the browser was waiting.
    const during = h.duringLogin();
    const widgetText = during.widgets.map((lines) => (lines ?? []).join(" | "));
    assert.ok(
      widgetText.some((text) => text.includes("CLJH-CFGF")),
      `code never reached a widget during login: ${JSON.stringify(widgetText)}`,
    );
    assert.ok(
      during.notices.some((n) => n.includes("CLJH-CFGF")),
      "code never reached a notification during login",
    );

    // Identity context: which profile and which tenant is asking.
    const codeWidget = during.widgets.find((lines) => (lines ?? []).join(" ").includes("CLJH-CFGF"));
    const codeWidgetText = (codeWidget ?? []).join(" ");
    assert.match(codeWidgetText, /sso-modern/);
    assert.match(codeWidgetText, /example\.awsapps\.com/);
    assert.match(codeWidgetText, /match the code shown in your browser/);

    // The code notice is a security check, so it must not be a quiet "info".
    const codeNotice = h.notices.find((n) => n.message.includes("CLJH-CFGF"));
    assert.equal(codeNotice?.level, "warning");

    assert.match(messages(h), /Confirm it matches the code in your browser/);
    assert.equal(h.statuses.some((s) => s?.includes("CLJH-CFGF")), true);
  });

  it("opens the autofill URL so the code does not have to be retyped", async () => {
    const h = harness();
    await h.command("aws-sso")("sso-modern", h.ctx("amazon-bedrock"));
    assert.deepEqual(h.openedUrls, [
      "https://d-c3671a531d.awsapps.com/start/#/device?user_code=CLJH-CFGF",
    ]);
  });

  it("clears the widget and status when the login ends", async () => {
    const h = harness();
    await h.command("aws-sso")("sso-modern", h.ctx("amazon-bedrock"));
    assert.equal(h.widgets.at(-1), undefined);
    assert.equal(h.statuses.at(-1), undefined);
  });

  it("streams the code even when the CLI writes it to stderr", async () => {
    const h = harness();
    h.script({ stderrChunks: [REAL_CLI_OUTPUT], code: 0 });
    await h.command("aws-sso")("sso-modern", h.ctx("amazon-bedrock"));
    assert.ok(h.duringLogin().notices.some((n) => n.includes("CLJH-CFGF")));
  });

  it("shows the code once when output arrives in fragments", async () => {
    const h = harness();
    h.script({ chunks: ["Then enter the code:\n\nCLJH", "-CFGF\n\nmore output\n"], code: 0 });
    await h.command("aws-sso")("sso-modern", h.ctx("amazon-bedrock"));
    assert.equal(h.notices.filter((n) => n.message.includes("CLJH-CFGF")).length, 1);
  });

  it("falls back to the browser-opening form on an AWS CLI without --no-browser", async () => {
    const h = harness();
    h.script([
      { stderrChunks: ["Unknown options: --no-browser\nusage: aws sso login\n"], code: 2 },
      { chunks: [REAL_CLI_OUTPUT], code: 0 },
    ]);
    await h.command("aws-sso")("sso-modern", h.ctx("amazon-bedrock"));

    assert.deepEqual(h.spawnArgs, [
      ["sso", "login", "--profile", "sso-modern", "--no-browser"],
      ["sso", "login", "--profile", "sso-modern"],
    ]);
    // The retry lets the CLI open the browser, so we must not open a second tab.
    assert.deepEqual(h.openedUrls, []);
    assert.match(messages(h), /refreshed for profile "sso-modern"/);
    // The unsupported-flag probe must not be reported as a real failure.
    assert.doesNotMatch(messages(h), /Unknown options/);
  });

  it("reports a missing aws CLI instead of hanging", async () => {
    const h = harness();
    h.script({ spawnError: Object.assign(new Error("spawn aws ENOENT"), { code: "ENOENT" }) });
    await h.command("aws-sso")("sso-modern", h.ctx("amazon-bedrock"));
    assert.match(messages(h), /Could not run 'aws sso login --profile sso-modern': spawn aws ENOENT/);
  });
});
