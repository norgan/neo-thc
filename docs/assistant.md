# NEO assistant

The Assistant view explains saved NEO measurements, connects related findings and proposes practical improvements. It uses the OpenAI Responses API with `gpt-6.1-sol` by default. The model is configurable on the collector. It has no executable tools: it cannot change DNS, disable IPv6, run commands, start scans or claim to have applied a repair.

Open **Assistant**, **Ask NEO assistant** on the NOC, **Explain results with assistant** on Diagnostics, or **Explain DNS comparison** beside a DNS benchmark. Review the evidence, choose a question and send it. The four starter questions cover recent results, priorities, DNS/IPv6 comparison and streaming. Follow-up questions reuse the same reviewed snapshot. **New conversation with latest evidence** prepares a fresh snapshot after more tests.

## What it can explain

| Saved evidence | Interpretation and limits |
| --- | --- |
| DNS benchmark | Resolver transport family, UDP/TCP, A/AAAA, requests, success rates and weighted successful latency. Complete measurement coverage and successful responses take precedence over speed. A partially saved matrix cannot establish a preferred resolver. |
| Targeted DNS | Answers, missing record types, error categories, timings, TTLs and separately labelled operating-system resolution. An AAAA answer does not establish IPv6 connectivity. |
| TCP and TLS checks | Selected destination family/port, connection outcomes and certificate-verified TLS outcomes. |
| Home Internet diagnosis | Gateway/Internet samples, IPv4 path MTU, bounded download evidence and saved adapter settings. Short transfers and three ping samples have limited explanatory power. |
| Imported playback | Actual browser-captured playback, stalls, buffering, decoded resolution and dropped frames. Its device and capture time remain distinct from collector tests. |
| Glances snapshots | Reported CPU, memory and filesystem capacity at a particular time. A single sample does not establish sustained contention or root cause. |
| Discovery and inventory | Scanned scope, response coverage, service evidence and uncertainty. A port hint does not identify a product, and a silent endpoint is not proof of absence. |

The context includes stable evidence IDs, timestamps, collection vantage, completion state, known limitations and explicit omitted-record counts. Recent evidence from each available category is prioritised, with an explicitly selected job first. Identifiers are consistently aliased within that snapshot. The saved benchmark format does not identify which selected resolvers originally came from system configuration, so the assistant reports system-resolver provenance as unknown rather than inventing coverage. Transient desktop CPU/memory/Wi-Fi reads and unsaved current adapter configuration are not silently collected or included.

Answers contain a conversational summary, findings labelled **Measured**, **Likely cause** or **Uncertain**, and prioritised actions. Each action includes its reason, steps, verification and tradeoffs. Evidence buttons open the corresponding saved measurements. NEO validates the response structure and every evidence reference; this does not independently prove that the model interpreted a measurement correctly.

Local findings and the evidence preview remain available without an OpenAI key. Missing measurements lead to a suggested test, not an invented diagnosis or a claim that the network is optimal.

## Windows desktop setup

1. Open **Settings → Desktop connection → Assistant**, or **Configure desktop assistant** from the Assistant view.
2. Enter your OpenAI API key in that separate settings window. The normal app renderer has no credential-read API.
3. Keep the default model, or enter an OpenAI model ID that your API account supports. The implementation expects Responses API structured output and `reasoning.effort: low` support.
4. Choose whether to remember the key. Session-only is the default. Remembering requires protected OS credential storage; there is no plaintext fallback.
5. Apply the settings. A changed local key/model restarts the owned standalone collector, stopping its local work and resetting the page. Saved diagnostics are retained.

**Remove API key** disables the local assistant credential, including inherited environment credentials. Session-only replacement is not restored on the next application launch. An optionally remembered key is encrypted with Electron `safeStorage` in the OS application-data profile; the plaintext key is never written to SQLite or returned by the status API.

In **remote mode**, the selected collector uses its own OpenAI configuration. Local desktop keys are never forwarded to that server or placed in the remote proxy process environment. The setup window explains which configuration applies. Changing the remembered local key while remote does not change the remote server.

This feature calls the OpenAI API using the configured API account. It does not reuse the current ChatGPT conversation or obtain a key from a ChatGPT login. API account access and usage charges apply.

## Source and service configuration

| Environment variable | Meaning |
| --- | --- |
| `NEO_OPENAI_API_KEY` | Collector-specific OpenAI key. An explicitly empty value disables fallback. |
| `OPENAI_API_KEY` | Optional fallback when `NEO_OPENAI_API_KEY` is absent. |
| `NEO_OPENAI_MODEL` | Model ID; default `gpt-6.1-sol`. |

Provide secrets through the service account's protected environment or secret manager, then restart that collector. Do not commit them, put them in URLs, or type them into the assistant conversation. A standalone Bash source session can read a key without placing it in shell history:

