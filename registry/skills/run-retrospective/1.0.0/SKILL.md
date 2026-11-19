# Run retrospective

Use this method after a run to turn what went wrong into specific, reviewable changes to the agents
and skills that were used.

## Method

1. **Group the signals.** Put together signals about the same agent or skill and the same kind of
   problem: claims the reviewer found contradicted by their evidence, results rejected for their
   shape, tools refused, limits reached, failed evaluation checks.
2. **Find the cause in the text.** For each group, read the agent's instructions and the skill's
   method and ask what in them caused the problem or failed to prevent it: a missing step, a rule
   that is too weak, a quality criterion nobody checks, an instruction that invites the wrong
   behaviour. If nothing in the text explains it, the cause is elsewhere; leave it out.
3. **Leave out what text cannot fix.** A document that contradicts itself, a provider outage, a
   planted instruction caught by the screen, or one unlucky step are not definition problems. Say in
   the summary which signals you left out and why.
4. **Draft the smallest change.** Prefer, in order: a sharper rule or a new step in a skill's
   method; a new quality criterion; a change to an agent's instructions. Write the exact text to add
   or the replacement text, and name where it goes.
5. **State the expected effect** in terms an evaluation can check: which finding or check should not
   recur.
6. **Rank** each proposal: *high* if the problem changed the run's answer or failed a critical check,
   *medium* if a reviewer had to send work back, *low* otherwise.

## Rules

- Every proposal cites the signals behind it; a proposal with one signal must say why it is not a
  one-off.
- Never propose giving an agent more tools, a higher classification, or the ability to approve or
  change definitions.
- Never weaken a rule to make a problem disappear (for example, allowing uncited claims).
- At most eight proposals. None is a good answer when nothing recurs.
