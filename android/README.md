# Senseplane for Android

The app turns an Android phone (8.0 or newer) into a Senseplane box: it sends
its camera, relays the IP cameras on its Wi-Fi, listens for Bluetooth
sensors, reads Matter devices shared to it with a pairing code (ADR 0065),
and lets owners and admins chat and set watches. See
[ADR 0064](../docs/decisions/0064-the-phone-as-a-box.md).

## Build

You need the Android SDK (platform 34, NDK 26), Go and `gomobile`
(`go install golang.org/x/mobile/cmd/gomobile@latest`).

```sh
./build-bridge.sh                 # the bridge as app/libs/senseplane-bridge.aar
./gradlew :app:assembleDebug      # app/build/outputs/apk/debug/app-debug.apk
```

## Test

```sh
./gradlew :app:testDebugUnitTest  # frames, sensors, status and API client
```

End to end, on an emulator or a phone, against a running Senseplane
(`docker compose -f deploy/compose/docker-compose.yml --profile app up -d`)
and an owner API key for it:

```sh
./gradlew :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.server=http://10.0.2.2:58080 \
  -Pandroid.testInstrumentationRunnerArguments.whipBase=http://10.0.2.2:58090 \
  -Pandroid.testInstrumentationRunnerArguments.ownerKey=sk_...
```

`10.0.2.2` is the computer, as the emulator sees it. To include Matter, run
the fake plug on the computer (`cd ../bridge && go run ./cmd/matter-fake-device`)
and add `-Pandroid.testInstrumentationRunnerArguments.matterAddress=10.0.2.2:5540`:
the app adds it with its code and the test waits for its power readings. The test pairs the app,
checks its camera is online and recording, turns on its battery sensor and
waits for the reading. It saves a screenshot of every screen in
`/sdcard/Android/data/com.senseplane.app/files/shots`.
