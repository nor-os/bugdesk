# `/backlog refine` — the refinement pass

Refinement is the one operation in the backlog that has a **definition**, not
just a convention. Everything else is judgment; this is a gate.

```
/backlog refine                 refine the draft items that are ready to be refined
/backlog refine <ref>           refine one item
/backlog refine <epic>          refine the epic and everything under it
/backlog refine phase <name>    refine every draft in a phase
```

**Tasks are not refined.** A task has no `refined` state at all — it inherits
its parent story's acceptance criteria and goes `draft → in-progress → done`.
If you catch yourself writing criteria and an estimate for a task, what you
have is a story: change its type and refine it as one.

An item is **refined** when someone has answered three questions about it:

1. **What does done look like?** → acceptance criteria
2. **How big is it?** → an estimate
3. **What does it belong to?** → a parent

Until all three are answered, nobody can pick the item up without first
re-deriving the answers themselves, which is the actual cost of an unrefined
backlog: not that it's untidy, but that every item is re-thought by whoever
touches it next.

## The checks

These five are enforced identically by the BugDesk UI (`REFINEMENT_RULES` in
`ui/js/ticketdesk/backlog_data.js`) and by you. **They must agree** — an agent
that marks something refined which the UI still lists as incomplete is worse
than no check at all, because now the two disagree in front of the user.

| # | Check | Fails when |
|---|---|---|
| 1 | Has a title that names the outcome | title is under 8 characters |
| 2 | Has a description | description is empty, or still the `_(no description provided)_` placeholder |
| 3 | Has at least one acceptance criterion | `## Acceptance criteria` is empty or still `_(not refined yet)_` |
| 4 | Has an estimate | `points:` is empty |
| 5 | Sits under a parent | `parent:` is empty — **epics are exempt** |

If any check fails, the item stays `draft`. Say which check failed and what you
need in order to pass it; don't quietly promote it anyway, and don't invent an
estimate to satisfy check 4.

## Writing acceptance criteria

This is the part that actually takes thought. The rest is bookkeeping.

**One observable outcome per line, written from outside the system.**

```markdown
## Acceptance criteria

- [ ] An unauthenticated user hitting /app is redirected to the IdP
- [ ] A successful callback creates a session and lands on the page they asked for
- [ ] Revoking the grant at the IdP logs the user out within 60s
```

Not:

```markdown
- [ ] Add an OIDC client            ← a task, not an outcome
- [ ] Auth works                    ← unfalsifiable
- [ ] Refactor SessionManager       ← an implementation detail
- [ ] Fast                          ← no threshold, so nobody can ever tick it
```

Tests to apply to each line:

- **Could someone who didn't build it check this?** If only the author can tell,
  it's an implementation note.
- **Is there a number where there should be one?** "within 60s", "under 200ms",
  "for up to 10k rows". A performance criterion without a threshold cannot be
  met or missed.
- **What happens when it goes wrong?** The unhappy path is where the
  disagreement always turns out to be. At least one criterion should cover it.
- **Is this the story's job?** If a criterion belongs to a sibling story, move
  it there — that is a refinement outcome too.

Three to seven criteria is the usual range. One is suspicious. More than about
eight usually means the item is really two items, and **splitting it is the
right refinement result** — file the second story, parent it the same way, and
say so in a comment on the original.

## Estimating

`points:` is free text; use whatever the project already uses (look at the
other items before inventing a scale). What matters:

- Estimate the **whole** item, including review and the unhappy paths.
- If you can't estimate it, that is a finding, not a failure: the item needs
  splitting or a spike. Say so, leave it `draft`, and write the reason in a
  comment.
- Don't re-estimate an item that is already `in-progress` to make a number look
  better. The original estimate is the record of what was believed at the time.

## Parenting

An unparented story is the single most common thing refinement fixes, and the
most consequential — it's why work disappears from a phase report.

- Story → its epic. Task → its story (or an epic directly, if a task genuinely
  needs no story around it).
- If nothing fits, the missing thing is usually an epic. Propose it; don't
  force the story under the nearest epic that half-matches.
- Never set `phase:` on a story or task to compensate for a missing parent. The
  phase is inherited, and a hand-copied one drifts.

## The pass, end to end

For each item you're refining:

1. **Read it,** and read its siblings under the same parent. Most refinement
   problems are visible only in context: two stories that overlap, a criterion
   that belongs next door, an epic that's really a phase.
2. **Run the five checks.** Note which fail.
3. **Fill the gaps you can fill** from the description, the linked bugs, and
   the code. Write the criteria first — they usually change the estimate.
4. **Ask about the gaps you can't.** An estimate you invented and a criterion
   you guessed are worse than a `draft` that says what it's waiting on.
5. **Split if it wants to split.** Write the new item, parent it, refine it too.
6. **Set `status: refined`** only when all five checks pass, bump `updated`,
   and **leave a comment** recording what you did:

   ```markdown
   ### 2026-09-10 · agent

   Refined: 3 acceptance criteria (added the revoke case, which the description
   didn't mention), 5 points, parented to EPIC-0001. Split out STORY-0009 for
   the admin-side revocation UI — it needs a different reviewer.
   ```

   That comment is the record of a decision. "Refined." on its own is not.

7. **Report back** in one block: what you refined, what you split, and what is
   still `draft` and why. The last list is the useful one — it is the agenda
   for the next conversation with the human.

## When NOT to refine

- **An item nobody plans to build.** Refining the whole backlog is busywork;
  refine the next phase. `/backlog refine phase <name>` exists for this.
- **An item already past `refined`.** Editing criteria on something
  `in-progress` moves the goalposts mid-flight. If the criteria are genuinely
  wrong, say so in a comment and get agreement before changing them.
- **An epic, beyond checks 1, 2 and 4.** An epic's acceptance criteria are its
  stories. Give it a description worth reading and a phase, and refine the
  stories underneath.
- **A task, at all.** It has no `refined` state; the bridge rejects the
  transition. See the note at the top.
