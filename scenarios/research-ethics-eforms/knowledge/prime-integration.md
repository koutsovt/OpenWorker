# Integration: Research Ethics eForms and Salesforce PRIME

_Simulated document for the proof of concept. It describes no real system._

## What PRIME is

Salesforce PRIME is the university's research management system. It holds research projects, grants and contracts. It is being retained and is owned by the Research Systems team.

## Outbound: approvals to PRIME

When an application is approved, eForms sends the approval to PRIME so the project record shows its ethics status. This runs as a nightly batch at 01:00.

The batch is a Power Automate flow that writes a CSV file to an SFTP folder. A scheduled Salesforce job picks the file up at 02:00 and loads it.

Each row carries the ethics application number, the PRIME project id, the approval date, the approval expiry date and the decision outcome.

Records are matched on the PRIME project id. About 4 percent of rows fail to load each month because the project id is missing or mistyped; these are fixed by hand by the Ethics Office.

## Inbound: project lookup from PRIME

When a researcher starts a new application, eForms looks up the project in PRIME through the Salesforce REST API so that the title and chief investigator are filled in. This call uses a single integration user with read access to Project and Contact objects.

## Constraints from the PRIME side

The Research Systems team has stated that the CSV file format and the SFTP pick-up must not change in the first release, because the Salesforce load job is shared with two other systems.

The Research Systems team would accept an API-based replacement for the batch in a later release if it is requested through their change process, which has a lead time of about eight weeks.

## What is not documented

There is no reconciliation report between eForms approvals and PRIME ethics statuses. Nobody can say how many approved applications are currently missing from PRIME.
