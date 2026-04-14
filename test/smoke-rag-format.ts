import { ExampleRetriever } from '../core/rag/ExampleRetriever'
import * as path from 'path'
import * as dotenv from 'dotenv'

dotenv.config({ path: path.resolve(process.cwd(), 'creators/shoryaDs7/.env') })

const r = new ExampleRetriever(path.resolve(process.cwd(), 'creators/shoryaDs7/rag_index.json'))
r.load(process.env.TWITTER_ARCHIVE_PATH)

const tweets = [
  'Job interviews are just two people lying to each other',
  'A man pulls left with 20N. Two women pull right each 10N. What is tension in rope? A) 0N B) 40N C) 20N D) None',
  'A YouTuber is attempting to beat MrBeast counting record, 24 hours in at 40,000',
]

for (const t of tweets) {
  const res = r.retrieveWithFormat(t, 5)
  console.log()
  console.log('TWEET   :', t.slice(0, 80))
  console.log('medianLen:', res.medianLength + 'ch')
  console.log('EXAMPLES:')
  res.examples.slice(0, 3).forEach((e, i) =>
    console.log(`  ${i + 1}. "${e.slice(0, 90)}"  [${e.length}ch]`)
  )
}
