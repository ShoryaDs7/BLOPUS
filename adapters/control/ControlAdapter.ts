/**
 * ControlAdapter — base interface for all user-to-OsBot messaging platforms.
 *
 * Every platform (Telegram, WhatsApp, Signal, etc.) implements this.
 * Adding a new platform = implement these 3 methods. That's it.
 *
 * Message flow:
 *   User sends message on platform
 *     → adapter receives it
 *     → calls onMessage handler (set by WizardBrain)
 *     → WizardBrain (Claude API) processes it
 *     → returns response string
 *     → adapter sends it back to user
 */

export interface ControlAdapter {
  /** Called by WizardBrain to register the message handler */
  onMessage(handler: (userId: string, text: string) => Promise<string>): void

  /** Send a message to a specific user */
  sendMessage(userId: string, text: string): Promise<void>

  /** Start the adapter (begin polling/webhook) */
  start(): void
}
