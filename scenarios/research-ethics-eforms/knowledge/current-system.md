# Current system: Research Ethics eForms on Power Apps

_Simulated document for the proof of concept. It describes no real system._

## Purpose

Research Ethics eForms is the system researchers use to apply for human research ethics approval and that the Ethics Office uses to review, decide and record those applications.

## Platform

The system is a model-driven Power Apps application backed by Dataverse. It was built in 2019 by an external partner and has been maintained by one internal developer since 2022.

There are three environments: development, test and production. Releases are moved between them by hand as managed solutions.

## Users

About 2,400 researchers have lodged at least one application. The Ethics Office has 9 staff who process applications. Around 60 committee members review applications each year.

Researchers and staff sign in with the university's Microsoft Entra ID accounts. External committee members are invited as guest accounts.

## Forms and workflow

There are four application forms: new application, amendment, annual progress report and adverse event report. The new application form has 14 sections and up to 180 fields depending on answers given.

An application moves through these states: draft, submitted, in review, more information requested, approved, rejected, withdrawn. State changes are driven by 23 Power Automate flows.

Approval letters are generated from Word templates and stored as file attachments on the application record.

## Known problems

Staff report that the new application form takes more than 20 seconds to open for applications with many attachments.

Six of the 23 Power Automate flows have no documentation and their original author has left.

Licensing is per user per month and is charged for every researcher account that opens the application in a month, which makes cost hard to predict.

Reporting is done by exporting to Excel. There is no reporting database.

## What is not known

There is no current record of which Dataverse columns are in active use. A 2023 review estimated that about a third of custom columns are no longer populated, but this was not verified.
