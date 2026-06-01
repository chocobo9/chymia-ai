// M14 Telegram adapter barrel — public surface of the telegram/ subdir.
// The top-level packages/adapters/index.ts (orchestrator-owned) re-exports from here.

export {
  createTelegramAdapter,
  TELEGRAM_ADAPTER_NAME,
  TELEGRAM_BOT_TOKEN_ENV,
  type TelegramAdapterDeps,
  type TelegramBotPort,
  type TelegramApiPort,
  type TelegramUpdateContext,
  type TelegramLogger,
} from './telegram-adapter.js';
export { formatToTelegramHtml, escapeHtml } from './html-formatter.js';
export { splitHtmlMessage, TELEGRAM_MAX_MESSAGE_LENGTH } from './message-splitter.js';
