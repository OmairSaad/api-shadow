# Changelog

## 0.2.0

- **CodeLens** above every route declaration: full method and path, auth, duplicate warnings, and request actions.
- **Try it**: open a ready-to-send `.http` request (REST Client / JetBrains HTTP Client format) beside the code, with path parameters, required query parameters, headers, a JSON body and a bearer token header filled in.
- **Copy as cURL** from the CodeLens, the endpoint context menu or the Command Palette.
- **Export Endpoints to .http Requests**: a request collection for the whole API, with shared variables.
- The base URL uses the port from `app.listen()` or `server.port`, or the new `apiShadow.requests.baseUrl` setting.
- **Auth detection**: auth middleware, guards and security annotations, global NestJS guards (`APP_GUARD`, `app.useGlobalGuards()`), explicit opt-outs (`@Public()`, `@PermitAll`), and Spring Security filter chains. Shown in the sidebar, the CodeLens, tooltips and the Markdown export.
- **Endpoints without detected auth**: write endpoints and admin paths without auth, in projects that use auth elsewhere, are listed in the Issues view and counted in the status bar (`apiShadow.auth.warnings`).
- The text filter matches `auth:none`, `auth:protected`, `auth:public` and `auth:central`.
- Global NestJS guards are now listed in each endpoint's middleware, with a note saying where they come from.

## 0.1.0

Initial release.

- Static discovery of Express, NestJS and Spring Boot (Java) endpoints.
- Endpoints sidebar with grouping, text and HTTP-method filters, search, and navigation to source.
- Controller → service relationships where statically identifiable.
- Potential duplicate route detection (sidebar, Issues view and Problems panel).
- Issues view listing parse errors and analysis limitations.
- Export to Markdown and OpenAPI 3.0 JSON.
- Incremental re-analysis on file changes, cancellation, and a persistent per-file cache.
