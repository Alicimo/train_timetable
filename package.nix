{
  lib,
  buildNpmPackage,
  makeWrapper,
  nodejs,
}:

buildNpmPackage {
  pname = "train-updates";
  version = "1.0.0";

  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./apple-touch-icon.png
      ./fetch_departures.js
      ./fetch_departures.test.js
      ./index.html
      ./package-lock.json
      ./package.json
      ./server.js
      ./server.test.js
      ./telegram_alerts.js
      ./telegram_alerts.test.js
      ./telegram_settings.js
    ];
  };

  npmDepsHash = "sha256-fB0dq1mlj9jF7o7nCxdPQkVe/7nWd6ig0SdepujUO+k=";
  dontNpmBuild = true;

  nativeBuildInputs = [ makeWrapper ];

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm test
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/bin" "$out/lib/train-updates"
    cp apple-touch-icon.png fetch_departures.js index.html package.json server.js telegram_alerts.js telegram_settings.js "$out/lib/train-updates/"
    cp -r node_modules "$out/lib/train-updates/"
    makeWrapper ${lib.getExe nodejs} "$out/bin/train-updates" \
      --add-flags "$out/lib/train-updates/server.js"

    runHook postInstall
  '';

  meta = {
    description = "Live Bad Voeslau and Wien train departures";
    license = lib.licenses.isc;
    mainProgram = "train-updates";
    platforms = lib.platforms.all;
  };
}
