# Indicative hosting and licence costs

_Simulated document for the proof of concept. These figures were invented for this exercise. They are not quotes and are not real prices; do not use them outside it._

## Current costs

Power Apps licensing for eForms cost about AUD 138,000 in the last financial year. The figure varies with how many researchers open the application each month.

Dataverse storage beyond the included allowance cost about AUD 21,000 in the last financial year, driven by attachments.

Partner support is retained at AUD 30,000 per year.

## Local stage

Running the replacement locally uses Docker with PostgreSQL and has no hosting cost. It is suitable for development and demonstration only and must not hold real application data.

## Railway stage

For this exercise, assume Railway charges by usage: AUD 15 per vCPU per month and AUD 15 per GB of memory per month for running services, AUD 0.25 per GB per month for volume storage, and AUD 0.08 per GB of outbound traffic.

A sizing used for similar internal applications is one web service at 2 vCPU and 4 GB, one queue worker at 1 vCPU and 2 GB, and one PostgreSQL service at 2 vCPU and 8 GB.

Attachment storage on a volume is not recommended above 50 GB in the sizing guide; object storage is suggested instead, at an assumed AUD 0.04 per GB per month.

## Region

For this exercise, assume the managed host offers regions in the United States, Europe and Singapore, and does not offer an Australian region.

## One-off costs

No estimate exists for the migration effort. A previous, unrelated Dataverse migration of similar size took two developers about ten weeks.
