# pi-aws-sso-refresh

A [pi](https://pi.dev) package that keeps AWS SSO sessions alive for the
**Amazon Bedrock** and **Bedrock Mantle** providers.

## The problem

pi's Bedrock provider authenticates through the AWS SDK default credential
chain, so pi never holds a Bedrock credential of its own. There is nothing for it
to refresh, and its only re-auth affordance (`Run '/login <provider>' to
re-authenticate`) is reserved for OAuth-based providers. When your SSO session
expires, the turn dies mid-stream with a raw SDK error and no way forward from
inside pi:

```
Error: The SSO session associated with this profile has expired. To refresh this
SSO session run aws sso login with the corresponding profile.
```

pi does classify some provider errors (context overflow, rate limits), but it has
no matcher for this one — so there is no recovery path and no prompt.

## What this does

| Hook | Behaviour |
|------|-----------|
| `before_agent_start` | Pre-flight: reads the local SSO token cache and refreshes *before* the request is built, so the turn never fails. |
| `message_end` | Fallback for sessions that expire mid-turn: rewrites the opaque SDK error into an actionable one and offers to re-login. |
| `/aws-sso [profile] [--use-device-code]` | Manual refresh; optionally request device authorization instead of PKCE. |

Refreshing runs `aws sso login --profile <profile>`, which opens your browser.

The extension recognizes pi's built-in `amazon-bedrock` provider and the custom
`bedrock-mantle`, `bedrock-mantle-openai`, and `bedrock-mantle-anthropic`
providers.

Mantle uses different endpoints and APIs from pi's built-in Bedrock Converse
provider. This package does **not** provide that transport: configure a custom
provider in `models.json` using pi's existing `openai-responses` or
`anthropic-messages` API, or install a separate Mantle provider package. This
package only keeps the AWS SSO credentials used by that provider healthy.

## Browser login: PKCE and device authorization

The extension supports both AWS CLI login flows without changing `~/.aws/config`:

- **PKCE** is the default for modern `sso_session` profiles on AWS CLI v2.22.0+.
  The CLI prints an authorization URL, **not a device code**. The extension
  displays that URL in the login widget and a notification, then opens it.
  Complete authorization in a browser on the **same device** running pi, because
  the CLI receives the callback through a local HTTP server.
- **Device authorization** is used by legacy profiles and older CLIs. The
  extension displays the device code before opening the login URL, as described
  below. You can also request this flow explicitly with a modern profile:

  ```text
  /aws-sso --use-device-code
  /aws-sso ai-dev --use-device-code
  ```

Without `--use-device-code`, both manual and automatic refreshes use the CLI's
normal default. On an older CLI that does not recognize `--use-device-code`, the
extension retries without it (these versions already default to device login).

### Seeing the device code

AWS's authorization page asks you to confirm the code shown there matches *"the
one given to you"*:

```
  Confirm this code matches the one given to you.
              XTKT-QMTH
```

Nothing gives it to you if the login is run through `pi.exec`, which buffers the
child process's output until it exits — the code would arrive ~180 seconds late,
after the decision was already made. So the login is **spawned and streamed**
instead, and the code is surfaced the moment the CLI prints it (measured at
~370ms, against a login that resolves in minutes):

```
AWS SSO login
  profile   ai-dev   tenant   d-c3671a531d.awsapps.com
  code      MRTD-RPRR
  this must match the code shown in your browser — cancel there if not
```

The code appears in a widget above the editor, in the footer, and as a `warning`
notification that stays in scrollback. The profile and tenant host are shown
alongside it, so you can confirm *which* login is being requested, not just that
some login is. If the codes differ, cancel in the browser — someone else's device
authorization is in flight.

pi passes `--no-browser` so the CLI prints the authorization prompt instead of
racing ahead to the browser. For PKCE, the extension opens the authorization URL
without waiting for a nonexistent device code. For device login, it shows the
code first and opens the autofill URL when available, so you need not retype it.
The URL stays visible if browser opening fails or is disabled. Streamed URL
fragments are buffered until complete, and each login opens at most one tab.

On an AWS CLI too old for `--no-browser`, it retries with the browser-opening
form and still streams the prompt. Set `PI_AWS_SSO_NO_OPEN=1` to never open a
browser automatically; the URL and any device code are still displayed. With
this setting, an old CLI without `--no-browser` fails rather than opening a
browser through the fallback.

Design notes:

- **The pre-flight check is a local file read**, not `aws sts get-caller-identity`.
  It runs before every turn, so it must not cost a network round trip. The
  extension resolves your profile's SSO start URL from `~/.aws/config`
  (following the `sso_session` indirection, or the legacy inline
  `sso_start_url`) and reads `expiresAt` from `~/.aws/sso/cache/*.json`.
- **It stays out of the way** when Bedrock is not authenticated via SSO — bearer
  token (`AWS_BEARER_TOKEN_BEDROCK`), static keys, `AWS_BEDROCK_SKIP_AUTH=1`
  proxies, container/instance roles, or a non-SSO profile.
- **It never nags.** Declining the prompt suppresses it for that profile until
  the session becomes healthy again. Concurrent turns collapse into a single
  prompt and a single login.
- **Headless runs fail loudly** instead of blocking on a browser flow that cannot
  succeed.
## Install

```bash
pi install git:github.com/javrasya/pi-aws-sso-refresh@v0.2.0
```

Or try it for a single run without installing:

```bash
pi -e git:github.com/javrasya/pi-aws-sso-refresh
```

Project-local install (writes to `.pi/settings.json`, shareable with your team):

```bash
pi install -l git:github.com/javrasya/pi-aws-sso-refresh@v0.2.0
```

Remove with:

```bash
pi remove git:github.com/javrasya/pi-aws-sso-refresh
```

## Requirements

- The AWS CLI v2 (`aws`) on `PATH`.
- A profile in `~/.aws/config` configured for IAM Identity Center (SSO), selected
  via `PI_AWS_SSO_PROFILE`, `AWS_PROFILE`, or the active Bedrock provider's
  credential in `~/.pi/agent/auth.json`. Mantle providers also fall back to the
  `amazon-bedrock` credential (`/login amazon-bedrock` → "AWS profile").

## Configuration

None. Behaviour is derived from your existing AWS configuration. Two constants at
the top of `extensions/aws-sso-refresh.ts` are worth knowing about:

| Constant | Default | Meaning |
|----------|---------|---------|
| `EXPIRY_SKEW_MS` | 5 min | Refresh when the token expires within this window. |
| `LOGIN_TIMEOUT_MS` | 180 s | How long to wait for the browser login. |

Environment variables:

| Variable | Effect |
|----------|--------|
| `PI_AWS_SSO_PROFILE=<profile>` | Explicit profile shared by the refresh hook and a custom credential command. Takes precedence over `AWS_PROFILE` and stored provider credentials. |
| `PI_AWS_SSO_NO_OPEN=1` | Never open a browser automatically; show the code and URL only. |

For a Mantle `apiKey: "!command"` provider, make the command use the same
contract so the profile checked before the turn is the profile used to mint the
token:

```bash
export AWS_PROFILE="${PI_AWS_SSO_PROFILE:-${AWS_PROFILE:-your-sso-profile}}"
```

## Development

```bash
npm install
npm test        # node:test via tsx, isolated against a fixture $HOME
npm run typecheck
```

The tests point `$HOME` at a temporary fixture directory, so they never read your
real `~/.aws` and never shell out to `aws`. They cover URL-only PKCE prompts,
device codes, fragmented output, older CLI fallbacks, and disabled browser
opening. The device-code fixture uses verbatim `aws-cli/2.34.38` output; the PKCE
fixture uses the modern CLI's URL-only format with synthetic OAuth parameters.
Both flows check what was on screen *while the login was still running*, since
"the prompt was displayed eventually" is not the property that matters.

## License

MIT
