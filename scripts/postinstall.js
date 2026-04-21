const { execSync } = require('child_process');

// Install Python deps
try {
  execSync('pip install -r requirements.txt -q', { stdio: 'inherit' });
} catch {
  try {
    execSync('pip3 install -r requirements.txt -q', { stdio: 'inherit' });
  } catch {
    console.log('[blopus] Python deps skipped — install Python if using Gmail/Calendar skills');
  }
}

// Install Playwright browser (required for X home timeline scraping)
console.log('[blopus] Installing Playwright browser (required for X timeline)...');
try {
  execSync('npx playwright install chromium --with-deps', { stdio: 'inherit' });
} catch {
  try {
    execSync('npx playwright install chromium', { stdio: 'inherit' });
  } catch {
    console.log('[blopus] Playwright browser install failed — run: npx playwright install chromium');
  }
}
