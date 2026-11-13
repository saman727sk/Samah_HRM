/**
 * AppError carries an i18n message code + params so the API can render it in
 * the tenant's language. `details` holds structured data (e.g. validation
 * errors, per-date WFH reasons).
 */
export class AppError extends Error {
  constructor(status, code, message, { params = {}, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.params = params;
    this.details = details;
  }
}

export const badRequest = (code, message, opts) => new AppError(400, code, message, opts);
export const forbidden = (message = 'You do not have access to this resource.') => new AppError(403, 'forbidden', message);
export const notFound = (what = 'Record') => new AppError(404, 'not_found', `${what} not found.`);
export const conflict = (code, message, opts) => new AppError(409, code, message, opts);
