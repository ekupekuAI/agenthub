---
name: api-docs-writer
description: Write or update reference documentation for HTTP API endpoints from the source code. Use when an endpoint is added or changed, or when API docs are missing or stale.
license: MIT
metadata:
  category: docs
  tags: api rest openapi reference documentation
---

# API docs writer

Produce accurate endpoint reference docs that a client developer can use without reading the
server code.

## Find the truth in code

1. Locate the route definition and its handler. Note the method, path and path parameters.
2. Find the input validation (schema, DTO or manual checks). That is the real contract for
   query parameters and request bodies, including defaults and limits.
3. Find every response the handler can return: success shape, status codes and error shapes.
4. Note authentication and rate limits applied by middleware.

If the project has an OpenAPI file, update it and keep the prose docs consistent with it.

## Template per endpoint

```
### GET /api/v1/items/{id}

Returns one item.

Auth: bearer token with the `items:read` scope.

Path parameters
| Name | Type   | Notes            |
|------|--------|------------------|
| id   | string | Item identifier. |

Responses
- 200: `{ "ok": true, "data": Item }`
- 404: `{ "ok": false, "error": { "code": "NOT_FOUND", "message": "..." } }`

Example
GET /api/v1/items/42
```

## Rules

- Document what the code does today, not what it should do. Flag mismatches separately.
- Every field gets a type, whether it is optional, and its default.
- Show one realistic request and response per endpoint, using fake but plausible data.
- Never paste real tokens, keys or customer data into examples.
- Keep error codes in a single shared table if more than two endpoints use them.
