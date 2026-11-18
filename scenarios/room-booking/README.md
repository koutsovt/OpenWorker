# Scenario: Faculty room booking

A small scenario for trying the platform end to end. **Everything in `knowledge/` is simulated**: the faculty,
volumes, requirements, products and prices were written for this exercise and describe no real system or quote.

One inconsistency is planted on purpose: the options paper says the SaaS product meets every requirement,
while its own vendor notes and the requirements disagree. Independent assurance should catch any result that repeats it.

```bash
node --env-file=/path/to/private.env --disable-warning=ExperimentalWarning src/cli/main.ts orchestrate --scenario scenarios/room-booking
```
