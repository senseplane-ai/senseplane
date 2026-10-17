# fixtures/

Short media files for tests: recorder tests and perception CI (played into the
media plane by the dev replay publisher). Ground truth is in `labels.json`.

Every clip was re-encoded for the repo (H.264 Baseline, 15 fps, keyframe every
2 s; audio as Opus) and trimmed. Only CC0 or CC BY material is used; CC BY
attributions are also in `NOTICE`. Never add a clip whose licence is unclear.

| File | What | Source | Licence |
|---|---|---|---|
| `doorstep-parcel-640x360.mp4` | Person walks onto a porch, rings, picks up a parcel, leaves (30 s: the first, empty frame is held for 6 s so the pipeline is warm; the person enters at 7.8 s) | "Don't Tempt a Thief with Unattended Parcels", vpdonline, [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Don%27t_Tempt_a_Thief_with_Unattended_Parcels.ogv) | CC BY 3.0 |
| `doorstep-delivery-reversed-640x360.mp4` | The parcel clip played **backwards**: a person arrives carrying a box, puts it down at the door and leaves; the box stays (40 s, held frames at start and end). Used for the package watch | Derived from the vpdonline clip above | CC BY 3.0 |
| `van-driving-640x360.mp4` | Van driving past, people in the background (27 s) | "FSR Tarpan 239 D van (driving)", Museum of Municipal Engineering (Kraków), [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:FSR_Tarpan_239_D_van_(driving).webm) | CC BY 3.0 |
| `dog-indoors-640x480.mp4` | Small dog on a bed, a person's arm (20 s) | "Capuccino", Diego Torres Silvestre, [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Capuccino_(3990980509)-video.webm) | CC BY 2.0 |
| `rain-window-night-640x360.mp4` | Raindrops on a window, city at night (18 s) | slavikfi (Vjatseslav Robtsenkov), [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Raindrops_against_the_window_in_the_night_city,_Las_Palmas.webm) | CC0 |
| `storm-rain-night-360x640.mp4` | Heavy rain at night, parked cars far away, handheld (8 s) | MatthewHoobin, [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Wind_and_rain_from_Tropical_Storm_Eta_at_night_in_Clearwater,_Florida,_US,_on_11_November_2020.webm) | CC0 |
| `night-sky-empty-640x480.mp4` | Dark night sky, no objects (20 s) | Gavryuha, [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Night_phase.ogv) | CC0 |
| `baby-crying-audio-640x360.mp4` | Newborn crying, over a plain dark frame (23 s) | the_yura, [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Crying_newborn_baby.ogg) | CC0 |
| `testsrc-h264-640x360-20s.mp4` | Synthetic test pattern with a clock (20 s) | generated with FFmpeg `testsrc2` | Apache 2.0 (this repo) |
