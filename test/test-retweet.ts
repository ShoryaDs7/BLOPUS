import * as path from 'path'
import * as dotenv from 'dotenv'
dotenv.config({ path: path.resolve(process.cwd(), 'creators/shoryaDs7/.env') })

import { PlaywrightXClient } from '../adapters/x/PlaywrightXClient'

const client = new PlaywrightXClient(
  process.env.OWNER_HANDLE ?? 'shoryaDs7',
  process.env.X_PASSWORD!,
)

client.retweet('2043772671742349754')
  .then(() => { console.log('Retweet done'); process.exit(0) })
  .catch(e => { console.error(e); process.exit(1) })
