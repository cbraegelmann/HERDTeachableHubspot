const express = require("express");
const router = express.Router();
const teachableWebhookAuth = require("../../middlewares/teachableWebhookAuth.middleware");
const validate = require("../../middlewares/validate.middleware");
const { envelopeSchema } = require("./validations/teachableWebhook.validation");
const controller = require("./controllers/teachableWebhook.controller");

// The secret path token is the sole inbound auth mechanism (see
// teachableWebhookAuth.middleware.js) since Teachable does not sign webhooks.
// Only the loose envelope is validated here; the strict Enrollment.completed
// schema is applied per event in the controller, so that other subscribed
// event types can be acknowledged and ignored rather than rejected.
router.post(
  "/:secretToken",
  teachableWebhookAuth,
  validate(envelopeSchema),
  controller.handleWebhook,
);

module.exports = router;
