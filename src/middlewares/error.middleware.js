const logger = require('../utils/logger');
const ApiError = require('../utils/apiError');
const { buildErrorResponse } = require('../utils/apiResponse');

const errorConverter = (err, req, res, next) => {
  let error = err;

  if (!(error instanceof ApiError)) {
    const statusCode = error.statusCode || (error instanceof Error ? 500 : 400);
    const message = error.message || "Internal Server Error";
    error = new ApiError(
      statusCode,
      message,
      false,
      err.stack
    );

    if (err.rawError) {
      error.rawError = err.rawError;
    }
  }

  next(error);
};

const errorHandler = (err, req, res, next) => {
  const statusCode = err.statusCode || 500;

  let errorCode = err.errorCode || "INTERNAL_ERROR";
  let message = err.message || "Internal Server Error";
  let details = {};

  if (err.statusCode === 400 && !err.errorCode) {
    errorCode = "VALIDATION_ERROR";
  }

  if (err.payload && typeof err.payload === "object") {
    details = err.payload;
  }

  if (process.env.NODE_ENV === "production" && !err.isOperational) {
    message = "Internal Server Error";
  }

  logger.error(message, {
    requestId: req.id,
    statusCode,
    errorCode,
    details,
    stack: err.stack,
    service: "HTTP",
    action: "ERROR_HANDLER",
  });

  res.status(statusCode).json(buildErrorResponse(message, errorCode, details));
};

module.exports = {
  errorConverter,
  errorHandler
};
