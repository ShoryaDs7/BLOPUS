---
name: clinical-notes
description: Help doctors and healthcare workers write clinical notes, fill EHR forms (Epic, Cerner), draft patient follow-up emails, fill insurance/prior auth forms. Uses BrowserAgent to navigate any web-based EHR system.
---

# Clinical Notes Skill

Use this skill when a doctor, nurse, or healthcare worker asks to:
- Write a clinical note (SOAP note, progress note, discharge summary)
- Fill in an EHR form (Epic, Cerner, AthenaHealth, DrChrono, etc.)
- Draft patient follow-up emails
- Fill insurance prior authorization forms
- Summarize a patient case

## SOAP Note Template

When asked to write a clinical note, use this structure unless told otherwise:

```
S — Subjective (what the patient reports)
[Chief complaint, history of present illness, symptoms, duration]

O — Objective (what you measured/observed)
[Vitals: BP, HR, Temp, RR, SpO2]
[Physical exam findings]
[Lab results, imaging]

A — Assessment
[Diagnosis / differential diagnoses]

P — Plan
[Treatment, medications, referrals, follow-up instructions]
```

Ask user to fill in the details for each section, then format the complete note.

## Fill EHR via Browser (Epic, Cerner, etc.)

If the doctor is logged into their EHR in the browser, BrowserAgent can navigate and fill forms:

```
Use the browse_web MCP tool (or BrowserAgent) with task:
"Navigate to [EHR URL], find the clinical note section for patient [NAME/MRN], 
and fill in the following note: [SOAP NOTE TEXT]"
```

BrowserAgent will take screenshots, navigate the EHR UI, and fill the fields.

**Important**: Doctor must already be logged in. Blopus never stores or logs patient data.

## Patient Follow-up Email

Use the email skill for follow-up emails. Standard template:

```
Subject: Follow-up from your visit on [DATE]

Dear [Patient Name],

Thank you for coming in on [DATE]. Following our appointment:

[SUMMARY OF VISIT / KEY POINTS]

[NEXT STEPS / INSTRUCTIONS]

Please call us at [PHONE] if you have any questions.

[DOCTOR NAME]
[PRACTICE NAME]
```

## Insurance / Prior Auth Forms

These are usually web forms. Use BrowserAgent:
```
"Navigate to [insurance portal URL], log in with [credentials from .env], 
find the prior authorization form for patient [NAME], and fill in: 
diagnosis [CODE], medication [NAME], justification [TEXT]"
```

## Rules
1. NEVER store, log, or save patient data to any file — handle in memory only
2. Always confirm clinical details with the doctor before submitting anything
3. For EHR navigation, confirm the EHR system name and URL first
4. HIPAA note: Blopus runs locally on the doctor's own machine — no data leaves their system
