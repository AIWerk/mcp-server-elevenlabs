export class ElevenLabsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElevenLabsConfigError';
  }
}

export class ElevenLabsApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'ElevenLabsApiError';
  }
}

export class ElevenLabsAuthError extends ElevenLabsApiError {
  constructor(status: number, statusText: string, body: unknown, message: string) {
    super(status, statusText, body, message);
    this.name = 'ElevenLabsAuthError';
  }
}

/**
 * 401 with a body that names a missing permission. An ElevenLabs API key can be
 * scope-restricted per endpoint group, so "unauthorized" here usually means the
 * key is valid but not allowed to touch this endpoint — a different fix from a
 * wrong key, and worth saying so.
 */
export class ElevenLabsScopeError extends ElevenLabsApiError {
  constructor(status: number, statusText: string, body: unknown, message: string) {
    super(status, statusText, body, message);
    this.name = 'ElevenLabsScopeError';
  }
}

/** 401 caused by the IP allowlist on the key rather than the key itself. */
export class ElevenLabsIpBlockedError extends ElevenLabsApiError {
  constructor(status: number, statusText: string, body: unknown, message: string) {
    super(status, statusText, body, message);
    this.name = 'ElevenLabsIpBlockedError';
  }
}

/** 401 quota_exceeded: the account or the key's own credit quota ran out. */
export class ElevenLabsQuotaError extends ElevenLabsApiError {
  constructor(status: number, statusText: string, body: unknown, message: string) {
    super(status, statusText, body, message);
    this.name = 'ElevenLabsQuotaError';
  }
}

export class ElevenLabsRateLimitError extends ElevenLabsApiError {
  constructor(
    status: number,
    statusText: string,
    body: unknown,
    message: string,
    public readonly resetSeconds: number | null,
  ) {
    super(status, statusText, body, message);
    this.name = 'ElevenLabsRateLimitError';
  }
}

export class ElevenLabsTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElevenLabsTimeoutError';
  }
}

export class ElevenLabsNetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElevenLabsNetworkError';
  }
}

/** A local file argument (upload source or output target) that cannot be used. */
export class ElevenLabsFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ElevenLabsFileError';
  }
}
