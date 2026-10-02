const buildErrorResponse = (message = "Something went wrong", errorCode = "INTERNAL_ERROR", details = {}) => {
  return {
    success: false,
    errorCode,
    message,
    details
  };
};

module.exports = {
  buildErrorResponse,
};
