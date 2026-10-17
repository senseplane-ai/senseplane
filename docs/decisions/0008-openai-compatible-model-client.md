# 8. One OpenAI-compatible model client

Date: 2026-10-15 · Status: accepted

## Decision
The brain calls every model (vision, watch compiler, summaries) through the
`openai` Python SDK pointed at any OpenAI-compatible endpoint.

- Any OpenAI-compatible endpoint, for example OpenRouter or a local model:
  `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL_VISION`, `AI_MODEL_TEXT`
  (optional `AI_MODEL_COMPILE`, `AI_MODEL_SUMMARY`).
- Embeddings are configured separately and default to a small local model.
- Images are sent as base64 `image_url` parts; JSON mode where supported,
  otherwise schema-validated JSON with one retry; a startup probe checks the
  vision model accepts images (not wired in today: the brain doesn't call it).

When the endpoint is OpenRouter, requests ask for providers that don't retain
data. Where model calls are processed depends on the endpoint you configure.
