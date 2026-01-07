export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigurationError'
  }
}

export class OpenCodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpenCodeError'
  }
}

export class GitHubAPIError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitHubAPIError'
  }
}

export class ReviewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReviewError'
  }
}

export class OrchestratorError extends Error {
  constructor(
    message: string,
    public cause?: Error
  ) {
    super(message)
    this.name = 'OrchestratorError'
  }
}

export function isTokenRefreshError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const message = error.message.toLowerCase()
  return (
    message.includes('token refresh failed') ||
    message.includes('token refresh error') ||
    (message.includes('refresh') && message.includes('400'))
  )
}
