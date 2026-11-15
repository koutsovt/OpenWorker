# Integration architecture

Use this method to design the interfaces between a solution and the systems it must work with.

## Method

1. **Inventory the existing interfaces.** For each: source, destination, trigger, data carried,
   format, frequency, volume, and who owns each end. Cite evidence. Mark anything undocumented.
2. **Decide the fate of each**: kept as is, re-implemented on the new side, changed, or retired.
   A retained system should see as little change as possible; say exactly what it would see.
3. **Choose a pattern per interface**: scheduled batch, API call, event or file exchange. Prefer the
   pattern the retained system already supports. Give the reason.
4. **Define the contract**: the fields, their meaning, identifiers used to match records on both
   sides, and which side is the system of record for each.
5. **Design for failure**: what is retried and how often, how a repeated message is made
   harmless, where failed messages go, and how the two sides are reconciled.
6. **Plan the cut-over**: how the interface moves from the old source to the new without a gap
   or a duplicate, and how to fall back.
7. **List the dependencies on other teams** and the open questions for the owners of each system.

## Rules

- Do not assume a retained system can change. Treat any change to it as a dependency to confirm.
- Every interface needs an owner and a reconciliation check, or it is not finished.
