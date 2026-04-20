"""
google_auth.py — shared Google auth helper for all Blopus skills.
Uses gmail_credentials.json + auto-refreshing token file. Never expires.

Usage:
    import sys; sys.path.insert(0, os.environ.get('BLOPUS_DIR', '.'))
    from google_auth import get_service
    gmail    = get_service('gmail', 'v1')
    calendar = get_service('calendar', 'v3')
    sheets   = get_service('sheets', 'v4')
    drive    = get_service('drive', 'v3')
    docs     = get_service('docs', 'v1')
"""
import os, pickle
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

SCOPES = [
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/tasks',
    'https://www.googleapis.com/auth/contacts',
    'https://www.googleapis.com/auth/youtube',
    'https://www.googleapis.com/auth/youtube.force-ssl',
    'https://www.googleapis.com/auth/yt-analytics.readonly',
    'https://www.googleapis.com/auth/yt-analytics-monetary.readonly',
    'https://www.googleapis.com/auth/presentations',
    'https://www.googleapis.com/auth/meetings.space.created',
]

BLOPUS_DIR   = os.environ.get("BLOPUS_DIR", os.path.dirname(os.path.abspath(__file__)))
OWNER_HANDLE = os.environ.get("OWNER_HANDLE", "")
CREATOR_DIR  = os.path.join(BLOPUS_DIR, "creators", OWNER_HANDLE)
CREDS_FILE   = os.path.join(CREATOR_DIR, "gmail_credentials.json")
TOKEN_FILE   = os.path.join(CREATOR_DIR, "gmail_token.pickle")

def get_credentials():
    if not os.path.exists(CREDS_FILE):
        raise RuntimeError(
            f"gmail_credentials.json not found in {CREATOR_DIR}\n"
            "Place it there and try again."
        )
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
    return creds

def get_service(api: str, version: str):
    return build(api, version, credentials=get_credentials())
