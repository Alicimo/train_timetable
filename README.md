# Bad Vöslau ↔ Wien Train Updates

A small web service showing live departures between Bad Vöslau and Wien Hauptbahnhof.

## Architecture

The Node.js service serves both the static interface and a live JSON endpoint:

- `GET /` serves `index.html`.
- `GET /api/departures` returns upcoming direct trains from ÖBB HAFAS journey searches.
- `GET /healthz` reports whether the service process is available.

The service queries Bad Vöslau Bahnhof (`8100708`) and Wien Hbf (`8103000`) in both
directions and accepts both Vienna platform groups. It follows journey pages through
the two-hour window and searches 30 minutes back for trains still due to depart.

Successful HAFAS responses are cached in memory for 60 seconds by default. Concurrent
requests share one refresh, and the last successful response is served as stale data if
an upstream refresh fails. No generated data file or scheduled deployment is required.

## Local Development

Node.js 20 or newer is required.

```bash
npm ci
npm start
```

Open <http://127.0.0.1:3000>. Useful checks are:

```bash
npm run check
npm test
curl http://127.0.0.1:3000/healthz
curl http://127.0.0.1:3000/api/departures
```

`node fetch_departures.js` fetches one live snapshot from HAFAS and prints the resulting JSON
without starting the web service.

The service accepts these environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listen address |
| `PORT` | `3000` | Listen port |
| `CACHE_TTL_SECONDS` | `60` | Duration of a fresh HAFAS response |
| `HAFAS_USER_AGENT` | `train-updates` | Application identifier sent to HAFAS |
| `HAFAS_TIMEOUT_SECONDS` | `15` | Maximum duration of one HAFAS refresh |

## Telegram alerts

Open **Telegram alerts** on the train dashboard, enter your bot token and chat ID,
and choose **Save and send test**. For a private chat, send a message to the bot
first. The service applies the settings after Telegram accepts the test message
and the settings are saved. Leave the token blank when changing the chat to reuse
your saved token. **Disable alerts** pauses notifications and keeps the saved
credentials for the next time you enable them. The bot sends a confirmation to
the saved chat. If delivery fails, the dashboard reports it and alerts stay off.

In the same dropdown, choose **Notification days**, add time windows, and set the
**Minimum train delay (minutes)** in five-minute steps. Select **Save notification
preferences** to apply your changes. Without windows, alerts can be sent all day
on the selected days. Clear every day to pause scheduled alerts. Times use
Europe/Vienna, including daylight saving. A window that ends earlier than it
starts continues into the following day. Each window applies to the time an
alert is sent and can cover either route direction or both. The service discards
saved windows that have no direction. Schedules with no windows cover both
directions all day on the selected days. Notification preferences take effect without
restarting the service or sending a test message.

The dashboard and its settings are intended for access over a private network
such as Tailscale. Anyone who can reach the dashboard can change the alert settings.

The service uses the same departure cache as the website. About once a minute it
checks all upcoming trains returned for both directions. The snapshot covers two hours of scheduled
departures per direction and includes recently scheduled trains still due to depart. The bot sends an initial alert for a
cancellation or a delay that reaches the configured minimum, which defaults to
10 minutes. For a reported delay, it sends an update when the delay reaches a
higher five-minute band at or above the minimum or drops by at least five minutes
from the last reported delay. If a reported delay reaches zero, the bot sends one
“back on time” update even when the final drop is smaller than five minutes.
A cancellation can follow a delay alert. Stale
departure data and unknown delay values do not trigger delay alerts.
The service remembers successful sends in memory, so restarting the service or
changing the destination can repeat a recent alert.

The dashboard also shows U1 service notices for the Hauptbahnhof–Stephansplatz
commute. The notices describe the U1 line and may omit the affected stops.
It displays both detailed and short notices, with identical short notices grouped.
The bot sends detailed U1 notices once per notice ID during an eligible window for
either commute direction. It retries failed deliveries and skips stale data. U1
checks use an independent cache and continue if the ÖBB feed is unavailable.
Service notice data comes from [Wiener Linien Open Data](https://www.wienerlinien.at/open-data).

Telegram settings survive restarts. The NixOS module provides a private systemd
state directory. Local runs store the settings under `.train-updates-state/` in
the working directory.

To seed the initial settings on NixOS, point
`systemd.services.train-updates.serviceConfig.EnvironmentFile` at a private file
containing `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. The service imports these
values only when the settings file is absent. Once saved, dashboard settings take
precedence, including when alerts are disabled.

## Train delay history

The backend checks the shared ÖBB departure cache about once a minute, even with
Telegram disabled. It keeps the first fresh observation of each run within two
minutes before its scheduled departure. Stale snapshots are skipped. A longer
cache TTL, downtime, or missing feed data can leave gaps in the history.

The service stores one JSON object per line under
`STATE_DIRECTORY/train-delay-history/YYYY-MM-DD.jsonl`, using the scheduled
departure date in Europe/Vienna. Local runs default to `.train-updates-state/`.
Files are retained across restarts and are not automatically deleted. Each row
contains `observedAt` and `scheduledDeparture` as ISO timestamps, route
`direction`, `tripId`, `trainNumber`, `serviceName`, `delaySeconds`, and
`cancelled`. Zero means ÖBB reported zero delay. A null delay means no estimate.

To estimate the chance of a delay, group runs by train number and direction,
using the Vienna-local scheduled time to distinguish timetable slots if needed.
Among observed, non-cancelled runs with a numeric estimate, divide the count at
or above the chosen delay threshold by the total. Count cancellations separately.
This measures ÖBB's near-departure estimate. Unknown and missed runs do not
contribute to the denominator.

## Nix

Run or build the packaged service directly:

```bash
nix run
nix build
nix flake check
```

The flake exports `nixosModules.default`. Add it to the NixOS host configuration and
place the host's existing reverse proxy in front of the loopback service:

```nix
{
  inputs.train-updates.url = "github:OWNER/train_updates";

  outputs = { nixpkgs, train-updates, ... }: {
    nixosConfigurations.my-server = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        train-updates.nixosModules.default
        ({ ... }: {
          services.train-updates = {
            enable = true;
            listenAddress = "127.0.0.1";
            port = 3000;
            cacheTtlSeconds = 60;
            hafasUserAgent = "train-updates (https://trains.example.com)";
            hafasTimeoutSeconds = 15;
          };

          services.nginx.virtualHosts."trains.example.com" = {
            enableACME = true;
            forceSSL = true;
            locations."/".proxyPass = "http://127.0.0.1:3000";
          };
        })
      ];
    };
  };
}
```

The module does not open a firewall port or configure a domain, reverse proxy, or TLS.
It runs the service as a dynamic systemd user with a private writable state directory
for Telegram settings.

## JSON Contract

The departure API returns `badVoeslauToWien`, `wienToBadVoeslau`, `lastUpdated`, and
`stations`. Train rows use compact display keys such as `ti`, `st`, `pr`, `tr`, and the
optional expected departure value `rt.dlt`. The `ti` field holds the scheduled time,
and `delay` is in seconds or `null` when HAFAS has no delay estimate.
The `arrival` field holds the destination arrival time in Vienna local time, using
the expected time when available and the timetable otherwise. It is `null` for
cancelled services or when neither arrival time is available.
