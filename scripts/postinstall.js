const { execSync } = require('child_process');

try {
  execSync('pip install -r requirements.txt -q', { stdio: 'inherit' });
} catch {
  try {
    execSync('pip3 install -r requirements.txt -q', { stdio: 'inherit' });
  } catch {
    console.log('[blopus] Python deps skipped — install Python if using Gmail/Calendar skills');
  }
}
