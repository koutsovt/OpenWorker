# Data profile: Research Ethics eForms

_Simulated document for the proof of concept. It describes no real system._

## Tables

The Dataverse solution has 31 custom tables. The main ones are Application, Applicant, Project, Review, Decision, Amendment, Progress Report, Adverse Event and Attachment.

## Volumes

As at the last count there were about 18,500 application records, 41,000 review records and 96,000 attachments. About 1,200 new applications are lodged each year.

Attachments total about 210 GB and are held in Dataverse file storage. The largest single attachment is 480 MB.

## Sensitive data

Applications can contain personal information about researchers and, in adverse event reports, health information about research participants. The data is classified as confidential under the university's information classification.

## Retention

Ethics records must be kept for at least 15 years after the project ends. Records for clinical research involving children must be kept until the participant turns 25 or for 15 years, whichever is longer.

## Data quality

About 7 percent of application records created before 2021 have no linked Project record because the Project table was added later.

Applicant records are duplicated where a researcher has changed department: an estimated 300 researchers have more than one Applicant record.

Choice columns were renamed twice. Historic records hold values that no longer appear in the current choice lists.

## Audit history

Dataverse auditing is enabled for the Application and Decision tables only. Audit history is retained for 3 years.
