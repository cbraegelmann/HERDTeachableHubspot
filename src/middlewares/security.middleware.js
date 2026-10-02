const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('../config/env');

const securityMiddleware = [
    helmet(),
    cors({
        origin: (origin, callback) => {
            if (!origin || config.cors.origins.includes(origin) || config.nodeEnv === 'development') {
                callback(null, true);
            } else {
                callback(new Error('Not allowed by CORS'));
            }
        }
    })
];

const rateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: "Too many requests from this IP, please try again after 15 minutes",
  standardHeaders: true,
  legacyHeaders: false,
});

// Sized for individual Teachable course-completion events, not bulk sync.
// Separate from the generic limiter above so webhook traffic can't be starved
// by, or accidentally starve, any other route sharing the same budget.
const webhookRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  message: "Too many webhook requests, please try again shortly",
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
    securityMiddleware,
    rateLimiter,
    webhookRateLimiter
};
