---
name: google-meet
description: Use this skill when the user wants to create a Google Meet link, schedule a meeting, end an active meeting, or get meeting space details.
---

# Google Meet Control Guide

## Important scope note
The current token covers `meetings.space.created` — this lets you create and manage meeting spaces your app creates. To access recordings/transcripts/participants, additional scopes are needed (not currently enabled).

## Get Meet service
```python
import sys, os; sys.path.insert(0, os.environ.get("BLOPUS_DIR", os.getcwd()))
from google_auth import get_service
meet = get_service('meet', 'v2')
```

## Create a Meet link (ALWAYS use this — works without Meet API)
```python
import uuid
cal = get_service('calendar', 'v3')

event = {
    'summary': 'Meeting',
    'start': {'dateTime': '2026-04-14T17:00:00+05:30', 'timeZone': 'Asia/Kolkata'},
    'end':   {'dateTime': '2026-04-14T18:00:00+05:30', 'timeZone': 'Asia/Kolkata'},
    'conferenceData': {
        'createRequest': {
            'requestId': str(uuid.uuid4()),
            'conferenceSolutionKey': {'type': 'hangoutsMeet'}
        }
    }
}

result = cal.events().insert(calendarId='primary', body=event, conferenceDataVersion=1).execute()
meet_link = result['conferenceData']['entryPoints'][0]['uri']
print(f"Meet link: {meet_link}")
```

> **NEVER use `meet.spaces().create()`** — it requires the Meet REST API to be enabled in Google Cloud and will 403. The Calendar method above always works.


## Get meeting space details
```python
def get_meeting(space_name: str):
    # space_name: 'spaces/abc-defg-hij' (from create response)
    res = meet.spaces().get(name=space_name).execute()
    return {
        'uri': res['meetingUri'],
        'code': res['meetingCode'],
        'name': res['name'],
        'config': res.get('config', {})
    }
```

## Update meeting space config
```python
def update_meeting(space_name: str, entry_point_access: str = 'ALL'):
    # entry_point_access: 'ALL' (anyone with link) or 'CREATOR_APP_ONLY'
    res = meet.spaces().patch(
        name=space_name,
        updateMask='config.entryPointAccess',
        body={'config': {'entryPointAccess': entry_point_access}}
    ).execute()
    print(f"Meeting updated: {res['meetingUri']}")
```

## End an active conference
```python
def end_meeting(space_name: str):
    meet.spaces().endActiveConference(name=space_name, body={}).execute()
    print(f"Conference in {space_name} ended")
```

## Create a Meet link and add it to a Calendar event
```python
def create_meeting_with_calendar_event(title: str, start_iso: str, end_iso: str, timezone: str = 'Asia/Kolkata'):
    # First create the Meet space
    meeting = create_meeting()
    meet_link = meeting['meetingUri']

    # Then create a calendar event with the link in description
    cal = get_service('calendar', 'v3')
    event = {
        'summary': title,
        'description': f'Join Meet: {meet_link}',
        'start': {'dateTime': start_iso, 'timeZone': timezone},
        'end': {'dateTime': end_iso, 'timeZone': timezone},
        'conferenceData': {
            'entryPoints': [{'entryPointType': 'video', 'uri': meet_link, 'label': 'Google Meet'}]
        }
    }
    result = cal.events().insert(calendarId='primary', body=event).execute()
    print(f"Event created: {result.get('htmlLink')}")
    print(f"Meet link: {meet_link}")
    return {'event': result, 'meet_link': meet_link}
```

## What's NOT possible with current scopes
- Cannot list past meetings or conference records
- Cannot get participant lists
- Cannot access recordings or transcripts
- Cannot access spaces created by other apps

Install: `pip install google-auth google-auth-oauthlib google-auth-httplib2 google-api-python-client`
