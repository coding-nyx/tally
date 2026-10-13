# Hub deployment — 13 October 2026

- Private URL: https://finance.example.ts.net/finance/
- `/finance` redirects to `/finance/`.
- Tailscale HTTPS on 443 forwards to Caddy on `127.0.0.1:9080`.
- Caddy preserves `/finance/` when forwarding to Tally on `127.0.0.1:3001`; other paths forward to Vaultwarden on `127.0.0.1:8222`.
- Caddy's admin listener is `127.0.0.1:2019`. There is no public Funnel or new listener on all interfaces.
- Compose project: `tally`; containers: `tally-finance-1`, `tally-gateway-1`. Both restart automatically. Docker and Tailscale are enabled at boot.
- Release directory: `/srv/tally/releases/20261013-finance1`; current symlink: `/srv/tally/current`.

## Data and secrets

This deployment hosts the existing browser-local release. There is no shared ledger database, cross-device sync, account sign-in, or active agent HTTP API. Browser JSON export/restore is required to move records between origins or devices. Container backups do not back up browser records. No AI provider credentials were configured or copied; spending chat remains disabled.

## CasaOS removal

The six CasaOS services, installed binaries, unit files, configuration, dashboard, and application catalog were removed. Docker, Vaultwarden and its bind-mounted data, Tailscale, k3s-agent, rclone, and devmon were preserved. No container, image, volume, or application-data prune was performed.

A root-only rollback archive and route/removal records remain in `/var/backups/tally-migration/20261013-finance1/`. The CasaOS archive is `casaos-rollback.tar`. It may contain private configuration and must stay restricted; it is not an off-device backup.

## Verification

- Local standalone and default Vercel builds, typecheck, and lint passed.
- 301 tests passed, 2 skipped, 0 failed; synthetic fixtures only. Tests used `TMPDIR=/tmp` because the current sandbox does not permit the macOS default temporary directory.
- Linux ARM64 image built on hub. Tally reports healthy; Vaultwarden stayed healthy.
- Live HTTPS document, scripts, stylesheet, favicon, manifest, and chat availability server function returned 200. The manifest's ID, scope, and start URL are `/finance/`.
- Desktop 1280×800 and mobile 390×844 rendering was visually inspected through an isolated agent-browser session. No uncaught errors or mobile horizontal overflow. Entry/import dialogs, cancellation, reload, and the canonical redirect were checked.
- The standard `browser-smoke.mjs` could not launch its missing Playwright Chromium executable; the live checks above used agent-browser.
- CasaOS unit inventory is empty; preserved services are active. Root filesystem settings, Wi-Fi, cooling, power resilience, and shared database migration remain future work.
