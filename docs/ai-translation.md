# Direct AI translation

Open a project with current source content and choose **AI translation**. Select a connection preset or enter a custom full Chat Completions URL, model and API key environment variable name. Presets supply editable connection defaults; choose a model explicitly. For a service without authentication, clear the environment variable name. Set credentials in the environment before launching the desktop application; never paste a key into a URL or into the name field.

Remote endpoints require HTTPS. HTTP is allowed only for loopback endpoints. URL credentials, query strings, fragments and redirects are rejected. Choose the token field expected by the service: `max_tokens` or `max_completion_tokens`; the client does not silently switch fields or providers.

The default budget is 20 selected units, concurrency 1, at most 20 requests, 2,000 output tokens per request, no automatic retries and a 60-second request timeout. You can edit the limits within the bounds shown in the form. Retries are limited to 429 and 503 responses and consume the same request budget. A network interruption or timeout is recorded as an unknown outcome and is never automatically retried. Cost and complete usage may be unknown even when a candidate succeeds.

Select the target language and source units. Adopted applicable terms and captured context are optional and off by default. **Preview what will be sent** shows the full source text, destination, budget, selected resources and omissions. Changing inputs invalidates the preview and consent. Confirm sharing before sending.

Requests contain text only: a fixed translation system instruction and a user message containing JSON text. No files, images, audio or tools are sent. The service must return a single assistant choice with `finish_reason: "stop"` and JSON content containing exactly `unitId`, `targetLocale` and `text`, copying the supplied identity and locale. The client validates output locally; it does not request a server-side JSON Schema mode.

Results are saved per unit. **Save candidate** adds an immutable AI revision to the ordinary translation history without selecting it or approving it. **Compare and select in editor** lets you compare, select, edit and run the normal checks. Manual selections and other languages are preserved. Changed source or removed target languages prevent stale candidate adoption.

Tasks retains input, recipe, model, output and adoption receipts after reopening a project. Reopening does not send requests. A prior AI attempt cannot use generic resume or retry actions to bypass its budget; create and confirm a new preview for additional generation. If a start or adoption response is lost, check the saved result or receipt before retrying the same action. Closing a project with running work uses the existing stop-and-preserve workflow.
