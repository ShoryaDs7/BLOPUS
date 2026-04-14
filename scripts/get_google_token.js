const http = require('http');
const https = require('https');
const { exec } = require('child_process');
const fs = require('fs');

const envContent = fs.readFileSync('C:/Blopus/creators/shoryaDs7/.env', 'utf8');
const envVars = {};
envContent.split(/\r?\n/).forEach(line => {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx === -1) return;
  envVars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
});

const CLIENT_ID = envVars['GOOGLE_CLIENT_ID'];
const CLIENT_SECRET = envVars['GOOGLE_CLIENT_SECRET'];
const REDIRECT_URI = 'http://localhost:9999/callback';

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope: 'https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive',
  access_type: 'offline',
  prompt: 'consent'
});

console.log('\nOpening browser for Google OAuth authorization...');
console.log('If browser does not open, visit this URL manually:\n');
console.log(authUrl + '\n');

// Open the URL in the default system browser
const openCmd = process.platform === 'win32' ? `start "" "${authUrl}"` : `xdg-open "${authUrl}"`;
exec(openCmd);

// Start local server to catch the callback
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost:9999');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>Authorization failed: ' + error + '</h1>');
    console.error('Auth error:', error);
    server.close();
    return;
  }

  if (!code) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>No code received</h1>');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h1>Authorization successful! You can close this tab.</h1>');

  // Exchange code for tokens
  const body = new URLSearchParams({
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code'
  }).toString();

  const reqOpts = {
    hostname: 'oauth2.googleapis.com',
    path: '/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  const tokenReq = https.request(reqOpts, tokenRes => {
    let data = '';
    tokenRes.on('data', d => data += d);
    tokenRes.on('end', () => {
      const tokens = JSON.parse(data);
      if (tokens.error) {
        console.error('Token exchange error:', tokens.error, tokens.error_description);
      } else {
        console.log('\n=== NEW REFRESH TOKEN ===');
        console.log(tokens.refresh_token);
        console.log('========================\n');

        // Write new refresh token to .env
        let envFile = fs.readFileSync('C:/Blopus/creators/shoryaDs7/.env', 'utf8');
        envFile = envFile.replace(
          /^GOOGLE_REFRESH_TOKEN=.*/m,
          'GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token
        );
        fs.writeFileSync('C:/Blopus/creators/shoryaDs7/.env', envFile);
        console.log('Refresh token saved to .env file.');
        console.log('Access token (expires in 1hr):', tokens.access_token?.slice(0, 30) + '...');
      }
      server.close();
    });
  });

  tokenReq.on('error', e => console.error('Token request error:', e));
  tokenReq.write(body);
  tokenReq.end();
});

server.listen(9999, () => {
  console.log('Waiting for Google OAuth callback on http://localhost:9999/callback ...');
  console.log('(Will timeout in 120 seconds if no response)');
});

setTimeout(() => {
  console.error('Timed out waiting for OAuth callback.');
  server.close();
  process.exit(1);
}, 120000);
