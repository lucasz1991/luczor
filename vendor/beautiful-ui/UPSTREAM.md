# Beautiful UI source snapshot

- Project: https://www.beautifului.dev/
- Source: https://github.com/slev12397/beautiful-ui
- Revision: `06557d7ff33a1eb70d5987bae9ac4c70fa0e20c4`
- Retrieved: 2026-09-06
- Copyright: 2026 Shane Levine
- License: [MIT](LICENSE)

`primitives/` contains the original 21 gallery components plus the shared
`GlideMenu`. `shared/` contains the original `components/atoms/` files.
`globals.css` is the original design foundation. These files are an unmodified,
reviewable reference snapshot. They are excluded from the application build and
Tailwind scanning. They are not installed or executed.

`SOURCE-HASHES.json` records SHA-256 hashes of all 35 original files, verified
against the checkout at the revision above.

Luczor uses Vue 3 adaptations in `src/components/ai/`, with shared CSS in
`src/styles/beautiful-ui.css`. The Vue implementations retain the visual patterns
and replace React hooks, scripted timers and demo data with props, events and
Luczor state. Native SVG icons replace the upstream commercial icon dependency.
No React, Next.js, analytics, remote media, paid icon package or new runtime
dependency is installed by this integration.

See `docs/beautiful-ui.md` for the integration map and runtime boundaries.
