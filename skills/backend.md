---
name: backend
description: Use this skill when the user wants to build a backend API, server, database, auth system (signup/login), REST endpoints, or connect a frontend website to a real backend. Uses Node.js + Express + SQLite. No cloud required — runs locally instantly.
---

# Backend Builder Guide

## Stack — always use this
- **Node.js + Express** — HTTP server, API routes
- **SQLite** (via better-sqlite3) — local database, zero setup, single file
- **JWT** (via jsonwebtoken) — auth tokens for login/signup
- **bcrypt** (via bcryptjs) — password hashing
- **CORS** (via cors) — allow frontend to call the API

## Setup — always do this first
```bash
# Create backend folder
mkdir -p C:/Blopus/output/backend
cd C:/Blopus/output/backend

# Init project
cmd /c "cd C:/Blopus/output/backend && npm init -y"

# Install dependencies
cmd /c "cd C:/Blopus/output/backend && npm install express better-sqlite3 jsonwebtoken bcryptjs cors dotenv"
```

---

## Full Backend Template (server.js)

Always save to `C:/Blopus/output/backend/server.js`:

```javascript
const express = require('express')
const Database = require('better-sqlite3')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')
const cors = require('cors')
const path = require('path')
const fs = require('fs')

const app = express()
const PORT = process.env.PORT || 3001
const JWT_SECRET = process.env.JWT_SECRET || 'blopus-secret-change-in-production'

// Middleware
app.use(cors())
app.use(express.json())

// Serve frontend if it exists
const frontendPath = path.join(__dirname, '../website')
if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath))
}

// Database setup
const db = new Database(path.join(__dirname, 'database.db'))

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`)

// ── Auth middleware ──────────────────────────────────────────
function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No token provided' })
  try {
    req.user = jwt.verify(token, JWT_SECRET)
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

// ── Auth Routes ──────────────────────────────────────────────

// POST /api/signup
app.post('/api/signup', async (req, res) => {
  const { name, email, password } = req.body
  if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' })
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' })

  try {
    const hashed = await bcrypt.hash(password, 10)
    const stmt = db.prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)')
    const result = stmt.run(name, email, hashed)
    const token = jwt.sign({ id: result.lastInsertRowid, email, name }, JWT_SECRET, { expiresIn: '7d' })
    res.json({ success: true, token, user: { id: result.lastInsertRowid, name, email } })
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Email already exists' })
    res.status(500).json({ error: 'Server error' })
  }
})

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' })

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email)
  if (!user) return res.status(401).json({ error: 'Invalid email or password' })

  const valid = await bcrypt.compare(password, user.password)
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' })

  const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' })
  res.json({ success: true, token, user: { id: user.id, name: user.name, email: user.email } })
})

// GET /api/me — get current user (requires auth)
app.get('/api/me', authenticate, (req, res) => {
  const user = db.prepare('SELECT id, name, email, created_at FROM users WHERE id = ?').get(req.user.id)
  res.json({ user })
})

// POST /api/logout
app.post('/api/logout', authenticate, (req, res) => {
  res.json({ success: true, message: 'Logged out' })
})

// ── Health check ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ── Catch-all: serve frontend index.html ─────────────────────
app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, '../website/index.html')
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath)
  } else {
    res.json({ message: 'Blopus Backend API running', endpoints: ['/api/signup', '/api/login', '/api/me', '/api/health'] })
  }
})

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`)
  console.log(`   API: http://localhost:${PORT}/api/health`)
})
```

---

## Adding Custom Data Tables

After the users table, add any app-specific tables:

```javascript
// Example: posts table
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`)

// Example: products table
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    price REAL NOT NULL,
    description TEXT,
    stock INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`)
```

---

## Adding Custom API Routes

```javascript
// GET all items (public)
app.get('/api/posts', (req, res) => {
  const posts = db.prepare('SELECT * FROM posts ORDER BY created_at DESC').all()
  res.json({ posts })
})