```bash
read -r -s -p 'OpenAI API key: ' NEO_OPENAI_API_KEY
export NEO_OPENAI_API_KEY
export NEO_OPENAI_MODEL=gpt-6.1-sol
npm start
```

For the supplied systemd template, an administrator can add a service override containing `EnvironmentFile=/etc/neo-thc/openai.env` and provide the variables in that account-restricted file. Its content is deployment-specific and is not shipped in the bundle. Native child processes, including `dns-bench` and Windows DNS configuration readers, receive an environment with OpenAI credentials removed.

The API destination is fixed to `https://api.openai.com/v1/responses`, uses verified HTTPS and rejects redirects. There is no client-supplied base URL, model override, system prompt, arbitrary history, command executor or model tool endpoint.

## Data review and retention

Preparing a preview reads saved local records only. It performs no network tests, current device reads or OpenAI request. The exact evidence text is shown before sending and is frozen under a short-lived preview ID, so a new test finishing cannot silently add data to an already reviewed upload.

By default, addresses and hostnames are replaced with aliases, apart from recognised public benchmark resolvers and fixed public test domains. **Include network addresses and names** prepares a new review and clears the previous consent and conversation. Arbitrary interface labels, filesystem paths, raw diagnostic errors, advertisement payloads, credentials and media URLs are excluded. User-entered questions are sent as written, together with previous questions and validated replies from the current conversation.

NEO requests `store: false`. This disables ordinary Responses API application-state storage; it is not a promise of zero provider retention. OpenAI account policies, abuse monitoring and applicable caching retention still apply. The provider receives the collector's source IP. Review [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data) for the account-specific policy.

Conversation state lives only in collector memory and the page's React state. It is not written to SQLite, browser local storage or log files. Collector conversations expire after 30 minutes of inactivity; page refresh removes that page's view. Starting a new conversation clears its associated collector state. Shutdown cancels active inference and discards all assistant state. Saved diagnostic reports remain in the existing local database.

## Bounds and failure behaviour

- Evidence preview: at most 48,000 characters; new previews expire after 15 minutes. Follow-ups retain their original context for the active conversation.
- Conversation: at most eight turns; questions at most 4,000 characters; at most eight concurrent retained conversations per collector.
- Inference: one active request per collector, a 60-second deadline and a 6,000-token output budget. Remote proxy timeout allows five additional seconds for transport.
- Provider response: at most 256 KiB, validated structured JSON with known evidence IDs. Refusal, incomplete output, invalid JSON or unknown citations produce an explicit error instead of unverified advice.
- Requests use idempotency IDs in bounded memory. Retrying an ambiguous connection failure reuses the request ID. A deliberate retry after a definitive API failure uses a new ID. There are no automatic paid retries.
- Cancel, connection loss and server shutdown abort the owned request. Cancellation cannot guarantee that a provider has not already processed or billed the submitted request.
- Missing credentials, inaccessible models, rate limits and provider failures leave local collection and diagnostics available. Status reports configuration availability; authentication and account model access are only verified when a question is sent.

There is one shared administrative access token per remote collector, as in the existing deployment model. Assistant state is scoped to opaque conversation and preview IDs, not a new multi-user account system.

## API

| Route | Behaviour |
| --- | --- |
| `GET /api/v1/assistant/options` | Configuration availability, model and fixed limits; no credential or provider call. |
| `POST /api/v1/assistant/preview` | `{includeIdentifiers?, focusJobId?}` → frozen preview, evidence, exact outbound text and disclosure. |
| `POST /api/v1/assistant/chat` | `{requestId, previewId, conversationId?, message, confirmed:true}` → validated answer, evidence references, model, usage and remaining turns. |
| `POST /api/v1/assistant/cancel` | `{requestId}` → abort that active inference request. |
| `POST /api/v1/assistant/reset` | `{conversationId?, previewId?}` → cancel matching work and clear its temporary state. |

Existing local Host/Origin/client-header checks and remote authenticated TLS apply to every route. No endpoint accepts client-supplied evidence or model history.

## Verification and official references

Tests use explicit injected provider responses, never a hidden production simulation flag or a live API credential. They cover consent, frozen evidence, identifier minimisation, incomplete matrices, IPv4/IPv6 separation, contextual source links, structured output, credentials, cancellation, shutdown, request replay, manual retry and missing-key behaviour. Actual Windows packaging checks exercise the trusted setup window, protected credential persistence and local/remote process isolation without calling OpenAI. Live model quality and a user's real network still require a configured key and actual measurements.

- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)
- [GPT-6.1 Sol model](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [API production practices](https://developers.openai.com/api/docs/guides/production-best-practices)
