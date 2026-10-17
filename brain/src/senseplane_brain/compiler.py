# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Watch compiler: one plain-language sentence → a cheap trigger plus an
optional VLM check (spec/schemas/watch.json, docs/watch-spec.md).

With a model configured (AI_BASE_URL), an LLM compiles once at creation and
the result is validated against the spec; anything invalid falls back to the
rule-based compiler, which also runs alone on instances without a model."""

import json
import logging
import re
from dataclasses import dataclass, field

from pydantic import TypeAdapter, ValidationError

from . import labels
from .spec.trigger import Trigger
from .vlm import ModelClient

log = logging.getLogger("senseplane.rpc.brain.compiler")
_trigger = TypeAdapter(Trigger)


@dataclass
class Compiled:
    compiled: dict
    estimate: dict
    warnings: list[str] = field(default_factory=list)
    compiler: str = "rules"
    needs_zone: bool = False


WORDS = {
    "person": r"\b(person|people|someone|somebody|anyone|visitor|courier|delivery (?:person|driver|man|woman)|postman|mail ?carrier|man|woman|kid|child|intruder|stranger|queue|crowd)\b",
    "vehicle": r"\b(car|cars|vehicle|truck|trucks|van|bus|motorbike|motorcycle|bike|bicycle|lorry)\b",
    "animal": r"\b(dog|dogs|cat|cats|pet|pets|animal|animals|fox|bird|deer|horse)\b",
}
SOUNDS = {
    "crying": r"\b(cry|cries|crying|baby)\b",
    "glass_break": r"\b(glass|window break|smash|shatter)\w*",
    "alarm": r"\b(alarm|smoke|siren|fire alarm|beep)\w*",
    "dog": r"\b(bark|barking|barks)\b",
}
# Everyday objects (spec/labels.json): one pattern per label from its words, plurals included.
OBJECT_WORDS: dict[str, list[str]] = {lbl: labels.WORDS[lbl] for lbl in labels.OBJECTS}
OBJECTS = {lbl: re.compile(r"\b(" + "|".join(re.escape(w) + r"(?:s|es)?" for w in sorted(ws, key=len, reverse=True)) + r")\b")
           for lbl, ws in OBJECT_WORDS.items()}
# What happens to the object: taken away (leave), left behind (stationary), or just there (present).
TAKEN = r"\b(take|takes|taken|took|taking|removes?|removed|removing|missing|gone|stolen|steals?|stealing|moved?|moves|moving|picks? up|picked up|disappears?|disappeared|no longer)\b"
LEFT_BEHIND = r"\b(left|leave|leaves|leaving|abandon\w*|unattended|forgot\w*|still there|lying around)\b"
PLACED = r"\b(put|puts|placed|appears?|shows? up|there is|there's|set down|dropped|drops|brings?|brought)\b"
NUMBERS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}


def _zone(text: str, zones: list[str]) -> tuple[str | None, bool]:
    """Returns (matching zone name, a place was mentioned but no zone matched)."""
    low = text.lower()
    for z in sorted(zones, key=len, reverse=True):
        if z.replace("_", " ") in low or z in low:
            return z, False
    place = re.search(r"\b(?:at|in|on|by|near|inside|outside) (?:the |my |our )?([a-z][a-z ]{2,30})", low)
    mentioned = bool(place and not re.match(r"(night|day|morning|evening|afternoon|camera|frame|picture|view|room)\b", place.group(1)))
    return None, mentioned


def _count(text: str) -> int | None:
    m = re.search(r"\b(?:more than|over|at least|>)\s*(\d+|\w+)", text.lower())
    if not m:
        return None
    n = int(m.group(1)) if m.group(1).isdigit() else NUMBERS.get(m.group(1))
    if n is None:
        return None
    return n if "at least" in m.group(0) else n + 1


def _duration_s(text: str) -> float:
    low = text.lower().replace("a minute", "1 minute").replace("an hour", "60 minutes").replace("half a minute", "30 seconds")
    m = re.search(r"(?:for|longer than|more than|over) (\d+)\s*(seconds?|secs?|s|minutes?|mins?|m)\b", low)
    if not m:
        return 0.0
    return float(m.group(1)) * (60 if m.group(2).startswith("m") else 1)


def _verify(instruction: str) -> dict:
    q = instruction.strip().rstrip(".?!")
    q = re.sub(r"^(please )?(tell me|let me know|alert me|notify me|warn me)( if| when| whenever)?\s*", "", q, flags=re.I)
    q = q[:1].upper() + q[1:] if q else instruction
    return {"prompt": f"Is this happening: {q}? Answer yes or no with a confidence.", "min_confidence": 0.7}


def _object(text: str) -> tuple[str, str, int] | None:
    """The first everyday object the sentence names: (label, the word used, position)."""
    best = None
    for lbl, pat in OBJECTS.items():
        m = pat.search(text)
        if m and (best is None or m.start() < best[2] or (m.start() == best[2] and len(m.group(1)) > len(best[1]))):
            best = (lbl, m.group(1), m.start())
    return best


def _place(text: str) -> str | None:
    """"on the desk" from "a mug is left on the desk for 5 minutes"."""
    m = re.search(r"\b(on|in|at|by|near|next to|beside|under|inside|outside|from|off) ((?:the|my|our|a|an) )?([a-z][a-z ]{1,30}?)"
                  r"(?=\s+(?:for|after|when|while|if|and|or|at night|overnight|longer|more)\b|[.,!?]|$)", text.lower())
    if not m or re.match(r"(night|day|morning|evening|afternoon|camera|frame|picture|view)\b", m.group(3)):
        return None
    return f"{m.group(1)} {m.group(2) or 'the '}{m.group(3)}"


def _a(word: str) -> str:
    return f"{'an' if word[:1] in 'aeiou' else 'a'} {word}"


def _object_watch(instruction: str, text: str, label: str, word: str, zone_field: dict) -> tuple[dict, dict]:
    """An objects trigger for an everyday thing, and a model check naming exactly that thing (a mug, not "a cup")."""
    place, dur, n = _place(instruction), _duration_s(text), _count(text)
    thing = word[:-1] if word.endswith("s") and not label.endswith("s") and word[:-1] in OBJECT_WORDS[label] else word
    if re.search(TAKEN, text):
        # Gone for a while, not just hidden behind someone for a moment.
        on, wait = "leave", dur or 30.0
        prompt = f"Is the {thing} gone{' from ' + place.split(' ', 1)[1] if place else ''} (no {thing} in view)?"
    elif re.search(LEFT_BEHIND, text):
        on, wait = "stationary", dur or 60.0
        prompt = f"Is there {_a(thing)} left {place or 'in view'}?"
    else:
        on, wait = "present", dur or 5.0
        prompt = f"Is there {_a(thing)} {place or 'in view'}?"
    if n and on != "leave":
        prompt = f"Are there at least {n} {thing if thing.endswith('s') else thing + 's'} {place or 'in view'}?"
    trigger = {"type": "objects", "label": label, "on": on, **zone_field, **({"min_count": n} if n else {}), "min_duration_s": wait}
    return trigger, {"prompt": f"{prompt} Answer yes or no with a confidence.", "min_confidence": 0.7}


def rules(instruction: str, zones: list[str], senses: list[str]) -> Compiled:
    text = instruction.lower()
    zone, place_mentioned = _zone(instruction, zones)
    warnings: list[str] = []
    zone_field = {"zone": zone} if zone else {}
    trigger: dict
    verify: dict | None = _verify(instruction)
    calls = "4–20"
    # An everyday object wins over person/vehicle/animal when it comes first, or when someone acts on
    # it ("someone takes the laptop", "someone leaves a bag"); "a dog on the sofa" stays an animal watch.
    obj = _object(text)
    core_at = min((m.start() for p in WORDS.values() if (m := re.search(p, text))), default=None)
    core_first = next((lbl for lbl, p in WORDS.items() if re.search(p, text)), None)
    acted = bool(re.search(TAKEN, text) or re.search(LEFT_BEHIND, text) or re.search(PLACED, text))
    object_first = bool(obj) and (core_at is None or obj[2] < core_at or (core_first == "person" and acted))
    # A state of something ("is the fridge open", "the TV is on") is a scheduled model check, not a detection.
    state_of = bool(obj and re.search(r"\b(is|are|was|been) (left )?((on|off)\b(?! (the|a|an|my|our|top|its|his|her|their)\b)|(open|closed|empty|full|running|switched on|turned on|broken)\b)", text))
    state = state_of or bool(re.search(r"\b(is|are) (the|my|our|a|an|any)\b.*\b(empty|open|closed|on|off|full|red|green|left|missing|running)\b|\bevery \d+ ?min", text))

    m_temp = re.search(r"\b(temperature|temp|hot|cold|warm|humidity|humid|damp)\b.*?(above|over|below|under|more than|less than|>|<)\s*(-?\d+(?:\.\d+)?)", text)
    if m_temp and not ("temperature" in senses or "humidity" in senses or not senses):
        warnings.append("This source has no temperature or humidity sensor.")
    if m_temp and ("temperature" in senses or "humidity" in senses or not senses):
        sense = "humidity" if m_temp.group(1).startswith("humid") or m_temp.group(1) == "damp" else "temperature"
        bound = "above" if m_temp.group(2) in ("above", "over", "more than", ">") else "below"
        trigger = {"type": "sensor", "sense": sense, bound: float(m_temp.group(3)), "min_duration_s": _duration_s(text) or 0}
        verify, calls = None, "0"
    elif any(re.search(p, text) for p in (r"\bpackage|parcel|box|deliver", )):
        # Person arrives, then leaves; the VLM checks what was left (docs/watch-spec.md).
        trigger = {"type": "sequence", "within_s": 600, "steps": [
            {"type": "objects", "label": "person", "on": "enter", **zone_field},
            {"type": "objects", "label": "person", "on": "leave", **zone_field},
        ]}
        verify = {"prompt": "Is there a package or parcel left on the doorstep or ground near the door? Answer yes or no with a confidence.", "min_confidence": 0.7}
        calls = "1–10"
    elif ((snd := next((c for c, p in SOUNDS.items() if re.search(p, text)), None)) and not re.search(WORDS["animal"], text) or snd == "dog" and re.search(r"bark", text)) \
            and not (snd == "glass_break" and obj and obj[0] == "wine_glass" and not re.search(r"break|smash|shatter", text)):
        trigger = {"type": "sound", "class": snd, "min_duration_s": _duration_s(text)}
        verify, calls = None, "0"
        if "audio" not in senses and senses:
            warnings.append("This source has no audio: enable record_audio so sounds can be heard.")
    elif obj and object_first and not state_of and (acted or not state):
        trigger, verify = _object_watch(instruction, text, obj[0], obj[1], zone_field)
    elif state:
        m = re.search(r"every (\d+) ?min", text)
        every = max(5, int(m.group(1))) if m else 15
        trigger = {"type": "schedule", "every_min": every}
        calls = str(round(1440 / every))
    elif (label := next((lbl for lbl, p in WORDS.items() if re.search(p, text)), None)):
        n = _count(text)
        on = "leave" if re.search(r"\b(leave|leaves|left|go(?:es)? away)\b", text) else "stationary" if re.search(r"\b(stays|parks|parked|loiter\w*|waiting|still there)\b", text) else "present" if n else "enter"
        trigger = {"type": "objects", "label": label, "on": on, **({"min_count": n} if n else {}), **zone_field,
                   **({"min_duration_s": _duration_s(text) or (30.0 if n else 0.0)} if (n or _duration_s(text)) else {})}
        if on == "enter" and not re.fullmatch(r"(tell me|let me know|alert me|notify me)( if| when| whenever)? (a |any |someone|anyone|there is a )?\w+( is| comes| appears| arrives)?( here| there)?\.?", text.strip()):
            # The model check needs the subject in view, not at the frame edge: wait until it has stayed a moment.
            trigger.update({"on": "present", "min_duration_s": max(trigger.get("min_duration_s", 0), 3.0)})
        generic = re.fullmatch(r"(tell me|let me know|alert me|notify me)( if| when| whenever)? (a |any |someone|anyone|there is a )?\w+( is| comes| appears| arrives)?( here| there)?\.?", text.strip())
        if generic and not zone:
            verify, calls = None, "0"
    elif re.search(r"\b(move|moves|moving|motion|movement)\b", text):
        trigger = {"type": "motion", **zone_field, "min_duration_s": _duration_s(text) or 2.0}
    else:
        trigger = {"type": "schedule", "every_min": 15}
        calls = "96"
        warnings.append("No cheap trigger fits this sentence, so a snapshot is checked every 15 minutes (about 96 model calls a day).")

    needs_zone = place_mentioned and zone is None and trigger["type"] in ("objects", "motion", "sequence")
    if needs_zone:
        warnings.append("No zone on this camera matches the place in your sentence: draw it in the console. Until then the whole frame is used and the model check covers the location.")
    compiled = {"trigger": trigger, "cooldown_s": 600 if trigger["type"] != "schedule" else 0, "active_hours": None}
    if verify:
        compiled["verify"] = verify
    return Compiled(compiled, {"vlm_calls_per_day": calls}, warnings, "rules", needs_zone)


_SYNONYMS = ", ".join(f"{w}→{lbl}" for lbl in labels.OBJECTS for w in OBJECT_WORDS[lbl] if w.replace(" ", "_") != lbl and w != labels.noun(lbl).lower())

SYSTEM = """You compile a plain-language camera or sensor watch into JSON for Senseplane.
Output one JSON object: {"trigger": <Trigger>, "verify": {"prompt": str, "min_confidence": number} | omitted, "cooldown_s": int, "active_hours": null | [{"days": [...], "from": "HH:MM", "to": "HH:MM"}], "vlm_calls_per_day": str, "warnings": [str]}.
Trigger is one of:
- {"type":"objects","label":"<label>","zone"?:str,"min_count"?:int,"min_duration_s"?:number,"on":"enter|leave|present|stationary"}""" + f"""
  label is one of: {"|".join(labels.LABELS)}.
  vehicle = bicycle, car, motorcycle, bus or truck; animal = bird, cat, dog, horse, sheep, cow, elephant, bear, zebra or giraffe; every other label is one everyday object.
  Map the user's words to the nearest label: {_SYNONYMS}.
  For an object left somewhere use on=stationary with min_duration_s (default 60); taken or gone: on=leave with min_duration_s (default 30); there at all: on=present.
  Small objects are unreliable at camera resolution, so an object watch always has verify naming the user's own word (a mug, not a cup) and the place.
  A watch about a person acting on an object ("someone takes the laptop") watches the object. A thing that is no label at all (keys, a door, a package) needs another trigger plus verify.
  Something a person leaves behind that is no label (a package, a parcel, a delivery, flowers) is a sequence: person on=enter, then person on=leave, within_s 600, plus verify that the thing is there; checking on motion would look while the person is still in the way.""" + """
