export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function badRequest(message: string, details?: unknown): ApiError {
  return new ApiError(400, 'BAD_REQUEST', message, details);
}

export function unauthorized(message = 'ログインが必要です。'): ApiError {
  return new ApiError(401, 'UNAUTHORIZED', message);
}

export function forbidden(message = 'この操作はあなたの権限ではできません。'): ApiError {
  return new ApiError(403, 'FORBIDDEN', message);
}

export function notFound(message = '対象が見つかりません。'): ApiError {
  return new ApiError(404, 'NOT_FOUND', message);
}

export function conflict(message: string): ApiError {
  return new ApiError(409, 'CONFLICT', message);
}
