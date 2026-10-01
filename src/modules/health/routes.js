const express = require("express");
const controller = require("./controllers/health.controller");

const router = express.Router();

router.get("/", controller.getHealth);
router.get("/ready", controller.getReadiness);

module.exports = router;
