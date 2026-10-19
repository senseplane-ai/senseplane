# Lawful camera use

Senseplane records video, and optionally sound, from places where people
live and work. That's powerful, and in many countries it's regulated. This
page sums up the main rules to keep in mind, with a focus on the EU and
Germany, where they're strictest.

> **This isn't legal advice.** It's a short, practical overview, and rules
> differ by country and situation. You're responsible for how you use your
> cameras. If you film anyone other than your own household, especially staff,
> customers or the public, check your local law or ask a lawyer or your data
> protection authority.

## Film only your own property

- **Point cameras at what's yours:** your home, your garden, your shop floor.
- **Avoid public space:** the street, the pavement, shared paths.
- **Avoid your neighbours' property:** their windows, gardens and doors.

Under the GDPR, recording purely inside your own home for personal reasons
falls under the "household exemption" and the GDPR doesn't apply. That changes
as soon as a camera covers public space, even partly: the EU Court of Justice
held in *Ryneš* (C-212/13) that a home camera filming the street is not a
purely personal activity, so the GDPR's duties apply to its owner.

**Use privacy masks.** In Senseplane, draw a privacy mask over anything you
shouldn't watch: the street, a neighbour's window, a shared entrance. Masked
areas are blacked out before any model sees a frame and in every snapshot.
Recordings keep the original picture, so for areas you must not record at all,
**re-aim the camera** rather than relying on a mask. If Senseplane warns that
"the view has changed", check that your masks still line up.

**Alerts in Telegram leave your server.** A snapshot sent to a Telegram chat
is stored by Telegram, and everyone in a group chat sees it and can ask about
the cameras. Turn snapshots off for a chat that only needs the text, and link
a group only if everyone in it should see the cameras
([Telegram](telegram.md)).

## Tell people they're being recorded

- **Guests, cleaners, babysitters and carers** should know about cameras in
  your home before they enter, and where the cameras are.
- **Businesses** need a visible sign at the entrance to the recorded area:
  who is recording, why, how to contact you, and where to find the full
  privacy information. The European Data Protection Board's guidelines
  describe this "first layer" sign.
- **Bathrooms, bedrooms of other people, changing rooms:** don't put cameras
  there. In Germany, taking pictures of someone in a home or a specially
  protected room in a way that violates their privacy is a crime (§ 201a
  StGB).

## At work

Watching employees is tightly limited across the EU:

- You need a clear, legitimate purpose (for example theft prevention in a
  stockroom), and covert or constant monitoring of staff is almost never
  allowed.
- **In Germany, a works council (Betriebsrat) must agree** before you
  introduce any technical system that can monitor employees' behaviour or
  performance (§ 87(1) no. 6 BetrVG). Senseplane is such a system.
- German regulators have fined companies heavily for excessive workplace
  video surveillance.
- The EU AI Act bans emotion recognition in the workplace. Senseplane doesn't
  infer emotions and isn't designed to be used that way.

Prefer places where staff aren't the subject: the outside of a building, a
yard at night, a parking area, a stockroom when it's closed.

## Be careful with sound

Recording conversations is riskier than recording pictures.

- In Germany, recording or listening to another person's privately spoken
  words without consent is a crime (§ 201 StGB).
- Many US states require everyone's consent to record a conversation.

Senseplane is built for this:

- **audio recording is off by default** (`record_audio` per source);
- `listen` reports **sound types only** (crying, barking, glass breaking,
  alarms) and **never transcribes speech**.

Only turn on audio recording where nobody's private conversations will be
captured, or where everyone has agreed.

## Keep footage only as long as you need it

The GDPR requires deleting personal data once it's no longer needed for its
purpose. The European Data Protection Board says video footage should in most
cases be deleted after a few days, ideally automatically, and that keeping it
longer than 72 hours needs a specific reason. German data protection
authorities take a similar line.

In Senseplane:

- raw footage is deleted automatically after the retention period (**7 days
  by default**; set it per account or per camera, and shorter is better when
  it serves your purpose);
- save a **clip** only for the moments you have a reason to keep, such as an
  incident, and delete it when it's no longer needed;
- use the **audit log** to see who looked at, listened to or replayed
  footage.

## No identification of people

Senseplane detects that *a person* is present. It does **not** recognise who
someone is: there's no face recognition and no identification of named
people. Identifying people from their faces or bodies is biometric processing,
which the GDPR treats as a special category of data with much stricter rules,
and which the EU AI Act restricts further. Don't add it on top of Senseplane
without legal advice.

## Give people their rights

If the GDPR applies to your recording, people you film can ask to see the
footage of them, to have it deleted, or object to the recording. Senseplane's
account export, clip deletion and source deletion help you answer such
requests. A business also needs a record of processing and, for larger-scale
monitoring, a data protection impact assessment.

## Sources

- **Court of Justice of the EU,** *František Ryneš v Úřad pro ochranu osobních údajů*, C-212/13 (11 December 2014): [EUR-Lex](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:62013CJ0212)
- **General Data Protection Regulation** (EU) 2016/679, in particular Art. 2(2)(c) (household exemption), Art. 5(1)(c) and (e) (data minimisation, storage limitation), Art. 9 (special categories): [EUR-Lex](https://eur-lex.europa.eu/eli/reg/2016/679/oj)
- **European Data Protection Board,** Guidelines 3/2019 on processing of personal data through video devices: [edpb.europa.eu](https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-32019-processing-personal-data-through-video_en)
- **Datenschutzkonferenz (DSK),** Orientierungshilfe Videoüberwachung durch nicht-öffentliche Stellen (2020): [datenschutzkonferenz-online.de](https://www.datenschutzkonferenz-online.de/media/oh/20200903_oh_v%C3%BC_dsk.pdf)
- **German Criminal Code:**
  - § 201 StGB (violation of the privacy of the spoken word): [gesetze-im-internet.de](https://www.gesetze-im-internet.de/stgb/__201.html)
  - § 201a StGB (violation of intimate privacy by taking pictures): [gesetze-im-internet.de](https://www.gesetze-im-internet.de/stgb/__201a.html)
- **Works Constitution Act,** § 87(1) no. 6 BetrVG: [gesetze-im-internet.de](https://www.gesetze-im-internet.de/betrvg/__87.html)
- **EU AI Act,** Regulation (EU) 2024/1689, Art. 5(1)(f) (emotion recognition at work): [EUR-Lex](https://eur-lex.europa.eu/eli/reg/2024/1689/oj)
- **UK Information Commissioner's Office,** Domestic CCTV systems: [ico.org.uk](https://ico.org.uk/for-the-public/domestic-cctv-systems/)
