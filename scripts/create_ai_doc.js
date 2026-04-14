const { google } = require('C:/Blopus/node_modules/googleapis');
const path = require('path');
const fs = require('fs');

// Read credentials from .env file
const envPath = 'C:/Blopus/creators/shoryaDs7/.env';
const envContent = fs.readFileSync(envPath, 'utf8');
const envVars = {};
envContent.split(/\r?\n/).forEach(line => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) return;
  const key = trimmed.slice(0, eqIdx).trim();
  const value = trimmed.slice(eqIdx + 1).trim();
  envVars[key] = value;
});

const CLIENT_ID = envVars['GOOGLE_CLIENT_ID'];
const CLIENT_SECRET = envVars['GOOGLE_CLIENT_SECRET'];
const REFRESH_TOKEN = envVars['GOOGLE_REFRESH_TOKEN'];

if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error('Missing required Google credentials in .env file');
  process.exit(1);
}

async function main() {
  // Step 1: Set up OAuth2 client and get fresh access token
  const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

  // Trigger token refresh
  const { credentials } = await oauth2Client.refreshAccessToken();
  oauth2Client.setCredentials(credentials);
  console.log('Access token obtained successfully.');

  // Step 2: Create Google Docs client
  const docs = google.docs({ version: 'v1', auth: oauth2Client });

  // Step 3: Create the document with title
  const docTitle = 'AI Weekly Review — April 11, 2026';
  const createResponse = await docs.documents.create({
    requestBody: {
      title: docTitle,
    },
  });

  const docId = createResponse.data.documentId;
  console.log(`Document created with ID: ${docId}`);

  // Step 4: Build the content via batchUpdate requests
  // We'll insert text from end to beginning to maintain index accuracy,
  // or we'll build one big text block and insert at once.

  const content = `AI Weekly Review — April 11, 2026\n\nTop 3 Trending AI Stories\n\n────────────────────────────────────────\nStory 1: Meta Launches Muse Spark\n────────────────────────────────────────\n\nMeta dropped its first major AI model called Muse Spark after spending billions and poaching 50+ researchers from OpenAI, Anthropic, and Google. Alexandr Wang (ex-Scale AI CEO) is leading the superintelligence team.\n\nKey Takeaways:\n• Meta is making a serious play for AI dominance\n• Hiring war heating up — talent is the real moat\n• Watch for Muse Spark to go head-to-head with GPT-4o and Gemini\n\n────────────────────────────────────────\nStory 2: AI Energy Breakthrough — 100x Efficiency Gain\n────────────────────────────────────────\n\nNew research published shows an AI technique that cuts energy use by 100x while actually improving model accuracy. Massive implications for scaling AI infrastructure sustainably.\n\nKey Takeaways:\n• AI's energy problem may have a real technical solution\n• Could unlock AI deployment in energy-constrained regions\n• Hardware companies like Nvidia should take note\n\n────────────────────────────────────────\nStory 3: OpenAI Enterprise Now 40%+ of Revenue\n────────────────────────────────────────\n\nOpenAI's enterprise segment now accounts for more than 40% of total revenue and is on pace to match consumer revenue by end of 2026. The B2B push is paying off big.\n\nKey Takeaways:\n• Enterprise AI adoption is accelerating fast\n• OpenAI is becoming a serious B2B software company\n• Expect more vertical-specific AI products from them\n`;

  // Insert content at the end of the document (index 1 is after the title area)
  // We'll insert after the existing title by using insertText at index 1
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [
        {
          insertText: {
            location: { index: 1 },
            text: content,
          },
        },
      ],
    },
  });

  console.log('Content inserted successfully.');

  // Step 5: Apply formatting — make the main title bold and larger
  // First, get the document to know indices
  const docData = await docs.documents.get({ documentId: docId });

  // Format the header line (first line): "AI Weekly Review — April 11, 2026"
  // It starts at index 1, length = docTitle.length (34 chars) + the \n
  const titleText = 'AI Weekly Review — April 11, 2026';
  // Note: em dash is 3 bytes in some encodings but Google Docs counts it as 1 char
  const titleLength = [...titleText].length; // use spread for Unicode char count

  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [
        // Format main title: bold, size 20
        {
          updateTextStyle: {
            range: { startIndex: 1, endIndex: 1 + titleLength },
            textStyle: {
              bold: true,
              fontSize: { magnitude: 20, unit: 'PT' },
            },
            fields: 'bold,fontSize',
          },
        },
        // Format "Top 3 Trending AI Stories" line
        {
          updateTextStyle: {
            range: {
              startIndex: 1 + titleLength + 2, // after title + 2 newlines
              endIndex: 1 + titleLength + 2 + 'Top 3 Trending AI Stories'.length,
            },
            textStyle: {
              bold: true,
              fontSize: { magnitude: 14, unit: 'PT' },
            },
            fields: 'bold,fontSize',
          },
        },
      ],
    },
  });

  console.log('Formatting applied.');

  // Step 6: Return the URL
  const docUrl = `https://docs.google.com/document/d/${docId}/edit`;
  console.log('\n========================================');
  console.log('Google Doc created successfully!');
  console.log(`Title: ${docTitle}`);
  console.log(`URL: ${docUrl}`);
  console.log('========================================\n');
}

main().catch(err => {
  console.error('Error:', err.message || err);
  if (err.response && err.response.data) {
    console.error('API Error details:', JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