// GET single item
app.get('/api/posts/:id', (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id)
  if (!post) return res.status(404).json({ error: 'Not found' })
  res.json({ post })
})

// POST create item (requires auth)
app.post('/api/posts', authenticate, (req, res) => {
  const { title, content } = req.body
  if (!title) return res.status(400).json({ error: 'Title required' })
  const result = db.prepare('INSERT INTO posts (user_id, title, content) VALUES (?, ?, ?)').run(req.user.id, title, content)
  res.json({ success: true, id: result.lastInsertRowid })
})

// DELETE item (requires auth + ownership)
app.delete('/api/posts/:id', authenticate, (req, res) => {
  const post = db.prepare('SELECT * FROM posts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id)
  if (!post) return res.status(404).json({ error: 'Not found or not yours' })
  db.prepare('DELETE FROM posts WHERE id = ?').run(req.params.id)
  res.json({ success: true })
})
```

---

## Connect Frontend to Backend

When user has both a website and backend, update the frontend's buttons to call the API.

Add this script to the HTML `<head>`:
```html
<script>
const API = 'http://localhost:3001/api'

// Signup
async function signup(name, email, password) {
  const res = await fetch(`${API}/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password })
  })
  const data = await res.json()
  if (data.token) {
    localStorage.setItem('token', data.token)
    localStorage.setItem('user', JSON.stringify(data.user))
    return data
  }
  throw new Error(data.error)
}

// Login
async function login(email, password) {
  const res = await fetch(`${API}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  })
  const data = await res.json()
  if (data.token) {
    localStorage.setItem('token', data.token)
    localStorage.setItem('user', JSON.stringify(data.user))
    return data
  }
  throw new Error(data.error)
}

// Logout
function logout() {
  localStorage.removeItem('token')
  localStorage.removeItem('user')
  window.location.reload()
}

// Check if logged in
function getUser() {
  const user = localStorage.getItem('user')
  return user ? JSON.parse(user) : null
}

// Authenticated API call
async function apiCall(endpoint, method = 'GET', body = null) {
  const token = localStorage.getItem('token')
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  })
  return res.json()
}
</script>
```

Then wire buttons like:
```html
<!-- Signup form -->
<form onsubmit="handleSignup(event)">
  <input id="name" placeholder="Your name" required />
  <input id="email" type="email" placeholder="Email" required />
  <input id="password" type="password" placeholder="Password" required />
  <button type="submit">Sign Up</button>
</form>

<script>
async function handleSignup(e) {
  e.preventDefault()
  try {
    await signup(
      document.getElementById('name').value,
      document.getElementById('email').value,
      document.getElementById('password').value
    )
    alert('Account created! Welcome.')
  } catch(err) {
    alert('Error: ' + err.message)
  }
}
</script>
```

---

## Start the Server

IMPORTANT — on Windows, never use `&` or `&&` to background a server. Use this exact command:
```bash
cmd /c "cd C:/Blopus/output/backend && node server.js"
```

This runs the server in the foreground. It will keep running until stopped.
Tell owner: "Server is running. Open http://localhost:3001/api/health in your browser to confirm."
Do NOT try to run it in background or test it with curl in the same command — just start it and tell owner to open the browser.

Server runs at: `http://localhost:3001`
Frontend (if connected): `http://localhost:3001`
API health check: `http://localhost:3001/api/health`

---

## Rules — follow every time
1. Always save server to `C:/Blopus/output/backend/server.js`
2. Always install dependencies before running
3. Always include signup + login + /api/me routes — minimum auth set
4. Always use bcrypt for passwords — never store plain text
5. Always tell owner to run: `cd C:/Blopus/output/backend && node server.js`
6. If user asked for a website too — connect them: update frontend API URL and serve frontend from backend
7. After starting server tell owner: "Open http://localhost:3001 in browser"
8. For custom app features — add tables and routes AFTER the base auth setup
