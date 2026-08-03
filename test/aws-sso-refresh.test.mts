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
  resolveBedrockProfile,
  formatRelative,
  isSsoExpiredError,
} = mod;
const createExtension = mod.default;

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

type Harness = {
  hook: (name: string) => (event: unknown, ctx: unknown) => Promise<unknown>;
  hookNames: () => string[];
  command: (name: string) => (args: string, ctx: unknown) => Promise<void>;
  commandNames: () => string[];
  execCalls: unknown[][];
  notices: string[];
  ctx: (provider: string, opts?: { confirm?: boolean; hasUI?: boolean }) => unknown;
  setExecResult: (result: { code: number; stdout?: string; stderr?: string }) => void;
};

function harness(): Harness {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const execCalls: unknown[][] = [];
  const notices: string[] = [];
  let execResult: { code: number; stdout: string; stderr: string } = {
    code: 0,
    stdout: "",
    stderr: "",
  };

  const pi = {
    on: (event: string, handler: never) => {
      handlers.set(event, handler);
    },
    registerCommand: (name: string, options: never) => {
      commands.set(name, options);
    },
    exec: async (...args: unknown[]) => {
      execCalls.push(args);
      return { killed: false, ...execResult };
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
    execCalls,
    notices,
    setExecResult: (result) => {
      execResult = { stdout: "", stderr: "", ...result };
    },
    ctx: (provider, opts = {}) => ({
      hasUI: opts.hasUI ?? true,
      model: { provider, id: "test-model" },
      ui: {
        notify: (message: string) => notices.push(message),
        setStatus: () => {},
        confirm: async () => opts.confirm ?? true,
        select: async () => undefined,
        input: async () => undefined,
      },
    }),
  };
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
    assert.deepEqual(h.execCalls[0]?.slice(0, 2), [
      "aws",
      ["sso", "login", "--profile", "sso-modern"],
    ]);
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
    assert.equal(h.execCalls.length, 0);
  });

  it("reports a failed login instead of claiming success", async () => {
    process.env.AWS_PROFILE = "sso-modern";
    const h = harness();
    h.setExecResult({ code: 1, stderr: "Error loading SSO Token" });
    await h.hook("message_end")(
      assistantError("Token has expired and refresh failed"),
      h.ctx("amazon-bedrock"),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(h.notices.some((n) => /aws sso login failed \(exit 1\).*Error loading SSO Token/.test(n)));
  });

  it("does not attempt a browser login without a UI", async () => {
    process.env.AWS_PROFILE = "sso-modern";
    const h = harness();
    await h.hook("message_end")(
      assistantError("Token has expired and refresh failed"),
      h.ctx("amazon-bedrock", { hasUI: false }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.execCalls.length, 0);
    assert.ok(h.notices.some((n) => /Run 'aws sso login --profile sso-modern' and retry/.test(n)));
  });

  it("stops prompting for a profile once the user declines", async () => {
    process.env.AWS_PROFILE = "sso-modern";
    clearSsoCache();
    const h = harness();
    const ctx = h.ctx("amazon-bedrock", { confirm: false });
    await h.hook("before_agent_start")({ prompt: "hi" }, ctx);
    await h.hook("before_agent_start")({ prompt: "hi" }, ctx);
    assert.equal(h.execCalls.length, 0);
  });
});

describe("before_agent_start pre-flight", () => {
  beforeEach(clearSsoCache);

  it("refreshes when the cached token is missing or near expiry", async () => {
    process.env.AWS_PROFILE = "sso-modern";
    const missing = harness();
    await missing.hook("before_agent_start")({ prompt: "hi" }, missing.ctx("amazon-bedrock"));
    assert.equal(missing.execCalls.length, 1);

    writeSsoCache("soon", {
      startUrl: START_URL,
      accessToken: "t",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const soon = harness();
    await soon.hook("before_agent_start")({ prompt: "hi" }, soon.ctx("amazon-bedrock"));
    assert.equal(soon.execCalls.length, 1);
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

    assert.equal(h.execCalls.length, 0);
    assert.deepEqual(h.notices, []);
  });

  it("collapses concurrent refreshes into one login", async () => {
    process.env.AWS_PROFILE = "sso-modern";
    const h = harness();
    await Promise.all([
      h.hook("before_agent_start")({ prompt: "a" }, h.ctx("amazon-bedrock")),
      h.hook("before_agent_start")({ prompt: "b" }, h.ctx("amazon-bedrock")),
      h.hook("before_agent_start")({ prompt: "c" }, h.ctx("amazon-bedrock")),
    ]);
    assert.equal(h.execCalls.length, 1);
  });
});

describe("/aws-sso command", () => {
  beforeEach(clearSsoCache);

  it("logs in without asking for confirmation", async () => {
    const h = harness();
    await h.command("aws-sso")("sso-modern", h.ctx("amazon-bedrock", { confirm: false }));
    assert.deepEqual(h.execCalls[0]?.slice(0, 2), [
      "aws",
      ["sso", "login", "--profile", "sso-modern"],
    ]);
  });

  it("refuses a non-SSO profile", async () => {
    const h = harness();
    await h.command("aws-sso")("static-keys", h.ctx("amazon-bedrock"));
    assert.equal(h.execCalls.length, 0);
    assert.ok(h.notices.some((n) => /is not SSO-based/.test(n)));
  });
});
