# Sensors webhook

Any tool that can make an HTTP request can send Senseplane a reading: IFTTT,
n8n, Zapier, ESPHome, Shelly scripts, Home Assistant and shell scripts. Each
sensor in Senseplane has one URL and one token; readings sent with it are
filed under that sensor, and watches, questions and agents see them like any
other reading (ADR 0071).

## The URL and the token

1. In the console, **Cameras → Add camera → Home Assistant sensors
   (integration)** makes a sensor and shows its **access token** (`sit_…`)
   once; so does `POST /v1/sources` with `"type": "sensor"`. Copy it.
   `POST /v1/sources/{id}/ingest-token` makes a new one and stops the old.
2. Open the sensor, then **Settings → Readings webhook**: copy the **webhook
   URL**. It is your API address followed by `/v1/integration/readings`, for
   example `https://senseplane.example.com/v1/integration/readings`.

Every request is a `POST` with the token in a header:

```
Authorization: Bearer sit_…
```

The token is never taken in the URL, since URLs end up in logs. The token can
push readings to its own sensor and do nothing else.

## What to send

One reading, as JSON:

```json
{"sense": "temperature", "value": 21.5}
```

Or several at once:

```json
{"readings": [
  {"sense": "temperature", "value": 21.5, "device_id": "greenhouse"},
  {"sense": "humidity", "value": 63, "device_id": "greenhouse"}
]}
```

| Field | |
|---|---|
| `sense` | What is measured: `temperature`, `humidity`, `power`, `contact`, `motion`, `leak`, `doorbell`, `button`… ([the list](../spec/senses.json)). Other names are taken too, as long as they are lowercase letters, digits and `_`. `video`, `audio`, `sensors` and `control` are never readings. |
| `value` | A number for numbers (`21.5`), true or false for states (`contact` true is open), nothing for events (a doorbell press). Text is fine: `"21.5"`, `"on"`, `"off"`, `"1"`, `"0"`, `"true"` and the sense's own words, such as `"open"`, `"closed"`, `"wet"`, `"dry"`. |
| `unit` | For numbers: Senseplane's unit, such as `celsius`, `percent`, `watt`, `kilowatt_hour`, `lux`, `ppm`. A known sense can leave it out (temperature is in celsius). |
| `device_id`, `device_name` | Which device it is, when one sensor gathers several (`"device": {"id": …, "name": …}` works too). |
| `detail` | For events: which kind (`"double"` for a double press). |
| `measured_at` | When it was measured, as RFC 3339 or Unix seconds; leave it out for now. |

The same fields work as a form (`application/x-www-form-urlencoded`), as
plain text holding JSON (IFTTT), and, for a request without a body, as query
parameters: `POST …/v1/integration/readings?sense=doorbell`.

The answer is `202` with `{"accepted": 1, "events": []}`: the IDs of any
events the readings fired (a watch, a threshold). A reading that doesn't fit
its sense (a temperature of "warm", a door without a state) answers `400`
with a message saying why. Requests are limited per token, like every key
(600 a minute by default; `429` with `Retry-After` past it).

## Signing (optional)

The token alone is enough. To make sure a request came from you and wasn't
changed or replayed, turn on signing: **Settings → Readings webhook → Turn
signing on** shows a secret (`whsec_…`) once. From then on every request with
that token must carry a signature, made the way Senseplane signs its own
webhooks:

```
Senseplane-Signature: t=<Unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>" with the secret>
```

- `<body>` is the request body exactly as sent; a request without a body signs
  its query string (what follows `?`).
- The time must be within 5 minutes of the server's clock.
- Each signature is taken once: sending the same request again is refused.
- A token with signing on can only push readings here.

A missing, wrong, old or reused signature answers `401`. Tools that can't
compute an HMAC (Shelly scripts, IFTTT, Zapier without code) use the token
alone. Making a new token keeps signing on with the same secret.

## Recipes

Replace `https://senseplane.example.com` with your API address and `sit_…`
with the sensor's token.

### curl

```sh
curl -X POST https://senseplane.example.com/v1/integration/readings \
  -H "Authorization: Bearer sit_…" -H "Content-Type: application/json" \
  -d '{"sense": "temperature", "value": 21.5}'
```

Signed, with `openssl`:

```sh
body='{"sense":"temperature","value":21.5}'
t=$(date +%s)
sig=$(printf '%s.%s' "$t" "$body" | openssl dgst -sha256 -hmac "$SENSEPLANE_SECRET" | sed 's/^.* //')
curl -X POST https://senseplane.example.com/v1/integration/readings \
  -H "Authorization: Bearer $SENSEPLANE_TOKEN" -H "Content-Type: application/json" \
  -H "Senseplane-Signature: t=$t,v1=$sig" -d "$body"
```

