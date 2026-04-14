---
name: database
description: Use this skill when the user wants to store data locally, query data, create tables, insert/update/delete records, or work with SQLite databases. Also covers basic SQL operations.
---

# Local Database Guide (SQLite)

## Quick Start

```python
import sqlite3

conn = sqlite3.connect("data.db")
cursor = conn.cursor()

cursor.execute("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)")
cursor.execute("INSERT INTO users (name, email) VALUES (?, ?)", ("Alice", "alice@example.com"))
conn.commit()

cursor.execute("SELECT * FROM users")
print(cursor.fetchall())
conn.close()
```

## Common Tasks

### Create Database and Tables
```python
import sqlite3

def init_db(db_path: str = "app.db"):
    conn = sqlite3.connect(db_path)
    c = conn.cursor()

    c.execute("""CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE,
        phone TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )""")

    c.execute("""CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id INTEGER,
        content TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (contact_id) REFERENCES contacts(id)
    )""")

    conn.commit()
    conn.close()
    print(f"Database initialized: {db_path}")

init_db()
```

### Insert Data
```python
import sqlite3

def add_contact(name: str, email: str, phone: str = None):
    conn = sqlite3.connect("app.db")
    c = conn.cursor()
    try:
        c.execute("INSERT INTO contacts (name, email, phone) VALUES (?, ?, ?)",
                  (name, email, phone))
        conn.commit()
        print(f"Added: {name}")
        return c.lastrowid
    except sqlite3.IntegrityError:
        print(f"Email already exists: {email}")
        return None
    finally:
        conn.close()
```

### Query Data
```python
import sqlite3

def get_all_contacts():
    conn = sqlite3.connect("app.db")
    conn.row_factory = sqlite3.Row  # Returns dict-like rows
    c = conn.cursor()
    c.execute("SELECT * FROM contacts ORDER BY name")
    rows = c.fetchall()
    conn.close()
    return [dict(row) for row in rows]

def search_contacts(query: str):
    conn = sqlite3.connect("app.db")
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("SELECT * FROM contacts WHERE name LIKE ? OR email LIKE ?",
              (f"%{query}%", f"%{query}%"))
    rows = c.fetchall()
    conn.close()
    return [dict(row) for row in rows]
```

### Update and Delete
```python
import sqlite3

def update_contact(contact_id: int, name: str = None, phone: str = None):
    conn = sqlite3.connect("app.db")
    c = conn.cursor()
    if name:
        c.execute("UPDATE contacts SET name = ? WHERE id = ?", (name, contact_id))
    if phone:
        c.execute("UPDATE contacts SET phone = ? WHERE id = ?", (phone, contact_id))
    conn.commit()
    conn.close()

def delete_contact(contact_id: int):
    conn = sqlite3.connect("app.db")
    c = conn.cursor()
    c.execute("DELETE FROM contacts WHERE id = ?", (contact_id,))
    conn.commit()
    conn.close()
```

### Export Database to CSV
```python
import sqlite3, csv

def export_to_csv(table: str, output_file: str, db_path: str = "app.db"):
    conn = sqlite3.connect(db_path)
    c = conn.cursor()
    c.execute(f"SELECT * FROM {table}")
    rows = c.fetchall()
    headers = [desc[0] for desc in c.description]
    conn.close()

    with open(output_file, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        writer.writerows(rows)
    print(f"Exported {len(rows)} rows to {output_file}")

export_to_csv("contacts", "contacts.csv")
```

### Use with pandas
```python
import sqlite3, pandas as pd

# Query to DataFrame
conn = sqlite3.connect("app.db")
df = pd.read_sql_query("SELECT * FROM contacts", conn)
conn.close()
print(df.head())

# Write DataFrame to SQLite
df.to_sql("contacts_backup", conn, if_exists="replace", index=False)
```

### Key-Value Store (simple cache/settings)
```python
import sqlite3, json

class KVStore:
    def __init__(self, db_path: str = "kv.db"):
        self.db = db_path
        conn = sqlite3.connect(self.db)
        conn.execute("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)")
        conn.commit()
        conn.close()

    def set(self, key: str, value):
        conn = sqlite3.connect(self.db)
        conn.execute("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)",
                     (key, json.dumps(value)))
        conn.commit()
        conn.close()

    def get(self, key: str, default=None):
        conn = sqlite3.connect(self.db)
        row = conn.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
        conn.close()
        return json.loads(row[0]) if row else default

    def delete(self, key: str):
        conn = sqlite3.connect(self.db)
        conn.execute("DELETE FROM kv WHERE key = ?", (key,))
        conn.commit()
        conn.close()

# Usage
store = KVStore()
store.set("last_run", "2026-04-08")
store.set("settings", {"theme": "dark", "notifications": True})
print(store.get("last_run"))
print(store.get("settings"))
```

## Quick Reference

| Operation | SQL |
|-----------|-----|
| Create table | `CREATE TABLE IF NOT EXISTS` |
| Insert | `INSERT INTO table (cols) VALUES (?)` |
| Select all | `SELECT * FROM table` |
| Filter | `SELECT * FROM table WHERE col = ?` |
| Update | `UPDATE table SET col = ? WHERE id = ?` |
| Delete | `DELETE FROM table WHERE id = ?` |
| Count | `SELECT COUNT(*) FROM table` |

No install needed — SQLite is built into Python.
