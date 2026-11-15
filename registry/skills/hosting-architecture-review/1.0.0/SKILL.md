# Hosting architecture review

Use this method to review how a solution is hosted and run on open-source components.

## Method

1. **State the targets**: availability, recovery time and recovery point, data residency,
   expected load. Cite the requirement behind each; mark any that nobody has stated.
2. **Design by stage.** Describe the local stage first, then the hosted stage. For each: the
   runtime, the database, file storage, background work, secrets, and how a release is deployed.
3. **Keep the stages the same shape.** Use the same container image, the same database engine
   and the same configuration mechanism in both, so moving host is a deployment change only.
4. **Specify operations**: who patches what, how backups are taken and where they are kept,
   how a restore is tested, what is monitored and who is told.
5. **Check the single points of failure** and say which are accepted at this stage and why.
6. **Estimate cost** per month for each stage. List each line, its source, and the usage
   assumption behind it. Give a range where the assumption is uncertain.
7. **Assess exit**: what is specific to the host, and what it would take to move.

## Rules

- Prefer open-source components. Name any dependence on a proprietary service and its substitute.
- A managed host is a commercial service even when everything on it is open source; say so.
- A backup that has not been restored is an assumption. Record it as one.
