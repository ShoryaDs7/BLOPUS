import 'dotenv/config'
import path from 'path'
import { config as dotenvConfig } from 'dotenv'

const creator = process.env.CREATOR
if (creator) {
  dotenvConfig({ path: path.join(process.cwd(), 'creators', creator, '.env'), override: false })
  process.env.BLOPUS_CONFIG_PATH = path.join(process.cwd(), 'creators', creator, 'config.json')
  process.env.BLOPUS_DIR = process.cwd()
}

import { GoalRunner } from './GoalRunner'

const runner = new GoalRunner()
runner.start()

process.on('SIGINT',  () => { runner.stop(); process.exit(0) })
process.on('SIGTERM', () => { runner.stop(); process.exit(0) })
