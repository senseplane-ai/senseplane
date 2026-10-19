# Load-test your server

How many cameras will your server take? `scripts/load/vm.mjs` adds fake
cameras in steps and measures what happens. It runs on your own computer,
from a clone of this repository. Each fake camera loops one of the
`fixtures/` clips over WHIP, so the video takes the same path a real camera's
does: HTTPS, the WebRTC port, recording, then detection.

## Before you start

- **On your computer:** Node 22 or newer, Go 1.23 or newer and ffmpeg.
- **A workspace key.** In the console, an owner goes to **Agents → Workspace
  keys → Create workspace key**. To keep the fake cameras out of your
  workspace, make a workspace of its own instead, on the server in the folder
  with `docker-compose.yml`:

  ```sh
  docker compose exec api sh -c 'set -a && . /secrets/api.env && set +a && node dist/cli.js create-account "Load test"'
  ```

  It prints the new workspace's `api_key`. (Keys from the Agents page's API
  keys section are agent keys, which can't add cameras.)
- **Upload speed.** Each camera sends about 0.3–0.6 Mbps (640×360 at
  15 fps), so 40 cameras need about 20 Mbps up. Check yours with
  `networkQuality` (macOS) or any speed test, and keep the largest step under
  about 70% of it.
- **SSH to the server (optional):** with `--ssh root@<server>`, the test also
  reads CPU, memory and disk on the server, using `docker stats` and `df`.
  Your key must work without a password prompt.
- **A quiet time.** At the largest step your real cameras may be affected.

## Run it

```sh
SENSEPLANE_API_KEY=sk_… node scripts/load/vm.mjs \
  --api https://cams.example.com --ssh root@203.0.113.7 \
  --steps 5,10,20,40 --minutes 10 --busy 0.2
```

| Option | Default | What it does |
|---|---|---|
| `--steps` | `5,10,20,40` | The number of cameras at each step; each step adds to the one before |
| `--minutes` | `10` | How long each step is measured, after `--warmup` seconds (default 60) |
| `--busy` | `0.2` | The share of busy scenes (people, a van, a dog), which make detection run often; the rest are an empty view, like most cameras most of the day |
| `--ssh` | none | Where to read server CPU, memory and disk |

The test stops early when a step goes past what the server handles well:
less than 95% of the time recorded, cameras dropping, events arriving more
than 10 s late, or detection using every core. At the end (also on Ctrl-C)
the fake cameras are paused, and their footage expires with retention.

## Reading the result

Each step prints one line, and the full numbers go to `load-report.json`:

```
 20 cams (4 busy)  recorded ≥99.1%  reconnects 0  events 31, delay 2.1 s (p95 4.0)  cpu: brain 260% media 40% api 6% postgres 5%  disk 7.4 GB/camera/day
```

- **recorded:** the lowest share of the step's time recorded on any camera.
  Under 100% means gaps.
- **delay:** from the moment something happened to when its event could be
  read through the API (checked every few seconds, so expect a second or two
  on top).
- **cpu:** percent of one core per service, so 260% is 2.6 cores. Detection
  (the brain) usually runs out first. A busy camera costs it much more than a
  quiet one.
- **this computer:** the sending machine's CPU (all cores) and upload. A
  step that fails while this computer was flat out and the server wasn't is
  marked "limited by this computer": that is the sender's limit, not the
  server's. Run from a stronger machine, or a second server near yours, to
  push further. `load-report.json` also has the CPU of the test's own ffmpeg
  and WHIP processes, and the three cameras that recorded least.
- **disk:** how fast recordings fill the disk, per camera. Multiply by your
  retention in days to size the disk. Real cameras at higher resolution or
  bitrate use more: about 16 GB a day at 1.5 Mbps.
