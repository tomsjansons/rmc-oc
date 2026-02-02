export const OPENCODE_SERVER_PORT = 4096
export const OPENCODE_SERVER_HOST = '127.0.0.1'
export const OPENCODE_SERVER_URL = `http://${OPENCODE_SERVER_HOST}:${OPENCODE_SERVER_PORT}`

export const TRPC_SERVER_PORT = 38291
export const TRPC_SERVER_HOST = '127.0.0.1'
export const TRPC_SERVER_URL = `http://${TRPC_SERVER_HOST}:${TRPC_SERVER_PORT}`

export const OPENROUTER_API_URL =
  'https://openrouter.ai/api/v1/chat/completions'

export const BOT_MENTION = '@review-my-code-bot'
export const BOT_MENTION_SHORT = '@rmc-bot'
export const BOT_MENTIONS = [BOT_MENTION, BOT_MENTION_SHORT] as const

export const BOT_USERS = ['github-actions[bot]', 'opencode-reviewer[bot]']
