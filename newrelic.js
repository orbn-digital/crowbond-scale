'use strict';

/**
 * New Relic agent configuration.
 */
exports.config = {
  app_name: [process.env.NEW_RELIC_APP_NAME || 'Crowbond-Scales'],
  license_key: process.env.NEW_RELIC_LICENSE_KEY,
  logging: {
    level: process.env.NEW_RELIC_LOG_LEVEL || 'info',
  },
  allow_all_headers: true,
  attributes: {
    exclude: [
      'request.headers.cookie',
      'request.headers.authorization',
      'request.headers.proxyAuthorization',
      'request.headers.setCookie*',
      'request.headers.x*',
      'response.headers.cookie',
      'response.headers.authorization',
      'response.headers.proxyAuthorization',
      'response.headers.setCookie*',
      'response.headers.x*',
    ],
  },
  distributed_tracing: {
    enabled: true,
  },
  error_collector: {
    enabled: true,
    ignore_status_codes: [404],
  },
};