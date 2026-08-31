{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.train-updates;
in
{
  options.services.train-updates = {
    enable = lib.mkEnableOption "the train updates web service";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      description = "The train updates package to run.";
    };

    listenAddress = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address on which the service listens.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3000;
      description = "Port on which the service listens.";
    };

    cacheTtlSeconds = lib.mkOption {
      type = lib.types.ints.positive;
      default = 60;
      description = "How long a successful HAFAS response remains fresh.";
    };

    hafasUserAgent = lib.mkOption {
      type = lib.types.str;
      default = "train-updates";
      description = "Application identifier sent to the HAFAS endpoint.";
    };

    hafasTimeoutSeconds = lib.mkOption {
      type = lib.types.ints.positive;
      default = 15;
      description = "Maximum duration of a HAFAS refresh.";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.train-updates = {
      description = "Train updates web service";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];

      environment = {
        HOST = cfg.listenAddress;
        PORT = toString cfg.port;
        CACHE_TTL_SECONDS = toString cfg.cacheTtlSeconds;
        HAFAS_USER_AGENT = cfg.hafasUserAgent;
        HAFAS_TIMEOUT_SECONDS = toString cfg.hafasTimeoutSeconds;
      };

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        Restart = "on-failure";
        RestartSec = 5;

        DynamicUser = true;
        CapabilityBoundingSet = "";
        LockPersonality = true;
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        ProcSubset = "pid";
        ProtectClock = true;
        ProtectControlGroups = true;
        ProtectHome = true;
        ProtectHostname = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        ProtectProc = "invisible";
        ProtectSystem = "strict";
        RemoveIPC = true;
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        SystemCallArchitectures = "native";
        UMask = "0077";
      };
    };
  };
}
