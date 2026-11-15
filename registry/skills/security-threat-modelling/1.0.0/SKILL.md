# Security threat modelling

Use this method to produce a threat model for a solution.

## Method

1. **Name the assets**: the data and functions worth protecting, with their classification
   and who is harmed if they are exposed, altered or unavailable. Cite evidence.
2. **Draw the boundaries.** List the components, the actors, and each data flow that crosses
   from one level of trust to another, including integrations and administrative access.
3. **Find the threats.** For each boundary and flow, work through spoofing, tampering,
   repudiation, information disclosure, denial of service and elevation of privilege. Add
   threats specific to the change itself, such as data exposed during migration.
4. **Rate each threat** by likelihood and impact, separately, and say what each rests on.
5. **Map controls.** For each threat, name the controls that prevent, detect or limit it.
   Mark each control as existing (with evidence) or proposed.
6. **State the residual risk** after controls, and any threat that is being accepted.
7. **List what must be confirmed**: controls assumed but not evidenced, and questions for
   the system owners.

## Rules

- A control nobody has confirmed is proposed, however standard it is.
- Treat the migration and the cut-over as part of the system, not as a separate event.
- Do not test, scan or probe anything. This is analysis only.
