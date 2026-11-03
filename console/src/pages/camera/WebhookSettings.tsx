// Copyright 2026 The Senseplane Authors
// SPDX-License-Identifier: Apache-2.0

// A sensor's readings webhook (ADR 0071): the URL that IFTTT, n8n, Zapier,
// ESPHome, Shelly scripts and scripts push to with the sensor's token, and
// signing: a secret, shown once, that every push must then be signed with.
import { useEffect, useState } from "react";
import { type Senseplane, SenseplaneError, type Source } from "senseplane";
import { CopyField } from "../../ui";

type Hook = { url: string; token_prefix: string | null; signed: boolean };

export function WebhookSettings({ client, source }: { client: Senseplane; source: Source }) {
  const [hook, setHook] = useState<Hook | null>(null);
  const [secret, setSecret] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void client.sources.webhook(source.id).then((h) => setHook(h as Hook)).catch(() => setHook(null));
  }, [client, source.id]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setMsg(e instanceof SenseplaneError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const turnOn = () => run(async () => {
    const r = await client.sources.createWebhookSecret(source.id);
    setHook({ url: r.url, token_prefix: r.token_prefix, signed: true });
    setSecret(r.secret);
    setMsg("Signing is on. Copy the secret now; it isn't shown again. Pushes without a signature are refused from now.");
  });
  const turnOff = () => run(async () => {
    await client.sources.deleteWebhookSecret(source.id);
    setHook((h) => (h ? { ...h, signed: false } : h));
    setSecret("");
    setMsg("Signing is off.");
  });

  if (!hook) return null;
  return (
    <section className="cam-webhook" aria-labelledby="cam-webhook-h">
      <h3 id="cam-webhook-h">Readings webhook</h3>
      <p className="muted">
        IFTTT, n8n, Zapier, ESPHome, Shelly scripts and your own scripts can send readings here, with this sensor's access token
        ({hook.token_prefix ? <code>{hook.token_prefix}…</code> : "make one under Access token"}) as <code>Authorization: Bearer</code>.
        For example <code>{'{"sense": "temperature", "value": 21.5}'}</code>. Recipes are in the docs, under sensors webhook.
      </p>
      <CopyField label="Webhook URL" value={hook.url} />
      {secret && <CopyField label="Signing secret" value={secret} />}
      <p className="muted">
        {hook.signed
          ? "Signed: every push carries a Senseplane-Signature header, as Senseplane signs its own webhooks."
          : "Not signed: the token alone is enough. Turn signing on when the sender can sign (n8n, scripts)."}
      </p>
      <div className="card-row">
        {hook.signed ? (
          <>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void turnOn()}>New secret</button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void turnOff()}>Turn signing off</button>
          </>
        ) : (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !hook.token_prefix} onClick={() => void turnOn()}>Turn signing on</button>
        )}
      </div>
      {msg && <p role="status" className="muted">{msg}</p>}
    </section>
  );
}
