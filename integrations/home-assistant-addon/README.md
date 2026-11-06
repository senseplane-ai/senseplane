# Senseplane Home Assistant add-on

The source of the add-on repository
[senseplane-ai/home-assistant-addons](https://github.com/senseplane-ai/home-assistant-addons):
copy this folder's contents to that repository's root to publish a version
(Home Assistant needs `repository.yaml` at a repository's root).

The add-on runs the Senseplane bridge (`bridge/`, image
`ghcr.io/senseplane-ai/bridge-addon`, built by the release workflow for
amd64 and arm64): it reads this Home Assistant through the Supervisor, relays
IP cameras, and pairs with a code (ADR 0061). `version` in
`senseplane/config.yaml` must be a published bridge version.

## Try it

- **Home Assistant OS in a VM or on a box:** Settings → Apps → App
  store → ⋮ → Repositories, add the repository URL, install Senseplane.
- **Before a release:** copy `senseplane/` into the Home Assistant's
  `/addons/` folder (the Samba or SSH add-on gives access); it appears under
  **Local add-ons**. With `image:` removed from `config.yaml`, the Supervisor
  builds it from a Dockerfile in the folder instead of pulling it; copy
  `bridge/` there and use its Dockerfile with `--target addon`.

For installs without add-ons (Home Assistant Container or Core), run the
bridge container with `--ha-url`, `--ha-token` and `--state-dir`
(`bridge/README.md`), or use the custom integration in
`integrations/home-assistant/`.
