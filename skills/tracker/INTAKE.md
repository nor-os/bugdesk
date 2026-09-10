# Intake — updating the tracker from minutes, email and chat

`/tracker intake <source>` turns something somebody wrote — meeting minutes, an
email thread, a chat export, standup notes, a call transcript — into edits on
the tracker.

This is the operation the tracker exists for, and it is the one that can do the
most damage. Everything else in the store was put there deliberately. An intake
pass writes a lot of records at once, from prose, about people who are not here
to correct you — and the user will read the result as if somebody had reported
it. **A tracker that quietly invents progress is worse than no tracker**: it
replaces "I do not know where this stands" with a confident wrong answer, and
the user stops chasing.

So the whole procedure is built to keep the line between *what the source says*
and *what you concluded* visible in the file afterwards.

## The pass

### 1. Date the source

Find when it was written — the meeting date, the email's `Date:`, the chat
timestamp. Everything downstream depends on it: a relative date ("end of next
week") means nothing without it, and a comment dated today about a call from
three weeks ago misrepresents when you learned something.

If the source has no date, **ask** rather than assuming today.

### 2. Extract statements, not impressions

Go through the source and pull out only sentences that assert something about
tracked work. Each one should survive being quoted. There are four kinds worth
having:

| kind | example |
|---|---|
| **status** | "reconciliation passed, we're waiting on the controller" |
| **commitment** | "I'll have it to you by the 20th" |
| **ownership** | "Sam is picking up the operations feed" |
| **new work** | "we also need the DPA re-signed" |

Discard everything else. Opinions, plans nobody owned, and "we should probably"
are not tracker entries. A discussion about whether to do something is not a
commitment to do it.

### 3. Match each statement to an item

For each statement, find the item it is about. Be explicit with yourself about
which of these you have:

- **Certain** — the source names the reference (`STORY-0007`), or names the
  work unambiguously and there is exactly one open item that matches.
- **Likely** — one open item plausibly matches, on the same project, with the
  same assignee. Propose it and **say it is a guess**.
- **No match** — nothing in the store covers it. This is new work, or work
  tracked somewhere else. Propose creating it; do not force it onto the nearest
  existing record.

Never merge two statements onto one item because they are near each other in
the source, and never split one statement across two items to make both look
updated.

### 4. Propose the changeset before writing it

Show the user the whole set first, grouped by item, with the quote that drives
each edit and your confidence:

```
STORY-0007  Finance feed cutover            (certain — named in the minutes)
  status    in-progress                     (unchanged)
  due       2026-09-05 → 2026-09-19         "controller is back on the 18th, sign-off the day after"
  comment   + provenance note

TASK-0031   Send the DPA to legal           (NEW — "we also need the DPA re-signed")
  assignee  priya
  due       (none given)

STORY-0004  Operations feed cutover         (likely — not named; Sam's only open item)
  assignee  → sam                           "Sam is picking up the operations feed"
```

Apply after the user confirms. For a long source, walk the groups in order
rather than presenting forty edits at once.

### 5. Write, with provenance

Every item you touch gets **one comment** recording where the change came from,
authored as the agent name from step 0 and dated the **source's** date:

```markdown
### 2026-09-09 · norman_agent

From the 2026-09-09 vendor sync — Priya: "reconciliation passed, waiting on the
controller for sign-off." Moved the target from the 5th to the 19th on her
comment that the controller is back on the 18th.
```

The rules for that comment:

- **Quote the source** for the part that is a claim about the work. A paraphrase
  is your reading; a quote is what was said, and six weeks later the difference
  matters.
- **Name the source and its date** in the first line, so anybody reading the
  thread can go back to it.
- **Say what you changed and why**, especially a date move.
- **Say what you could not resolve**: "no new date given", "unclear whether this
  covers the analytics feed too".
- One comment per item per pass. Not one per statement — a thread of six
  fragments from the same meeting is unreadable.

Then bump `updated` on every file you touched.

## Rules

**Only record what the source says.** If nobody said the work was done, it is
not done. The temptation is a sentence like "the migration went well" — that is
not "STORY-0007 is done", it is a comment recording that somebody said the
migration went well.

**Dates only when a date was given.** Resolve a relative one against the
source's date and *show your arithmetic in the comment* ("'end of next week',
from the 9th → 2026-09-18"). If the resolution is ambiguous — "next Friday"
from a Friday — ask. Never round a vague commitment ("soon", "after the
holidays") into a date; leave `due` empty and record the phrase in the comment.

**A missed date with no replacement stays missed.** If somebody was due on the
5th, did not deliver, and gave no new date, leave `due: 2026-09-05`. It reads
as overdue because it is. Moving it forward to "keep the tracker tidy" deletes
the fact the user needs.

**Silence is a finding.** If the source covers a meeting where three tracked
items were expected and only two came up, say so in your report. Do not comment
on the third — nothing happened to it — but tell the user it went unmentioned.

**Never invent a person.** If a first name in the minutes does not match the
roster and you cannot tell who it is, ask. Assigning work to the wrong Sam is
worse than leaving it unassigned, because it stops looking like a gap.

**Do not close anything on an intake pass unless the source explicitly says it
is finished**, and even then prefer `review` for a story so the user confirms.
Closing is the one edit nobody goes back and checks.

## Reporting back

Finish with a short summary in the conversation, not in the store:

- what changed, per item;
- what you created;
- **what you could not place** — statements that matched nothing, names you
  could not resolve, dates you could not pin down;
- what was expected in this source and did not appear.

The last two are the parts the user cannot get anywhere else. A pass that
reports only its successes is the pass that hides the one thing that needed a
decision.
