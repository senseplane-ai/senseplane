# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Watch schedules (ADR 0043): wall-clock time in a time zone, overnight spans
that belong to the day they start on, daylight-saving changes; and watches on
several cameras keep their state, cooldown and events per camera."""

from datetime import UTC, datetime

import numpy as np

from senseplane_brain.watches import WatchEngine, active_now, in_schedule


def ts(*args) -> float:
    return datetime(*args, tzinfo=UTC).timestamp()


NIGHT_LONDON = {"from": "18:00", "to": "06:00", "time_zone": "Europe/London"}


def test_no_schedule_is_always_on():
    assert in_schedule(None, ts(2026, 10, 16, 12))


def test_overnight_follows_british_summer_time():
    # Clocks go forward on 29 March 2026 at 01:00 UTC.
    assert in_schedule(NIGHT_LONDON, ts(2026, 3, 29, 4, 30))  # 05:30 BST
    assert not in_schedule(NIGHT_LONDON, ts(2026, 3, 29, 5, 30))  # 06:30 BST (05:30 in UTC would be "on")
    # Before and after they go back on 25 October 2026 at 01:00 UTC.
    assert in_schedule(NIGHT_LONDON, ts(2026, 10, 24, 17, 30))  # 18:30 BST (17:30 in UTC would be "off")
    assert in_schedule(NIGHT_LONDON, ts(2026, 10, 25, 5, 30))  # 05:30 GMT
    assert not in_schedule(NIGHT_LONDON, ts(2026, 10, 25, 6, 30))  # 06:30 GMT
    assert not in_schedule(NIGHT_LONDON, ts(2026, 10, 25, 12))


def test_overnight_span_belongs_to_the_day_it_starts():
    fri = {"days": ["fri"], "from": "18:00", "to": "06:00"}  # UTC by default
    assert in_schedule(fri, ts(2026, 10, 16, 19))  # Friday evening
    assert in_schedule(fri, ts(2026, 10, 17, 3))  # early Saturday: still Friday's night
    assert not in_schedule(fri, ts(2026, 10, 16, 3))  # early Friday: Thursday's night
    assert not in_schedule(fri, ts(2026, 10, 17, 19))  # Saturday evening
    assert not in_schedule(fri, ts(2026, 10, 17, 6))  # `to` is exclusive


def test_same_from_and_to_is_the_whole_day():
    assert in_schedule({"days": ["sat"], "from": "00:00", "to": "00:00"}, ts(2026, 10, 17, 23, 59))
    assert not in_schedule({"days": ["sat"], "from": "00:00", "to": "00:00"}, ts(2026, 10, 16, 23, 59))


def test_skipped_and_repeated_hours_in_new_york():
    one_to_two = {"from": "01:00", "to": "02:00", "time_zone": "America/New_York"}
    # 1 November 2026: 01:00–02:00 happens twice (EDT, then EST); both count.
    assert in_schedule(one_to_two, ts(2026, 11, 1, 5, 30))
    assert in_schedule(one_to_two, ts(2026, 11, 1, 6, 30))
    assert not in_schedule(one_to_two, ts(2026, 11, 1, 7, 30))
    # 8 March 2026: 02:00–03:00 never happens.
    two_to_three = {"from": "02:00", "to": "03:00", "time_zone": "America/New_York"}
    assert not in_schedule(two_to_three, ts(2026, 3, 8, 6, 59, 59))
    assert not in_schedule(two_to_three, ts(2026, 3, 8, 7, 0))


def test_unknown_time_zone_falls_back_to_utc():
    assert in_schedule({"from": "08:00", "to": "09:00", "time_zone": "Mars/Olympus"}, ts(2026, 10, 16, 8, 30))


def test_compiled_active_hours_overnight_uses_start_day():
    assert active_now([{"days": ["fri"], "from": "22:00", "to": "06:00"}], ts(2026, 10, 17, 2))
    assert not active_now([{"days": ["fri"], "from": "22:00", "to": "06:00"}], ts(2026, 10, 16, 2))


def _watch(sources, schedule=None, cooldown=0):
    return {"id": "wat_multi", "sources": sources, "mode": "alert", "status": "active", "active_hours": schedule,
            "compiled": {"trigger": {"type": "schedule", "every_min": 5}, "cooldown_s": cooldown, "active_hours": None}}


def test_each_camera_fires_and_cools_down_on_its_own():
    engine = WatchEngine()
    engine.set_watch("acc.wat_multi", _watch(["front", "back"], cooldown=600))
    frame = np.zeros((4, 4, 3), dtype=np.uint8)
    t = ts(2026, 10, 16, 12)
    a = engine.on_tick("acc", "front", t, frame)
    b = engine.on_tick("acc", "back", t + 1, frame)
    assert [f.source_id for f in a + b] == ["front", "back"]
    # Front fires again after 5 minutes but is inside its cooldown; back's own clock is separate.
    assert engine.on_tick("acc", "front", t + 301, frame) == []
    assert [f.source_id for f in engine.on_tick("acc", "back", t + 602, frame)] == ["back"]
    assert engine.on_tick("acc", "garage", t, frame) == []  # not one of the watch's cameras


def test_schedule_gates_fires():
    engine = WatchEngine()
    engine.set_watch("acc.wat_multi", _watch(["front"], schedule=NIGHT_LONDON))
    frame = np.zeros((4, 4, 3), dtype=np.uint8)
    assert engine.on_tick("acc", "front", ts(2026, 10, 16, 12), frame) == []  # midday: off
    assert len(engine.on_tick("acc", "front", ts(2026, 10, 16, 22), frame)) == 1  # 23:00 BST: on
