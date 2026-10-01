# HERD Teachable → HubSpot

Node.js / Express backend boilerplate. Ships with a working health check so you
can confirm the server runs before any integration code is added.

## Requirements

- Node.js >= 18

## Setup

```bash
npm install
cp .env.example .env   # already created for you; edit as needed
npm run dev
```

The server starts on `http://localhost:3000` (override with `PORT`).

## Verify the server is working

```bash
curl http://localhost:3000/health
```

```json
{
  "success": true,
  "message": "Server is running",
  "data": {
    "status": "ok",
    "service": "herd-teachable-hubspot",
    "version": "1.0.0",
    "environment": "development",
    "uptimeSeconds": 12,
    "hostname": "your-machine",
    "timestamp": "2026-10-01T12:00:00.000Z"
  }
}
```

| Method | Endpoint        | Purpose                                                      |
| ------ | --------------- | ------------------------------------------------------------ |
| GET    | `/health`       | Liveness. Dependency-free: is the process up and serving?      |
| GET    | `/health/ready` | Readiness. Returns 503 once a registered dependency check fails. |

## Scripts

| Command         | Description                          |
| --------------- | ------------------------------------ |
| `npm start`     | Run the server                       |
| `npm run dev`   | Run with nodemon (reloads on change) |
| `npm test`      | Run the Jest suite                   |

## Structure

```
src/
├── app.js                  Express app: middleware chain + route mounting
├── server.js               Process entry: listen, signal + crash handling
├── config/
│   └── env.js              Loads, validates and freezes env config
├── middlewares/
│   ├── error.middleware.js         errorConverter + errorHandler
│   ├── requestLogger.middleware.js Request id + structured access log
│   ├── security.middleware.js      helmet, cors, rate limiting
│   └── validate.middleware.js      Joi schema validation
├── modules/
│   └── health/             One folder per feature
│       ├── controllers/
│       └── routes.js
├── utils/
│   ├── apiError.js         Error class carrying status + error code
│   ├── apiResponse.js      Success/error response shapes
│   ├── asyncHandler.js     Forwards async rejections to the error handler
│   ├── errorCodes.js       Error taxonomy (retryable + log level)
│   ├── logger.js           JSON in production, coloured lines elsewhere
│   └── pick.js
└── validations/
    └── common.schema.js    Schemas shared across modules

tests/
├── helpers/testEnv.js      Env values for the suite (jest setupFiles)
└── integration/
```

## Adding a feature

1. Create `src/modules/<feature>/` with `routes.js`, `controllers/`, and
   `services/` + `validations/` as needed.
2. Mount it in [src/app.js](src/app.js) below the `// Application Routes` marker.
3. Add any new env var to **both** `.env` and `.env.example`, and to
   `REQUIRED_ENV_VARS` in [src/config/env.js](src/config/env.js) if the app
   cannot start without it.
4. Register dependency checks in `getReadiness`
   ([src/modules/health/controllers/health.controller.js](src/modules/health/controllers/health.controller.js))
   so `/health/ready` reflects reality.

## Conventions

- Controllers wrap handlers in `asyncHandler` so rejections reach the error
  handler instead of hanging the request.
- Throw `new ApiError(status, message, true, "", { errorCode })` rather than
  shaping error responses by hand.
- Responses go through `buildSuccessResponse` / `buildErrorResponse` so every
  endpoint returns the same envelope.
- Log with `logger.<level>(message, { service, action, requestId })`. Never log
  secrets; mask them in `REDACTIONS` in the request logger.
