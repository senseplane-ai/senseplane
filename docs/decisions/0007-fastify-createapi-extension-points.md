# 7. Fastify API with createApi extension points

Date: 2026-10-15 · Status: accepted

## Decision
The API uses Fastify (MIT). The package exports
`createApi({ modules, internalPort, ... })` and stable `ApiModule`,
`ModuleContext` and `DataAccess` interfaces. The open-source server calls it
with no modules. Any deployment can import the package and register its own
modules (for example administration or abuse tooling); such routes can be
served on an internal-only listener.

## Consequences
`createApi`, `ApiModule`, `ModuleContext` and `DataAccess` follow semver like
the public API, so external modules can pin a version.
