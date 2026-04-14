/**
 * buildRagIndex.ts — manual trigger (optional, agent auto-builds on first boot)
 * Run: npx ts-node scripts/buildRagIndex.ts
 */
import path from 'path'
import { buildRagIndex } from '../core/rag/ExampleRetriever'

buildRagIndex(
  'C:/Users/DS7/Downloads/data/tweets.js',
  path.resolve('./creators/shoryaDs7/rag_index.json'),
)
