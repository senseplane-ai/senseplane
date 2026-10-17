# Releasing

Senseplane ships as six container images on the GitHub Container Registry,
for linux/amd64 and linux/arm64:

| Image | Built from |
|---|---|
| `ghcr.io/senseplane-ai/api` | `api/Dockerfile` (also the self-host `init` step) |
| `ghcr.io/senseplane-ai/mcp` | `mcp/Dockerfile` |
| `ghcr.io/senseplane-ai/media` | `media/Dockerfile` |
| `ghcr.io/senseplane-ai/console` | `console/Dockerfile` (the console behind Caddy) |
| `ghcr.io/senseplane-ai/brain` | `brain/Dockerfile` (builds the int8 detector at build time) |
| `ghcr.io/senseplane-ai/bridge` | `bridge/Dockerfile` |

## Tags

| Tag | Points at | Moves |
|---|---|---|
| `0.1.3` | that release | never |
| `0.1` | the newest release of the 0.1 line | on every 0.1.x release |
| `latest` | the newest stable release | on a release newer than every other |
| `edge` | the newest commit on `main` that passed CI | on every push to main |
| `<commit sha>` (40 characters) | that commit | never |

The one-file compose (`docker-compose.yml`, ADR 0056) and the bridge command
the API hands out name the release line (`:0.1`), so `docker compose pull`
picks up patch releases. Pre-releases (`v0.2.0-rc.1`) get only their own tag.

## The version

The version lives in one place: `"version"` in the root `package.json`.
`node scripts/version.mjs check` (run by CI) fails when any
`ghcr.io/senseplane-ai/<image>:<x.y>` in the repository names another
release line, and the release fails when the tag isn't `v<version>`.

## Cut a release

1. Bump the version on a branch and open a pull request:

   ```sh
   node scripts/version.mjs set 0.1.3   # package.json, plus every :x.y image reference
   git commit -am "chore: release 0.1.3"
   ```

   A patch release changes only `package.json`; a new minor (0.2.0) also
   moves `docker-compose.yml`, the bridge command and the docs to `:0.2`.
2. Merge it once CI is green.
3. Tag the merge commit on `main` with an annotated tag; its message becomes
   the release notes:

   ```sh
   git switch main && git pull
   git tag -a v0.1.3 -m "Senseplane 0.1.3

   - What changed, for people running it."
   git push origin v0.1.3
   ```

4. The `release` workflow (`.github/workflows/release.yml`) then:
   - runs the whole `ci` workflow on the tagged commit;
   - builds every image on native amd64 and arm64 runners, with SBOM and
     provenance attestations, and pushes them by digest;
   - joins each image's two architectures under `0.1.3`, `0.1`, the commit SHA
     and, for the newest stable release, `latest`, and signs it with cosign
     (keyless, through GitHub's OIDC token);
   - creates the GitHub Release with the tag's notes and `docker-compose.yml`
     attached.

A failed release can be re-run from the Actions tab; every step is safe to repeat.

## Try unreleased main (`edge`)

Every push to `main` that passes `ci` publishes `edge` (and its commit SHA).
To run it with the one-file compose, change the five image tags from `:0.1`
to `:edge` in a copy of `docker-compose.yml`, then:

```sh
docker compose pull && docker compose up -d
```

To build another branch, tag or commit, run the `release` workflow from the
Actions tab ("Run workflow", with the ref): it runs CI, then pushes images
tagged with the commit SHA only.

## Check an image

```sh
# The signature: made by this repository's release workflow
cosign verify ghcr.io/senseplane-ai/api:0.1 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github.com/senseplane-ai/senseplane/\.github/workflows/release\.yml@'

# Its SBOM and build provenance
docker buildx imagetools inspect ghcr.io/senseplane-ai/api:0.1 --format '{{ json .SBOM }}'
docker buildx imagetools inspect ghcr.io/senseplane-ai/api:0.1 --format '{{ json .Provenance }}'
```

## Build the images locally

The same builds as the release, without pushing:

```sh
docker buildx build -f api/Dockerfile -t ghcr.io/senseplane-ai/api:dev --load .
docker buildx build -t ghcr.io/senseplane-ai/brain:dev --load brain
docker buildx build -t ghcr.io/senseplane-ai/bridge:dev --load bridge
scripts/smoke-image.sh api ghcr.io/senseplane-ai/api:dev   # it starts
```

`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`
builds and runs the whole self-host stack from a checkout.
