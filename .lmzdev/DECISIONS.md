# Decisions

Record durable decisions with date, context, decision, and consequences.

## 2026-08-23 | Provider-safe memory and bounded transport

- Normal recall is a provider boundary: session secrets and local-only records are excluded rather than relying on downstream callers to remember a privacy flag.
- Metadata DLP fails closed on traversal limits, UTF-8 byte limits, secret-bearing canonical key aliases, and repository source/origin variants.
- All Laravel-facing desktop memory/context/API health traffic uses one 10-second hard deadline that also settles when a transport ignores AbortSignal.

## 2026-08-26 | Lokaler Testinstaller bleibt von Produktionsidentitaet und Signing getrennt

- Context: Ein installierbarer Windows-Smoke-Build soll ohne erfundene Zertifikate oder Updaterwerte moeglich sein und darf eine bestehende Luczor-Produktionsinstallation nicht still ersetzen.
- Decision: `.nvmrc` pinnt Node 22.22.0; projektlokale PowerShell-Wrapper nutzen diese installierte NVM-Version und Corepack nur im Kindprozess, ohne `nvm use`. Der lokale NSIS-Build verwendet `Luczor Local Test`, `de.luczor.desktop.local-test`, `currentUser`, `--no-sign` und eine direkte PE-Zertifikatstabellenpruefung. Das Produktions-Gate verlangt weiterhin die vollstaendige Updaterintegration und echte Signing-Secrets.
- Consequence: Lokale Installer-QA ist reproduzierbar und prod-neutral. Veroeffentlichung, Zertifikatsimport, signierter Build sowie Update-/Rollback-Abnahme bleiben absichtlich blockiert, bis echte Werte und ein eigener Produktionsworkflow vorhanden sind.
