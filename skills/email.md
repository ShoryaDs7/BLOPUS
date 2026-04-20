---
name: email
description: Use this skill when the user wants to read their inbox, summarize unread emails, send emails AS the owner from their real Gmail, reply to email threads, search emails, or do anything with email. Uses Gmail API — sends from the owner's real Gmail address.
---

# Gmail Control Guide

## Setup check — always do this first
```python
import os, json

creds_path = os.path.join(os.environ.get("BLOPUS_DIR", os.getcwd()), "creators", os.environ.get("OWNER_HANDLE", ""), "gmail_credentials.json")
token_path  = os.path.join(os.environ.get("BLOPUS_DIR", os.getcwd()), "creators", os.environ.get("OWNER_HANDLE", ""), "gmail_token.json")

if not os.path.exists(creds_path):
    print("""
Gmail is not set up yet.

To enable Gmail control (one-time setup):
1. Go to console.cloud.google.com
2. Create a project → Enable "Gmail API"
3. Go to "Credentials" → Create OAuth 2.0 Client ID → Desktop App
4. Download the JSON file → rename to gmail_credentials.json
5. Place it in your creators/{username}/ folder
6. Then ask me to "setup gmail" and I'll handle the OAuth login

That's it — after that I can read and send emails as you forever.
""")
    exit()
```

## Get Gmail service (auto-refreshing token — never expires)
```python
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
import pickle, os

SCOPES = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/tasks',
    'https://www.googleapis.com/auth/contacts',
    'https://www.googleapis.com/auth/youtube',
    'https://www.googleapis.com/auth/presentations',
    'https://www.googleapis.com/auth/meetings.space.created',
]

BLOPUS_DIR   = os.environ.get("BLOPUS_DIR", os.getcwd())
OWNER_HANDLE = os.environ.get("OWNER_HANDLE", "")
CREATOR_DIR  = os.path.join(BLOPUS_DIR, "creators", OWNER_HANDLE)
CREDS_FILE   = os.path.join(CREATOR_DIR, "gmail_credentials.json")
TOKEN_FILE   = os.path.join(CREATOR_DIR, "gmail_token.pickle")

def get_google_service(api: str, version: str):
    creds = None
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE, 'rb') as f:
            creds = pickle.load(f)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(CREDS_FILE, SCOPES)
            creds = flow.run_local_server(port=0)
        with open(TOKEN_FILE, 'wb') as f:
            pickle.dump(creds, f)
    return build(api, version, credentials=creds)

# Usage:
def get_gmail_service():    return get_google_service('gmail', 'v1')
def get_calendar_service(): return get_google_service('calendar', 'v3')
def get_sheets_service():   return get_google_service('sheets', 'v4')
def get_drive_service():    return get_google_service('drive', 'v3')
def get_docs_service():     return get_google_service('docs', 'v1')
```

## Read Unread Emails + Summary
```python
import base64

def get_unread_emails(max_results: int = 10) -> list:
    service = get_gmail_service()
    result = service.users().messages().list(
        userId='me', labelIds=['INBOX', 'UNREAD'], maxResults=max_results
    ).execute()

    messages = result.get('messages', [])
    emails = []
    for msg in messages:
        m = service.users().messages().get(userId='me', id=msg['id'], format='full').execute()
        headers = {h['name']: h['value'] for h in m['payload']['headers']}
        body = ""
        if 'parts' in m['payload']:
            for part in m['payload']['parts']:
                if part['mimeType'] == 'text/plain':
                    body = base64.urlsafe_b64decode(part['body']['data']).decode('utf-8', errors='ignore')
                    break
        elif m['payload'].get('body', {}).get('data'):
            body = base64.urlsafe_b64decode(m['payload']['body']['data']).decode('utf-8', errors='ignore')
        emails.append({
            'id': msg['id'],
            'threadId': m['threadId'],
            'from': headers.get('From', ''),
            'subject': headers.get('Subject', ''),
            'date': headers.get('Date', ''),
            'body': body[:500]
        })
    return emails

emails = get_unread_emails(10)
for e in emails:
    print(f"From: {e['from']}\nSubject: {e['subject']}\nDate: {e['date']}\nPreview: {e['body'][:150]}\n---")
```

## Send Email AS the Owner
```python
import base64
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

def send_email(to: str, subject: str, body: str):
    service = get_gmail_service()
    msg = MIMEText(body)
    msg['to'] = to
    msg['subject'] = subject
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    service.users().messages().send(userId='me', body={'raw': raw}).execute()
    print(f"Email sent to {to}")
```

## Reply to an Email Thread
```python
def reply_to_email(message_id: str, thread_id: str, to: str, body: str, subject: str):
    service = get_gmail_service()
    msg = MIMEText(body)
    msg['to'] = to
    msg['subject'] = f"Re: {subject}"
    msg['In-Reply-To'] = message_id
    msg['References'] = message_id
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    service.users().messages().send(userId='me', body={'raw': raw, 'threadId': thread_id}).execute()
    print(f"Replied to thread {thread_id}")
```

## Search Emails
```python
def search_emails(query: str, max_results: int = 5) -> list:
    service = get_gmail_service()
    result = service.users().messages().list(userId='me', q=query, maxResults=max_results).execute()
    return result.get('messages', [])

# Examples:
# search_emails("from:investor@example.com")
# search_emails("subject:invoice")
# search_emails("is:unread after:2026/01/01")
```

## Mark Email as Read
```python
def mark_as_read(message_id: str):
    service = get_gmail_service()
    service.users().messages().modify(userId='me', id=message_id, body={'removeLabelIds': ['UNREAD']}).execute()
```

## What this skill can do
- Read inbox + summarize unread ✅
- Send email AS the owner from their real Gmail ✅
- Reply to threads ✅
- Search emails ✅
- Mark as read ✅
- Access Calendar, Sheets, Drive, Docs via same token ✅

Install: `pip install google-auth google-auth-oauthlib google-auth-httplib2 google-api-python-client`

## One-time setup
Owner must place `gmail_credentials.json` in their creators/{username}/ folder.
First time bot uses Google → browser opens once → sign in → token saved forever, auto-refreshes.
