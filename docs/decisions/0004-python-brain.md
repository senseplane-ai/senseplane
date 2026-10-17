# 4. The brain is written in Python

Date: 2026-10-15 · Status: accepted

## Decision
`brain/` is Python 3.12, managed with uv. ONNX Runtime, OpenCV and numpy are
native there and new models ship in Python first. Types come from `spec/` via
`datamodel-code-generator`, checked for drift in CI. Heavy work (decode,
inference) runs in native code regardless of host language.
