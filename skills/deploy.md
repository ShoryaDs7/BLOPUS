---
name: deploy
description: Use this skill when the user wants to deploy a website or backend to the internet so others can access it. Netlify for static HTML sites (free, instant URL). Railway for Node.js/Express backends (free tier). Both produce a live public URL.
---

# Deploy Guide

## Two deployment targets

| What to deploy | Use | Result |
|---------------|-----|--------|
| Static HTML website (index.html) | **Netlify** | yoursite.netlify.app — free forever |
| Node.js/Express backend (server.js) | **Railway** | yourapp.up.railway.app — free tier |
| Both together | Deploy backend to Railway (it serves frontend too) | One URL for everything |

---

## SURGE — Static HTML Site (zero login, zero API key)

Use when: user has `C:/Blopus/output/website/index.html` and no backend.

### Step 1 — Install Surge
```bash
npm install -g surge 2>&1 | tail -3
```

### Step 2 — Generate unique domain name
Always generate a random unique subdomain to avoid conflicts:
```bash
python -c "import random, string, time; slug = ''.join(random.choices(string.ascii_lowercase, k=6)); print(f'blopus-{slug}.surge.sh')"
```
Use the output as the domain. Example: `blopus-xkqmvr.surge.sh`

### Step 3 — Read saved credentials (no interactive prompt)
Surge saves credentials in ~/.netrc after first login. Read them:
```bash
python -c "
import re, os
netrc = open(os.path.expanduser('~/.netrc')).read()
m = re.search(r'machine surge\.surge\.sh\s+login (\S+)\s+password (\S+)', netrc)
if m: print(f'SURGE_LOGIN={m.group(1)}'); print(f'SURGE_TOKEN={m.group(2)}')
else: print('NOT_FOUND')
"
```

### Step 4 — Deploy using saved credentials (no prompt)
```bash
SURGE_LOGIN=$(python -c "import re,os; netrc=open(os.path.expanduser('~/.netrc')).read(); m=re.search(r'machine surge\.surge\.sh\s+login (\S+)', netrc); print(m.group(1) if m else '')")
SURGE_TOKEN=$(python -c "import re,os; netrc=open(os.path.expanduser('~/.netrc')).read(); m=re.search(r'machine surge\.surge\.sh\s+password (\S+)', netrc); print(m.group(1) if m else '')")
SURGE_LOGIN=$SURGE_LOGIN SURGE_TOKEN=$SURGE_TOKEN surge C:/Blopus/output/website blopus-RANDOMSLUG.surge.sh
```
Replace RANDOMSLUG with the slug generated in Step 2.

### What to tell owner after deploy:
"Your site is live at: https://blopus-RANDOMSLUG.surge.sh
Anyone in the world can open it now. Share that link."

### Update the site later (re-deploy to same URL):
```bash
cmd /c "surge C:/Blopus/output/website blopus-RANDOMSLUG.surge.sh"
```
Use the same slug as the first deploy to update in place.

### Custom name (optional):
If owner wants a specific name like `fitflow.surge.sh`:
```bash
cmd /c "surge C:/Blopus/output/website fitflow.surge.sh"
```
If it fails with "no permission" — name is taken, generate a random one instead.

---

## RAILWAY — Python Flask Backend

Use when: user has a Flask app (`app.py`) to deploy.

### CRITICAL Railway Python rules — follow exactly:
1. NEVER create `runtime.txt` — Railway's new Railpack ignores it and errors on it
2. NEVER use `python-3.11.0` format — no precompiled binary available
3. Use `nixpacks.toml` to specify Python version instead
4. Always use `gunicorn` in Procfile, never `python app.py`
5. Always use `$PORT` env var in Procfile — Railway sets this automatically

### Correct file structure for Flask on Railway:
```
app.py
requirements.txt      ← flask, gunicorn, etc
Procfile              ← web: gunicorn app:app --bind 0.0.0.0:$PORT
nixpacks.toml         ← specify python version here NOT runtime.txt
```

