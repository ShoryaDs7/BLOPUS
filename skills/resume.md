---
name: resume
description: Use this skill when the user wants to create a professional resume or CV as a PDF, format it properly with sections like experience, education, skills, and projects.
---

# Resume / CV Generator Guide

## Create a Professional Resume PDF

```python
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, HRFlowable, Table, TableStyle

def create_resume(data: dict, filename: str = "resume.pdf"):
    doc = SimpleDocTemplate(filename, pagesize=A4,
                            topMargin=1.5*cm, bottomMargin=1.5*cm,
                            leftMargin=2*cm, rightMargin=2*cm)

    styles = getSampleStyleSheet()
    accent = colors.HexColor("#2563EB")

    name_style = ParagraphStyle("Name", parent=styles["Title"],
                                 fontSize=24, textColor=accent, spaceAfter=4)
    section_style = ParagraphStyle("Section", parent=styles["Heading2"],
                                    fontSize=12, textColor=accent,
                                    spaceBefore=12, spaceAfter=4)
    body_style = styles["Normal"]

    story = []

    # Name + Contact
    story.append(Paragraph(data["name"], name_style))
    contact = " | ".join(filter(None, [
        data.get("email"), data.get("phone"),
        data.get("location"), data.get("linkedin"), data.get("github")
    ]))
    story.append(Paragraph(contact, body_style))
    story.append(HRFlowable(width="100%", thickness=1, color=accent, spaceAfter=8))

    # Summary
    if data.get("summary"):
        story.append(Paragraph("PROFESSIONAL SUMMARY", section_style))
        story.append(Paragraph(data["summary"], body_style))

    # Experience
    if data.get("experience"):
        story.append(Paragraph("EXPERIENCE", section_style))
        for job in data["experience"]:
            story.append(Paragraph(f"<b>{job['title']}</b> — {job['company']}", body_style))
            story.append(Paragraph(f"<i>{job['period']}</i>", body_style))
            for bullet in job.get("bullets", []):
                story.append(Paragraph(f"• {bullet}", body_style))
            story.append(Spacer(1, 6))

    # Education
    if data.get("education"):
        story.append(Paragraph("EDUCATION", section_style))
        for edu in data["education"]:
            story.append(Paragraph(f"<b>{edu['degree']}</b> — {edu['school']}", body_style))
            story.append(Paragraph(f"<i>{edu['year']}</i>", body_style))

    # Skills
    if data.get("skills"):
        story.append(Paragraph("SKILLS", section_style))
        story.append(Paragraph(", ".join(data["skills"]), body_style))

    # Projects
    if data.get("projects"):
        story.append(Paragraph("PROJECTS", section_style))
        for proj in data["projects"]:
            story.append(Paragraph(f"<b>{proj['name']}</b>", body_style))
            story.append(Paragraph(proj["description"], body_style))
            if proj.get("link"):
                story.append(Paragraph(f"Link: {proj['link']}", body_style))
            story.append(Spacer(1, 6))

    doc.build(story)
    print(f"Resume saved: {filename}")

# Example usage — replace with owner's actual data
data = {
    "name": "Your Name",
    "email": "you@example.com",
    "phone": "+1 555 000 0000",
    "location": "Your City",
    "linkedin": "linkedin.com/in/yourhandle",
    "github": "github.com/yourhandle",
    "summary": "Brief professional summary here.",
    "experience": [
        {
            "title": "Your Title",
            "company": "Company Name",
            "period": "2024 — Present",
            "bullets": [
                "Achievement or responsibility 1",
                "Achievement or responsibility 2"
            ]
        }
    ],
    "education": [
        {"degree": "Your Degree", "school": "Your University", "year": "2023"}
    ],
    "skills": ["Skill 1", "Skill 2", "Skill 3"],
    "projects": [
        {
            "name": "Project Name",
            "description": "What it does.",
            "link": "github.com/you/project"
        }
    ]
}

create_resume(data, "resume.pdf")
```

## Quick One-Liner Resume (minimal)
```python
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4

c = canvas.Canvas("simple_resume.pdf", pagesize=A4)
w, h = A4
c.setFont("Helvetica-Bold", 18)
c.drawString(50, h-60, "Your Name")
c.setFont("Helvetica", 11)
c.drawString(50, h-80, "email@example.com | +91 xxxxx | github.com/you")
c.line(50, h-90, w-50, h-90)
# Add more sections manually...
c.save()
```

## Quick Reference

| Section | Key |
|---------|-----|
| Name + contact | Always first |
| Summary | 2-3 lines max |
| Experience | Latest first (reverse chronological) |
| Education | Degree, school, year |
| Skills | Comma-separated list |
| Projects | Name, description, link |

Install: `pip install reportlab`
