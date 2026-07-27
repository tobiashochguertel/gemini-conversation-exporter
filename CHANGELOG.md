# Changelog

## 0.1.4 - 2026-07-27

- Preserve Gemini's `/u/<account>/` prefix on history RPC requests.
- Forward the active Gemini `pageId` query parameter to the history RPC.
- Fix HTTP 400 errors when exporting from secondary signed-in accounts.

## 0.1.3 - 2026-07-27

- Support account-scoped Gemini URLs such as `/u/0/app/...`.
- Use Tampermonkey's JavaScript sandbox so Firefox can inject through Gemini's
  Content Security Policy.
- Clone page-fetch request options into Firefox's page realm.

## 0.1.2 - 2026-07-27

- Prepare the first public release.
- Add project, support, author, and license metadata.
- Generate the userscript version from `package.json`.
- Document privacy, limitations, installation, and maintenance behavior.

## 0.1.1 - 2026-07-27

- Replace Shadow DOM `innerHTML` construction with Trusted Types-compatible
  DOM APIs.
- Add a regression test for Gemini's Trusted Types policy.

## 0.1.0 - 2026-07-27

- Initial working exporter using Gemini's paginated conversation history RPC.
