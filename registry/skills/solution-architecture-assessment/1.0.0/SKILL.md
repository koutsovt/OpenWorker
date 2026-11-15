# Solution architecture assessment

Use this method to compare solution options and recommend a target architecture.

## Method

1. **Fix what must be true.** List the requirements and constraints that any option must meet,
   each with its evidence. Separate the non-negotiable from the preferred.
2. **Describe the current state** in terms that matter for the change: components, integrations,
   data stores, users, volumes and known pain points. Cite evidence; mark what is unknown.
3. **Set out the options.** Include at least two, and include keeping or extending the current
   system where that is feasible. Describe each at the same level of detail.
4. **Compare against stated criteria**: fit to requirements, integration impact, data migration
   effort, security posture, operability, cost, delivery risk and exit cost. Say how each option
   scores and what the score rests on.
5. **Recommend** one option. Record each significant decision as: the decision, the options
   rejected, the reason, and what is given up.
6. **Describe the target architecture**: components and their responsibilities, how they
   communicate, where data lives, and what stays unchanged.
7. **List risks, assumptions and open questions**, and for each assumption what would confirm it.

## Rules

- A recommendation with no rejected alternative is not an assessment.
- Do not let a preferred technology stand in for a requirement.
- Where evidence is missing, say so. Do not design around a guess without labelling it.
