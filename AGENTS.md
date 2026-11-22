# Repository Guide

## Active Application

- The deployed application is the Node.js service in `server.js`. It serves `index.html`,
  `/api/departures`, and `/healthz` from one process.
- `fetch_departures.js` contains the ÖBB HAFAS queries and returns the JSON response. When
  run directly, it fetches one live snapshot and prints JSON to stdout.
- Departures are cached in memory. There is no generated `departures.json`, scheduled CI
  refresh, frontend build step, or persistent departure data. Telegram settings are stored separately.
- `pyproject.toml`, `uv.lock`, and `.python-version` are remnants of the removed Python
  application. There is no Python source or active Python test suite.

## Commands

- Install dependencies with `npm ci`.
- Start locally with `npm start`, then use `http://127.0.0.1:3000`.
- Run JavaScript syntax checks with `npm run check`.
- Run the Node test suite with `npm test`.
- Run a live HAFAS integration check with `node fetch_departures.js`. It requires the
  external ÖBB HAFAS service and prints a large JSON response.
- Verify Nix packaging and tests with `nix flake check path:.` when files are untracked, or
  `nix flake check` once they are tracked.
- Build without creating a `result` symlink using `nix build path:. --no-link`.

## Data And Runtime

- Preserve the JSON contract consumed by `index.html`: `badVoeslauToWien`,
  `wienToBadVoeslau`, `lastUpdated`, and `stations`; train rows use compact keys such as
  `ti`, `st`, `pr`, `tr`, and optional `rt.dlt`.
- Both directions use paginated HAFAS journey searches for direct trains between Bad
  Vöslau Bahnhof (`8100708`) and Wien Hbf (`8103000`). Journey legs may also use
  `8101590` for Vienna platforms 1–2.
- The cache coalesces concurrent refreshes and serves its last successful response as
  stale data when HAFAS is temporarily unavailable. An initial upstream failure returns
  HTTP 502.
- Runtime settings are `HOST`, `PORT`, `CACHE_TTL_SECONDS`, `HAFAS_USER_AGENT`, and
  `HAFAS_TIMEOUT_SECONDS`.

## NixOS Deployment

- `flake.nix` exports the default package, app, development shell, checks, and
  `nixosModules.default`.
- The NixOS module defines `services.train-updates` and binds to `127.0.0.1:3000` by
  default. The host configuration owns reverse proxying, TLS, DNS, and firewall policy.
- The systemd unit uses a dynamic user and a private state directory for Telegram settings.
- Do not edit `node_modules/hafas-client`; `npm ci` and Nix recreate dependencies from
  `package-lock.json`.

## Serving a Tailnet Preview

1. Run `tailscale serve status` and check whether the app already answers at
   `http://127.0.0.1:3000/healthz`. Reuse a healthy instance and its route when possible.
   Check that the Serve port you plan to use is free.
2. From the repository root, run `npm start` in a session that stays open. To share
   the preview after that session closes, use a temporary user launchd job on macOS.

   ```bash
   preview_dir=$(mktemp -d /private/tmp/train-updates-preview.XXXXXX)
   launchctl submit -l local.train-updates-preview \
     -o "$preview_dir/server.log" -e "$preview_dir/server.err" -- \
     /usr/bin/env -u TELEGRAM_BOT_TOKEN -u TELEGRAM_CHAT_ID \
     HOST=127.0.0.1 PORT=3000 STATE_DIRECTORY="$preview_dir/state" \
     "$(command -v node)" "$PWD/server.js"
   ```

   This starts the preview with its own settings directory and without seeded
   Telegram credentials. On NixOS, use the existing `train-updates` systemd service
   when it is already deployed.
3. Verify the local health endpoint, then configure Tailscale Serve. If HTTPS Serve
   is enabled, open the HTTPS URL it prints.

   ```bash
   curl -fsS http://127.0.0.1:3000/healthz
   tailscale serve --bg http://127.0.0.1:3000
   ```

   If HTTPS Serve is disabled or the MagicDNS hostname fails to resolve, use a
   tailnet-only TCP forward on port 8080 and share the HTTP URL by IP.

   ```bash
   tailscale serve --bg --tcp=8080 tcp://127.0.0.1:3000
   preview_url="http://$(tailscale ip -4):8080"
   curl -fsS "$preview_url/healthz"
   curl -fsS "$preview_url/api/departures"
   printf '%s/\n' "$preview_url"
   ```

4. Verify the dashboard through the URL you send. Use Tailscale Serve for this
   preview because the dashboard includes editable Telegram settings.
5. To stop the preview, remove only its route and stop the preview process. For
   the TCP route use `tailscale serve --tcp=8080 off`. For the HTTPS route use
   `tailscale serve --https=443 off`. If you created the macOS job, stop it with
   `launchctl remove local.train-updates-preview`.
