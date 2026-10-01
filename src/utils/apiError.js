class ApiError extends Error {
  constructor(statusCode, message, isOperational = true, stack = "", options = {}) {
    super(typeof message === "string" ? message : "");

    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.payload = message; // preserve object if provided
    this.errorCode = options.errorCode;
    this.retryable = options.retryable;

    if (stack) {
      this.stack = stack;
    } else {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

module.exports = ApiError;
