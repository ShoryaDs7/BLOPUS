---
name: tasks
description: Use this skill when the user wants to create, list, complete, move, delete, or manage Google Tasks and task lists — synced with Google Calendar.
---

# Google Tasks Control Guide

## Get Tasks service
```python
import sys, os; sys.path.insert(0, os.environ.get("BLOPUS_DIR", os.getcwd()))
from google_auth import get_service
svc = get_service('tasks', 'v1')
```

## List all task lists
```python
def get_task_lists():
    res = svc.tasklists().list().execute()
    return [{'id': tl['id'], 'title': tl['title']} for tl in res.get('items', [])]

for tl in get_task_lists():
    print(f"{tl['title']} — {tl['id']}")
```

## Create a task list
```python
def create_task_list(title: str):
    res = svc.tasklists().insert(body={'title': title}).execute()
    print(f"Task list created: {res['id']}")
    return res
```

## Rename a task list
```python
def rename_task_list(tasklist_id: str, new_title: str):
    svc.tasklists().patch(tasklist=tasklist_id, body={'title': new_title}).execute()
```

## Delete a task list
```python
def delete_task_list(tasklist_id: str):
    svc.tasklists().delete(tasklist=tasklist_id).execute()
    print(f"Task list {tasklist_id} deleted")
```

## List tasks
```python
def get_tasks(tasklist_id: str = '@default', show_completed: bool = False):
    res = svc.tasks().list(tasklist=tasklist_id, showCompleted=show_completed).execute()
    return [{'id': t['id'], 'title': t['title'], 'status': t['status'],
             'notes': t.get('notes', ''), 'due': t.get('due', ''),
             'completed': t.get('completed', '')}
            for t in res.get('items', [])]

for t in get_tasks():
    print(f"[{t['status']}] {t['title']} — due: {t['due']}")
```

## Create a task
```python
def create_task(title: str, notes: str = '', due: str = '', tasklist_id: str = '@default'):
    # due format: '2026-04-15T00:00:00.000Z'
    body = {'title': title}
    if notes: body['notes'] = notes
    if due: body['due'] = due
    res = svc.tasks().insert(tasklist=tasklist_id, body=body).execute()
    print(f"Task created: {res['title']}")
    return res
```

## Update a task (title, notes, due date)
```python
def update_task(task_id: str, title: str = None, notes: str = None, due: str = None, tasklist_id: str = '@default'):
    body = {}
    if title: body['title'] = title
    if notes: body['notes'] = notes
    if due: body['due'] = due
    svc.tasks().patch(tasklist=tasklist_id, task=task_id, body=body).execute()
    print(f"Task {task_id} updated")
```

## Complete a task
```python
def complete_task(task_id: str, tasklist_id: str = '@default'):
    svc.tasks().patch(tasklist=tasklist_id, task=task_id, body={'status': 'completed'}).execute()
    print(f"Task {task_id} marked complete")
```

## Reopen a completed task
```python
def reopen_task(task_id: str, tasklist_id: str = '@default'):
    svc.tasks().patch(tasklist=tasklist_id, task=task_id, body={'status': 'needsAction', 'completed': None}).execute()
```

## Move a task (reorder within list or move to another list)
```python
def move_task(task_id: str, tasklist_id: str = '@default', previous: str = None, parent: str = None):
    # previous: task_id of the task this should come after (for reordering)
    # parent: task_id to nest this as a subtask under
    kwargs = {'tasklist': tasklist_id, 'task': task_id}
    if previous: kwargs['previous'] = previous
    if parent: kwargs['parent'] = parent
    svc.tasks().move(**kwargs).execute()
```

## Delete a task
```python
def delete_task(task_id: str, tasklist_id: str = '@default'):
    svc.tasks().delete(tasklist=tasklist_id, task=task_id).execute()
    print(f"Task {task_id} deleted")
```

## Clear all completed tasks from a list
```python
def clear_completed(tasklist_id: str = '@default'):
    svc.tasks().clear(tasklist=tasklist_id).execute()
    print("All completed tasks cleared")
```

Install: `pip install google-auth google-auth-oauthlib google-auth-httplib2 google-api-python-client`
