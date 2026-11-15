# Requirements for the replacement system

_Simulated document for the proof of concept. Requirements were written for this exercise._

## Functional

REQ-01. The system must support the four existing forms: new application, amendment, annual progress report and adverse event report.

REQ-02. The system must preserve the existing application states and allow the Ethics Office to change the workflow without a code release.

REQ-03. Approved applications must continue to reach Salesforce PRIME. In the first release the existing CSV file and SFTP pick-up must be kept unchanged.

REQ-04. All existing applications, reviews, decisions and attachments must be migrated, and each migrated application must remain traceable to its original application number.

REQ-05. The system must produce approval letters from templates the Ethics Office can edit.

## Non-functional

REQ-06. Researchers and staff must sign in with the university's Microsoft Entra ID through OpenID Connect. External committee members must be able to sign in without a university account.

REQ-07. The system must be available 99.5 percent of the time during business hours. Planned maintenance outside business hours is acceptable.

REQ-08. After a failure, the system must be restored within 8 hours with no more than 1 hour of data loss.

REQ-09. Data must be stored in Australia.

REQ-10. Every change to an application, review or decision must be recorded with who made it and when, and that history must be kept for the life of the record.

REQ-11. The solution must use open-source components and must be able to run on a developer's machine and on a managed host without redesign.

REQ-12. Records must be retained in line with the retention rules for ethics records.

## Constraints

The internal team is two developers with PHP and Laravel experience and no Power Platform experience.

There is no budget for a cut-over that keeps both systems live for more than four weeks.
