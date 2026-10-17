# senseplane (TypeScript SDK)

```sh
npm i senseplane
```

```ts
import { Senseplane } from "senseplane";
const sp = new Senseplane({ apiKey: process.env.SENSEPLANE_API_KEY! }); // baseUrl for self-host

const src = await sp.sources.create({ name: "Front door", type: "browser" });
const watch = await sp.watches.create({ instruction: "Tell me if a package is left at the front door", sources: [src.id] });
for await (const ev of sp.events.list({ source: src.id })) console.log(ev.summary);

// Several cameras (ids or names), one webhook and one agent, only at night (ADR 0043):
await sp.watches.create({
  instruction: "Tell me if someone is in the yard", sources: ["Back door", "Garage"],
  notify: [{ type: "webhook", id: hook.id }, { type: "agent", id: agent.id }],
  active_hours: { from: "18:00", to: "06:00", time_zone: "Europe/London" },
});
// Try a watch on the last hour first: matches, and how many AI checks it used.
const { matches, checks_used } = await sp.watches.test({
  instruction: "Tell me if a package is left at the front door", sources: [src.id],
  from: new Date(Date.now() - 3600_000).toISOString(), to: new Date().toISOString(),
});
// With an agent key: events your watches sent you.
const { data: inbox } = await sp.inbox.list({ unseen: true });
await sp.inbox.markSeen({ ids: inbox.map((i) => i.id) });

// In a webhook handler (throws on a bad signature or stale timestamp):
const event = sp.webhooks.verify(rawBody, req.headers["senseplane-signature"], process.env.WEBHOOK_SECRET!);
```

Types in `src/generated/` come from `spec/openapi.yaml`; run `pnpm codegen` after
changing the spec. Environment: none required.
