import * as core from '@actions/core'

export const logger = {
  info: (message: string): void => {
    core.info(message)
  },

  debug: (message: string): void => {
    core.debug(message)
  },

  warning: (message: string): void => {
    core.warning(message)
  },

  error: (message: string | Error): void => {
    if (message instanceof Error) {
      core.error(message.message)
    } else {
      core.error(message)
    }
  },

  group: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    return core.group(name, fn)
  }
}
