# Grok Build Provider v2

Status: v1 wrapper support and v2 native Responses support are implemented in
this branch. This document is the implementation contract for the current
provider layer.

The reference implementation used for the protocol audit is
`/Users/icy/Code/CLIProxyAPI`, tag `v7.2.140` (`a7e3596b`). The local Grok Build
source used for PTY state detection is `/Users/icy/Code/grok-build`.

## Scope and naming

The project has three deliberately different paths:

| Name | Runtime | Protocol | Purpose |
| --- | --- | --- | --- |
| `grok-cli` / `ugrok` | PTY wrapper | Grok Build CLI | Launch and interact with a real Grok Build session. |
| `grok-build` | native provider | OpenAI Responses | Controller/`ucode` calls, including a CLIProxyAPI Grok Shell route. |
| `xai` | native provider | official xAI Responses | Direct official xAI API calls. |

`grok-cli` must not silently turn into a native API call, and `xai` must not
spawn the Grok Build TUI. The existing wrapper state detector remains the
source of truth for PTY sessions: a pending permission/question/plan
interaction is `waiting_input`, an active prompt is `working`, and a session
without either is idle/dormant. Text heuristics are only a fallback when the
protocol state is unavailable.

This is latest-only behavior. Codex and Grok Build do not fall back to Chat
Completions. Explicit `openai` in the native runner remains the generic
OpenAI-compatible Chat Completions provider.

## Current implementation

### Shared Responses protocol

`src/code/providers/responsesProtocol.js` is the single protocol seam for
native and direct upstream code. It owns:

- `/responses` URL resolution;
- provider-neutral message projection into `instructions` and `input`;
- function tool conversion and `function_call_output` conversion;
- `response.output_text.delta` and reasoning deltas;
- `response.output_item.*` and function-call argument assembly;
- `response.completed` and `response.incomplete` terminal events;
- Grok `keepalive` filtering;
- raw Responses usage extraction and normalized usage for native metrics.

`src/code/providers/openaiResponsesTransport.js` is the public provider
transport adapter. It never stores private Responses event metadata in the
canonical conversation. It returns only newly produced public assistant/tool
items, which keeps it aligned with Session Journal v3.

### Grok Build native runtime

The native path is selected by `grok`, `grok-build`, `grok-shell`, `grok-api`,
or `xai` aliases as appropriate. Its defaults are:

- base URL: `https://api.x.ai/v1`;
- model: `grok-4.6`;
- key: `GROK_BUILD_API_KEY` / `XAI_API_KEY`;
- endpoint: `/responses`;
- transport: `openai-responses`.

For a CLIProxyAPI base URL, set for example:

```sh
export UFOO_GROK_BUILD_BASE_URL=http://127.0.0.1:8317/v1
export GROK_BUILD_API_KEY=...
```

The request uses the current Grok Shell identity expected by CLIProxyAPI:

- `User-Agent: grok-shell/0.2.120` for the Grok Shell route;
- `x-grok-conv-id` for the conversation/session identifier;
- `Accept: text/event-stream` and Responses streaming;
- `X-XAI-Token-Auth: xai-grok-cli`,
  `x-grok-client-version: 0.2.120`,
  `x-grok-client-identifier: grok-shell`,
  `x-authenticateresponse: authenticate-response`, and
  `User-Agent: xai-grok-workspace/0.2.120` when the base URL is the direct
  `cli-chat-proxy.grok.com` endpoint.

The CLIProxyAPI Grok model route is selected by a case-insensitive
`grok-shell` User-Agent. Its `/v1/models` response is not a normal OpenAI
catalog: each model includes `model`, `name`, `context_window`,
`api_backend: "responses"`, `supported_in_api`, and optional
`reasoning_efforts`. The ufoo catalog request therefore adds
`?client_version=0.2.120` and the Grok Shell User-Agent.

CLIProxyAPI may emit `event: keepalive` or a `data:` payload with
`{"type":"keepalive"}`. Its latest Grok adapter transforms those into the SSE
comment `: keepalive`, while ufoo ignores them in the Responses parser. They
must never become assistant text or a terminal event.

