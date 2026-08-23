# Decisions

Record durable decisions with date, context, decision, and consequences.

## 2026-08-23 | Provider-safe memory and bounded transport

- Normal recall is a provider boundary: session secrets and local-only records are excluded rather than relying on downstream callers to remember a privacy flag.
- Metadata DLP fails closed on traversal limits, UTF-8 byte limits, secret-bearing canonical key aliases, and repository source/origin variants.
- All Laravel-facing desktop memory/context/API health traffic uses one 10-second hard deadline that also settles when a transport ignores AbortSignal.
