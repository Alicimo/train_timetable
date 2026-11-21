# Bad Vöslau ↔ Wien Train Updates

A small web service showing live departures between Bad Vöslau and Wien Hauptbahnhof.

## Architecture

The Node.js service serves both the static interface and a live JSON endpoint:

- `GET /` serves `index.html`.
- `GET /api/departures` queries ÖBB HAFAS and returns filtered departures.
- `GET /healthz` reports whether the service process is available.

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

`node fetch_departures.js` performs one live HAFAS request and prints the resulting JSON
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

The dashboard and its settings are intended for access over a private network
such as Tailscale. Anyone who can reach the dashboard can change the alert settings.

The service uses the same departure cache as the website. About once a minute it
checks all upcoming trains returned for both directions. The fetch requests two
hours of departures per direction. The bot sends an initial alert for a
cancellation or a delay of at least five minutes. For a reported delay, it sends
an update when the delay reaches a higher five-minute band or drops by at least
five minutes from the last reported delay. A train going from 10 to 9 minutes late
does not trigger an update. A cancellation can follow a delay alert. Stale
departure data does not trigger alerts.
The service remembers successful sends in memory, so restarting the service or
changing the destination can repeat a recent alert.

Telegram settings survive restarts. The NixOS module provides a private systemd
state directory. Local runs store the settings under `.train-updates-state/` in
the working directory.

To seed the initial settings on NixOS, point
`systemd.services.train-updates.serviceConfig.EnvironmentFile` at a private file
containing `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. The service imports these
values only when the settings file is absent. Once saved, dashboard settings take
precedence, including when alerts are disabled.

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
optional real-time departure value `rt.dlt`.
