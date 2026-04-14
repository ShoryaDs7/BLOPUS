---
name: contacts
description: Use this skill when the user wants to list, search, create, update, delete, or organize Google Contacts and contact groups.
---

# Google Contacts Control Guide

## Get People service
```python
import sys; sys.path.insert(0, 'C:/Blopus')
from google_auth import get_service
people = get_service('people', 'v1')
```

## List all contacts
```python
def list_contacts(max_results: int = 50):
    res = people.people().connections().list(
        resourceName='people/me', pageSize=max_results,
        personFields='names,emailAddresses,phoneNumbers,organizations,birthdays'
    ).execute()
    contacts = []
    for p in res.get('connections', []):
        contacts.append({
            'resourceName': p['resourceName'],
            'name': p.get('names', [{}])[0].get('displayName', ''),
            'email': p.get('emailAddresses', [{}])[0].get('value', ''),
            'phone': p.get('phoneNumbers', [{}])[0].get('value', ''),
            'org': p.get('organizations', [{}])[0].get('name', ''),
        })
    return contacts

for c in list_contacts():
    print(f"{c['name']} — {c['email']} — {c['phone']}")
```

## Search contacts
```python
def search_contacts(query: str):
    res = people.people().searchContacts(
        query=query,
        readMask='names,emailAddresses,phoneNumbers,organizations'
    ).execute()
    return [{'resourceName': r['person']['resourceName'],
             'name': r['person'].get('names', [{}])[0].get('displayName', ''),
             'email': r['person'].get('emailAddresses', [{}])[0].get('value', '')}
            for r in res.get('results', [])]
```

## Get a single contact
```python
def get_contact(resource_name: str):
    # resource_name: 'people/c1234567890'
    return people.people().get(
        resourceName=resource_name,
        personFields='names,emailAddresses,phoneNumbers,organizations,birthdays,addresses,biographies'
    ).execute()
```

## Create a contact
```python
def create_contact(name: str, email: str = '', phone: str = '', org: str = '', notes: str = ''):
    body = {'names': [{'givenName': name}]}
    if email: body['emailAddresses'] = [{'value': email}]
    if phone: body['phoneNumbers'] = [{'value': phone}]
    if org: body['organizations'] = [{'name': org}]
    if notes: body['biographies'] = [{'value': notes}]
    res = people.people().createContact(body=body).execute()
    print(f"Contact created: {res['resourceName']}")
    return res
```

## Batch create contacts
```python
def batch_create_contacts(contacts: list):
    # contacts = [{'name': ..., 'email': ..., 'phone': ...}, ...]
    bodies = [{'contactPerson': {'names': [{'givenName': c['name']}],
               'emailAddresses': [{'value': c.get('email', '')}]}} for c in contacts]
    res = people.people().batchCreateContacts(body={'contacts': bodies}).execute()
    print(f"Created {len(res.get('createdPeople', []))} contacts")
```

## Update a contact
```python
def update_contact(resource_name: str, name: str = None, email: str = None, phone: str = None):
    person = people.people().get(resourceName=resource_name,
                                  personFields='names,emailAddresses,phoneNumbers').execute()
    etag = person['etag']
    fields = []
    if name:
        person['names'] = [{'givenName': name}]; fields.append('names')
    if email:
        person['emailAddresses'] = [{'value': email}]; fields.append('emailAddresses')
    if phone:
        person['phoneNumbers'] = [{'value': phone}]; fields.append('phoneNumbers')
    people.people().updateContact(
        resourceName=resource_name,
        updatePersonFields=','.join(fields),
        body={**person, 'etag': etag}
    ).execute()
    print(f"Contact {resource_name} updated")
```

## Delete a contact
```python
def delete_contact(resource_name: str):
    people.people().deleteContact(resourceName=resource_name).execute()
    print(f"Contact {resource_name} deleted")
```

## Batch delete contacts
```python
def batch_delete_contacts(resource_names: list):
    people.people().batchDeleteContacts(body={'resourceNames': resource_names}).execute()
    print(f"Deleted {len(resource_names)} contacts")
```

## List contact groups (labels)
```python
def list_contact_groups():
    res = people.contactGroups().list().execute()
    return [{'id': g['resourceName'], 'name': g['name'], 'count': g.get('memberCount', 0)}
            for g in res.get('contactGroups', [])]
```

## Create a contact group
```python
def create_contact_group(name: str):
    res = people.contactGroups().create(body={'contactGroup': {'name': name}}).execute()
    print(f"Group created: {res['resourceName']}")
    return res
```

## Add contacts to a group
```python
def add_to_group(group_resource_name: str, contact_resource_names: list):
    people.contactGroups().members().modify(
        resourceName=group_resource_name,
        body={'resourceNamesToAdd': contact_resource_names}
    ).execute()
```

## Remove contacts from a group
```python
def remove_from_group(group_resource_name: str, contact_resource_names: list):
    people.contactGroups().members().modify(
        resourceName=group_resource_name,
        body={'resourceNamesToRemove': contact_resource_names}
    ).execute()
```

## Copy "other contact" (auto-created) to your contacts
```python
def save_other_contact(resource_name: str):
    # resource_name from otherContacts().list()
    res = people.otherContacts().copyOtherContactToMyContactsGroup(
        resourceName=resource_name,
        body={'copyMask': 'names,emailAddresses,phoneNumbers'}
    ).execute()
    print(f"Saved to contacts: {res['resourceName']}")
```

Install: `pip install google-auth google-auth-oauthlib google-auth-httplib2 google-api-python-client`