### nixpacks.toml (REQUIRED — replaces runtime.txt):
```toml
[phases.setup]
nixPkgs = ["python311"]
```

### Procfile:
```
web: gunicorn app:app --bind 0.0.0.0:$PORT
```

### requirements.txt must include gunicorn:
```
flask
flask-cors
requests
beautifulsoup4
gunicorn
```

### Deploy steps:
```bash
# Step 1 — install Railway CLI if needed
npm install -g @railway/cli 2>&1 | tail -3

# Step 2 — login
railway login

# Step 3 — link to existing project OR init new
railway link   # if project exists on Railway already
# OR
railway init   # if new project

# Step 4 — deploy
railway up

# Step 5 — get public URL
railway domain
```

## RAILWAY — Node.js Backend

Use when: user has `C:/Blopus/output/backend/server.js`.

### Step 1 — Check if Railway CLI installed
```bash
railway --version 2>&1 || echo "NOT_INSTALLED"
```

If NOT_INSTALLED:
```bash
npm install -g @railway/cli 2>&1 | tail -3
```

### Step 2 — Login to Railway
```bash
cmd /c "railway login"
```
Opens browser — tell owner to sign up free at railway.com then authorize.

### Step 3 — Add package.json start script (required by Railway)
Check if start script exists:
```bash
cmd /c "cd C:/Blopus/output/backend && node -e \"const p=require('./package.json'); console.log(p.scripts?.start || 'MISSING')\""
```

If MISSING, add it:
```bash
cmd /c "cd C:/Blopus/output/backend && node -e \"const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json')); p.scripts=p.scripts||{}; p.scripts.start='node server.js'; fs.writeFileSync('package.json', JSON.stringify(p,null,2)); console.log('Added start script')\""
```

### Step 4 — Init Railway project
```bash
cmd /c "cd C:/Blopus/output/backend && railway init"
```
When prompted: create a new project, name it anything (e.g. "blopus-backend").

### Step 5 — Deploy
```bash
cmd /c "cd C:/Blopus/output/backend && railway up"
```

### Step 6 — Get public URL
```bash
cmd /c "cd C:/Blopus/output/backend && railway domain"
```
This gives a public URL like `https://yourapp.up.railway.app`

### What to tell owner after deploy:
"Backend is live at: [railway URL]
API health check: [railway URL]/api/health
Anyone can now hit your API from anywhere."

### Update backend later (re-deploy):
```bash
cmd /c "cd C:/Blopus/output/backend && railway up"
```

---

## BOTH — Frontend + Backend together

When user has both website and backend:

Best approach: Deploy backend to Railway only.
The backend already serves the frontend via express.static.
One Railway URL = frontend + API together.

Before deploying, update the frontend API URL:
```bash
cmd /c "powershell -Command \"(Get-Content C:/Blopus/output/website/index.html) -replace 'http://localhost:3001', 'RAILWAY_URL_HERE' | Set-Content C:/Blopus/output/website/index.html\""
```

Then copy frontend into backend folder:
```bash
cmd /c "xcopy C:/Blopus/output/website C:/Blopus/output/backend/website /E /I /Y"
```

Then deploy backend to Railway as above — it will serve both.

---

## Environment Variables on Railway

If backend uses secrets (JWT_SECRET, API keys etc):
```bash
cmd /c "cd C:/Blopus/output/backend && railway variables set JWT_SECRET=your-secret-here"
cmd /c "cd C:/Blopus/output/backend && railway variables set NODE_ENV=production"
```

---

## Rules — follow every time
1. Static HTML only → Netlify. Has server.js → Railway.
2. Never use & to background processes on Windows — use cmd /c
3. After deploy always give owner the live URL
4. If login step opens browser — tell owner to authorize then confirm back
5. If Railway asks to select environment — choose "production"
6. Always check package.json has "start": "node server.js" before Railway deploy
7. For full-stack (frontend + backend) — deploy to Railway only, not both platforms
