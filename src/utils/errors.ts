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
