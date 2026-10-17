# Test with a real phone on your local network

Phones only allow the camera on HTTPS pages (or `localhost`), and the phone
must reach the media plane's WebRTC port directly. This setup serves the
console over HTTPS on your laptop and proxies the API and the media
signalling WebSocket through it, so the phone needs just one address.

**You need:** this repo, Docker, Node 24 + pnpm, and the laptop and phone on
the same Wi-Fi.

1. **Find your laptop's LAN IP** (macOS): `ipconfig getifaddr en0`, e.g.
   `192.168.1.23`. Below, replace `LAN_IP` with it.

2. **Start the stack** (API and media run as separate containers):
   ```sh
   cd deploy/compose
   export LAN_IP=192.168.1.23
   MEDIA_ANNOUNCED_ADDRESS=$LAN_IP \
   CAPTURE_URL=https://$LAN_IP:5173/capture.html \
   MEDIA_URL=wss://$LAN_IP:5173/media/ \
   MEDIA_PUBLIC_URL=https://$LAN_IP:5173/media \
   API_PUBLIC_URL=https://$LAN_IP:5173/api \
   CONSOLE_ORIGIN=https://$LAN_IP:5173 \
   docker compose --profile app up -d --build
   ```

3. **Start the console over HTTPS** (self-signed certificate), in another terminal from the repo root:
   ```sh
   pnpm install && pnpm --filter senseplane build
   DEV_HTTPS=1 DEV_HOST=0.0.0.0 DEV_API_URL=http://localhost:58080 DEV_MEDIA_URL=http://localhost:58090 \
     pnpm --filter @senseplane/console dev
   ```

4. **On the laptop**, open `https://LAN_IP:5173` and accept the certificate
   warning. Choose **Create an account** and sign up with any email and a
   password of at least 10 characters (the development stack allows sign-up;
   nothing is emailed). Already have an account? Sign in instead.

5. Press **Add phone or laptop camera**. A QR code appears.

6. **On the phone**, scan the QR code. Accept the certificate warning (Safari:
   "Show Details" → "visit this website"), allow the camera, and keep the page
   open with the screen on. You should see the preview and the red
   **"Senseplane is watching"** indicator. **Pause** and **Stop** finish the
   recording cleanly.

7. **Check the recording** after a minute:
   ```sh
   docker compose -f deploy/compose/docker-compose.yml exec postgres \
     psql -U senseplane -c "select start_at, duration_ms, key from segments order by start_at desc limit 5"
   ```
   New ~6 s segments should appear every few seconds. The objects are in the
   S3 console at http://localhost:59001 (user `senseplane`, password
   `senseplane-secret`), bucket `senseplane`, under `raw/`.

## If it doesn't connect

- **Stuck on "Connecting…":** the phone can't reach UDP/TCP port 40000 on
  `LAN_IP`. Allow incoming connections for Docker in the macOS firewall, check
  that `MEDIA_ANNOUNCED_ADDRESS` is the laptop's current LAN IP, and that the
  phone isn't on a guest network that isolates clients.
- **"This page needs HTTPS":** open the `https://` address, not `http://`.
- **Camera permission denied:** iOS Settings → Safari → Camera → Allow, then reload.
- **Video drops when the screen locks:** expected; browsers pause the camera in
  the background. Keep the page open, or use an IP camera through the bridge
  for an always-on camera ([Self-hosting](../self-host.md#ip-cameras-and-the-bridge)).
