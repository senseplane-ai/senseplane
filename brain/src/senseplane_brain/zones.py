# Copyright 2026 The Senseplane Authors
# SPDX-License-Identifier: Apache-2.0
"""Zones: named polygons in normalised coordinates. An object is in a zone when
the bottom-centre of its box (where it stands) is inside the polygon."""


def inside(point: tuple[float, float], polygon: list[list[float]]) -> bool:
    x, y = point
    hit = False
    for i in range(len(polygon)):
        x1, y1 = polygon[i]
        x2, y2 = polygon[i - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


def zones_for(box, frame_w: int, frame_h: int, zones: list[dict]) -> list[str]:
    foot = ((box[0] + box[2]) / 2 / frame_w, box[3] / frame_h)
    return [z["name"] for z in zones if inside(foot, z["polygon"])]