- {"type":"motion","zone"?:str,"min_duration_s"?:number}
- {"type":"sound","class":"crying|glass_break|alarm|dog|speech_present","min_duration_s"?:number}
- {"type":"sensor","sense":"temperature|humidity","above"?:number,"below"?:number,"rate_per_min"?:number,"min_duration_s"?:number}
- {"type":"schedule","every_min":int>=5}  (verify is required)
- {"type":"sequence","steps":[Trigger, ...>=2],"within_s":number}
Prefer the cheapest trigger that catches the situation; use verify only when the trigger alone can't tell (a package, a queue, a state of something).
Use only zone names from the list given. Never add identification of people. Keep the verify prompt a yes/no question."""


def compile_watch(instruction: str, zones: list[str], senses: list[str], client: ModelClient | None, meta: dict | None = None) -> Compiled:
    fallback = rules(instruction, zones, senses)
    if client is None:
        return fallback
    try:
        out = client.compile(SYSTEM, json.dumps({"instruction": instruction, "zones": zones, "senses": senses}), meta)
        trigger = out.get("trigger")
        _trigger.validate_python(trigger)
        zone_names = _zones_in(trigger)
        unknown = [z for z in zone_names if z not in zones]
        compiled = {"trigger": trigger, "cooldown_s": int(out.get("cooldown_s", 600)), "active_hours": out.get("active_hours")}
        if out.get("verify"):
            compiled["verify"] = {"prompt": str(out["verify"]["prompt"]), "min_confidence": float(out["verify"].get("min_confidence", 0.7))}
        if trigger["type"] == "schedule" and "verify" not in compiled:
            raise ValueError("schedule triggers need verify")
        warnings = [str(w) for w in out.get("warnings", [])]
        if unknown:
            warnings.append(f"Zone(s) {', '.join(unknown)} don't exist on this camera yet: draw them in the console.")
        return Compiled(compiled, {"vlm_calls_per_day": str(out.get("vlm_calls_per_day", fallback.estimate["vlm_calls_per_day"]))},
                        warnings, "llm", bool(unknown))
    except (ValidationError, ValueError, KeyError, TypeError, RuntimeError) as err:
        log.warning("LLM compile rejected, using rules: %s", err)
        fallback.warnings.append("Compiled with the built-in rules (the model's answer was not a valid watch).")
        return fallback


def _zones_in(trigger: dict) -> list[str]:
    if trigger.get("type") == "sequence":
        return [z for s in trigger.get("steps", []) for z in _zones_in(s)]
    return [trigger["zone"]] if trigger.get("zone") else []
