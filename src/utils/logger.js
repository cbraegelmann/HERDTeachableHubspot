const config = require("../config/env");

const LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const COLORS = {
  DEBUG: "\x1b[34m", // Blue
  INFO: "\x1b[32m",  // Green
  WARN: "\x1b[33m",  // Yellow
  ERROR: "\x1b[31m", // Red
  RESET: "\x1b[0m",
};

class Logger {
  constructor() {
    this.level = (config.logLevel || "INFO").toUpperCase();
    this.isProd = config.nodeEnv === "production";
  }

  _shouldLog(level) {
    return LEVELS[level] >= (LEVELS[this.level] || LEVELS.INFO);
  }

  _format(level, message, metadata, service, action, requestId) {
    const timestamp = new Date().toISOString();

    if (this.isProd) {
      return JSON.stringify({
        level,
        timestamp,
        service: service || "N/A",
        action: action || "N/A",
        requestId: requestId || "N/A",
        message,
        ...metadata,
      });
    }

    const color = COLORS[level] || "";
    const reset = COLORS.RESET;
    const reqIdStr = requestId ? ` [${requestId}]` : " [N/A]";
    const serviceStr = service ? ` [${service}]` : " [N/A]";
    const actionStr = action ? ` [${action}]` : " [N/A]";

    let logMsg = `${color}[${level}]${reset} [${timestamp}]${serviceStr}${actionStr}${reqIdStr} → ${message}`;
    if (metadata && Object.keys(metadata).length > 0) {
      logMsg += ` ${JSON.stringify(metadata)}`;
    }
    return logMsg;
  }

  info(message, context = {}) {
    if (this._shouldLog("INFO")) {
      const { service, action, requestId, ...metadata } = typeof context === 'string' ? { message: context } : context;
      console.log(this._format("INFO", message, metadata, service, action, requestId));
    }
  }

  error(message, context = {}) {
    if (this._shouldLog("ERROR")) {
      const { service, action, requestId, ...metadata } = context;
      console.error(this._format("ERROR", message, metadata, service, action, requestId));
    }
  }

  warn(message, context = {}) {
    if (this._shouldLog("WARN")) {
      const { service, action, requestId, ...metadata } = context;
      console.warn(this._format("WARN", message, metadata, service, action, requestId));
    }
  }

  debug(message, context = {}) {
    if (this._shouldLog("DEBUG")) {
      const { service, action, requestId, ...metadata } = context;
      console.debug(this._format("DEBUG", message, metadata, service, action, requestId));
    }
  }
}

module.exports = new Logger();
