# pi-aws-sso-refresh

A [pi](https://pi.dev) package that keeps AWS SSO sessions alive for the
**Amazon Bedrock** provider.

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
| `/aws-sso [profile]` | Manual refresh. |

Refreshing runs `aws sso login --profile <profile>`, which opens your browser.

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
pi install git:github.com/javrasya/pi-aws-sso-refresh@v0.1.0
```

Or try it for a single run without installing:

```bash
pi -e git:github.com/javrasya/pi-aws-sso-refresh
```

Project-local install (writes to `.pi/settings.json`, shareable with your team):

```bash
pi install -l git:github.com/javrasya/pi-aws-sso-refresh@v0.1.0
```

Remove with:

```bash
pi remove git:github.com/javrasya/pi-aws-sso-refresh
```

## Requirements

- The AWS CLI v2 (`aws`) on `PATH`.
- A profile in `~/.aws/config` configured for IAM Identity Center (SSO), selected
  via `AWS_PROFILE` or stored on the `amazon-bedrock` credential in
  `~/.pi/agent/auth.json` (`/login amazon-bedrock` → "AWS profile").

## Configuration

None. Behaviour is derived from your existing AWS configuration. Two constants at
the top of `extensions/aws-sso-refresh.ts` are worth knowing about:

| Constant | Default | Meaning |
|----------|---------|---------|
| `EXPIRY_SKEW_MS` | 5 min | Refresh when the token expires within this window. |
| `LOGIN_TIMEOUT_MS` | 180 s | How long to wait for the browser login. |

## Development

```bash
npm install
npm test        # node:test via tsx, isolated against a fixture $HOME
npm run typecheck
```

The tests point `$HOME` at a temporary fixture directory, so they never read your
real `~/.aws` and never shell out to `aws`.

## License

MIT
