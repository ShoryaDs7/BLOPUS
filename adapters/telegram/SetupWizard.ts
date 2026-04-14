/**
 * SetupWizard — stub.
 * New user setup is handled by the terminal: npm run setup
 * This stub keeps TelegramAdapter compiling without changes.
 */

import { Api } from 'grammy'

export class SetupWizard {
  private api: Api

  constructor(api: Api) {
    this.api = api
  }

  isActive(_chatId: number): boolean {
    return false
  }

  async handleFirstContact(chatId: number): Promise<void> {
    await this.api.sendMessage(chatId,
      `this is a private Blopus instance.\n\nset up your own at github.com/blopus/blopus`
    ).catch(() => {})
  }

  async start(chatId: number): Promise<void> {
    await this.api.sendMessage(chatId,
      `setup is done via terminal.\n\nrun: npm run setup`
    ).catch(() => {})
  }

  async handleMessage(_chatId: number, _text: string): Promise<void> {}

  async handleDocument(_chatId: number, _fileId: string): Promise<void> {}
}
