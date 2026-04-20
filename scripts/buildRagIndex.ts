/**
 * buildRagIndex.ts — manual trigger (optional, agent auto-builds on first boot)
 * Run: npx ts-node scripts/buildRagIndex.ts
 */
import path from 'path'
import { buildRagIndex } from '../core/rag/ExampleRetriever'

const tweetsPath = process.argv[2] ?? ''
const creatorHandle = process.argv[3] ?? ''
if (!tweetsPath || !creatorHandle) {
  console.error('Usage: npx ts-node scripts/buildRagIndex.ts <path/to/tweets.js> <creator-handle>')
  process.exit(1)
}

buildRagIndex(
  tweetsPath,
  path.resolve(`./creators/${creatorHandle}/rag_index.json`),
)