### ESPHome

With the [`http_request`](https://esphome.io/components/http_request.html)
component, each new value is sent (at most once a minute here):

```yaml
http_request:

sensor:
  - platform: dht
    pin: GPIO4
    temperature:
      name: Greenhouse temperature
      filters:
        - throttle: 60s
      on_value:
        then:
          - http_request.post:
              url: https://senseplane.example.com/v1/integration/readings
              request_headers:
                Authorization: !secret senseplane_auth   # "Bearer sit_…" in secrets.yaml
              json:
                sense: temperature
                device_id: greenhouse
                value: !lambda return to_string(x);
```

A door contact (`binary_sensor`) sends `value: !lambda 'return x ? "open" : "closed";'`
with `sense: contact`.

### Shelly (scripts, Gen2 and later)

In the device's web page, **Scripts → Add script**:

```js
let URL = "https://senseplane.example.com/v1/integration/readings";
let TOKEN = "sit_…";

function send(reading) {
  Shelly.call("HTTP.Request", {
    method: "POST", url: URL, body: JSON.stringify(reading),
    headers: { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" },
  });
}

Shelly.addStatusHandler(function (e) {
  if (e.component === "temperature:0" && e.delta.tC !== undefined) {
    send({ sense: "temperature", value: e.delta.tC, device_id: "shelly-temperature" });
  }
  if (e.component === "input:0" && e.delta.state !== undefined) {
    send({ sense: "contact", value: e.delta.state, device_id: "shelly-door" });
  }
});
```

### Home Assistant `rest_command`

Home Assistant has [its own integration](../integrations/home-assistant) and
the add-on, which send the sensors you choose. For one value made with a
template, a `rest_command` works too:

```yaml
rest_command:
  senseplane_reading:
    url: https://senseplane.example.com/v1/integration/readings
    method: post
    headers:
      Authorization: !secret senseplane_bearer   # "Bearer sit_…"
    content_type: application/json
    payload: '{"sense": "{{ sense }}", "value": "{{ value }}", "device_id": "{{ device }}"}'
```

and in an automation:

```yaml
action:
  - action: rest_command.senseplane_reading
    data:
      sense: power
      value: "{{ states('sensor.heat_pump_power') }}"
      device: sensor.heat_pump_power
```

### n8n

An **HTTP Request** node: method `POST`, the URL, **Authentication → Generic
Credential Type → Header Auth** with name `Authorization` and value
`Bearer sit_…`, **Send Body** on, **Body Content Type** JSON, and the fields
`sense` and `value` (an expression such as `{{ $json.temperature }}`).

Signed: a **Code** node before it builds the body and the signature (on a
self-hosted n8n, allow the module with `NODE_FUNCTION_ALLOW_BUILTIN=crypto`):

```js
const crypto = require("crypto");
const body = JSON.stringify({ sense: "temperature", value: $json.temperature });
const t = Math.floor(Date.now() / 1000);
const v1 = crypto.createHmac("sha256", $env.SENSEPLANE_SECRET).update(`${t}.${body}`).digest("hex");
return [{ json: { body, signature: `t=${t},v1=${v1}` } }];
```

and the HTTP Request node sends **Body Content Type** Raw, content type
`application/json`, body `{{ $json.body }}`, with a header
`Senseplane-Signature: {{ $json.signature }}`.

### Zapier

**Webhooks by Zapier → POST**: the URL, **Payload Type** `json`, **Data**
`sense` → `temperature` and `value` → the field from the trigger, and
**Headers** `Authorization` → `Bearer sit_…`. Zapier sends the values as
text, which is fine.

### IFTTT

**Webhooks → Make a web request**: the URL, method `POST`, content type
`application/json`, **Additional Headers** `Authorization: Bearer sit_…`, and
a body such as:

```json
{"sense": "doorbell", "device_id": "front-door"}
```

or, with an ingredient, `{"sense": "temperature", "value": "{{Temperature}}"}`.
If your IFTTT plan doesn't offer additional headers, have IFTTT call n8n,
Zapier or Home Assistant, and send from there.

## From code

The Python SDK sends and signs:

```python
from senseplane import Senseplane

sp = Senseplane(api_key="sit_…", base_url="https://senseplane.example.com/v1")
sp.integration.push(sense="temperature", value=21.5)
sp.integration.push(readings=[{"sense": "contact", "value": "open"}], signing_secret="whsec_…")
```

The full request is in the [API reference](site/api.html) under
`pushWebhookReadings`.