### Existing provider protocol update

The old direct-provider layer in `src/agents/providers/upstreamTransport.js`
now follows the latest protocol split:

| Provider | Current transport | Current changes |
| --- | --- | --- |
| Codex | Responses-only | ChatGPT Codex base for OAuth, `/responses`, `Session-Id`, `Originator: codex-tui`, optional `Chatgpt-Account-Id`, tool-call IDs, reasoning, and completed/incomplete terminal handling. |
| Claude | Anthropic Messages | Existing OAuth credential path, Messages payload, cache breakpoints, and usage mapping remain the canonical generic Messages implementation. CLIProxyAPI’s latest Claude cloaking/fingerprint/TLS machinery is not duplicated in ufoo. |
| Kimi | Chat Completions | Latest K2.7 coding aliases, dynamic client/device headers, Kimi temperature constraint, and stream usage handling are applied. |
| Grok Build | Responses-only | New direct/native path, Grok Shell identity headers, session header, model route, keepalive handling, and model aliases. |

The Claude note is intentional: the provider now uses the latest supported
Messages contract, but ufoo does not claim to impersonate every Claude Code
CLI wire detail from CLIProxyAPI. If that level of identity emulation becomes a
requirement, it needs a separate credential/TLS boundary rather than changes
to the generic message projector.

## Request and history invariants

The canonical conversation is Session Journal v3. Provider requests are
ephemeral projections:

1. system/bootstrap text goes to Responses `instructions`;
2. public user/assistant/tool turns go to Responses `input`;
3. assistant function calls become public `function_call` items only for the
   provider request, and tool results become `function_call_output` items;
4. private response IDs, event frames, encrypted reasoning metadata, and
   transport bookkeeping are not written into durable messages;
5. each turn returns only newly produced public turn items.

This prevents a provider-specific continuation format from contaminating the
shared history or breaking a later provider switch.

## PTY wrapper state mapping

The `ugrok` wrapper continues to launch the Grok Build CLI and inject prompts
through the existing queue. The Grok Build source gives the following state
precedence:

```text
pending interaction (permission/question/plan approval)
    -> waiting_input
active current prompt
    -> working
no pending interaction and no active prompt
    -> idle/dormant
```

`InteractionResolved` clears the pending interaction. A terminal adapter may
surface permission approval, user question, and plan approval separately, but
all three are user-blocked states for activity tracking.

## Configuration contract

Relevant environment overrides are:

```text
UFOO_GROK_BUILD_BASE_URL   Grok Build Responses base URL
GROK_BUILD_BASE_URL        alias for the above
GROK_BUILD_API_KEY         Grok Build/xAI-compatible key
XAI_API_KEY                official xAI key and Grok fallback key
UFOO_GROK_CLIENT_VERSION   Grok Shell client version override
```

The default native model is configurable and can be overridden through the
normal provider model settings. A missing key is reported by direct auth
status as `GROK_AUTH_MISSING`; no secret is printed in diagnostics.

## Verification gates

The implementation is considered usable when all of the following remain
green:

- `ugrok` wrapper and PTY state tests;
- Responses projection/parser tests, including keepalive and incomplete turns;
- Codex direct upstream tests using `/responses` and canonical headers;
- Grok Build direct upstream tests using the Grok Shell identity;
- model catalog tests for `client_version` and Grok model metadata;
- native tool-call loop tests with public-only turn items;
- full `npm test -- --runInBand`.

Real-provider smoke testing still requires a configured xAI key or a running
CLIProxyAPI instance. Authentication/login for Grok Build OAuth and ACP/stdio
integration are intentionally future work; they are not hidden behind a
Chat Completions compatibility path.

## References

- CLIProxyAPI source: `/Users/icy/Code/CLIProxyAPI` at `v7.2.140`.
- Grok Build source: `/Users/icy/Code/grok-build`.
- xAI Build overview: <https://docs.x.ai/build/overview>.
- xAI headless scripting: <https://docs.x.ai/build/cli/headless-scripting>.
