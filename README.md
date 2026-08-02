# The ShiftGraph Observatory

A public, continuously updated record of what real APIs actually return.

Every six hours this repository polls 176 public endpoints across 108 providers, profiles the structure of every response, compares it against what those endpoints returned last time, and commits the result. The record goes back to 24 July 2026 and nothing in it is ever deleted.

<!--
  These two numbers are the registry's, not an estimate: `ENDPOINTS.length` and
  the count of distinct `provider` values in apps/observatory/registry.js. They
  said 180 and 111 until 1 August 2026, against an actual 176 and 108.

  That is this project's own thesis happening to this project's own front page.
  Nothing typed here is checked by anything, while the site that publishes these
  figures fails its build if a sweep count is typed rather than derived. Re-count
  from the registry when you change it; do not adjust these by memory.
-->


It runs on GitHub's machines on a schedule, so it does not depend on anyone's laptop being awake.

## Why a record like this has to exist

A specification describes the union of every response an endpoint could produce. Your code receives exactly one shape, conditioned on your credentials, your plan, and the state of the object you asked about. The gap between those two things is not staleness and it is not a lie, and no specification can close it.

Measured here, on GitHub's own maintained OpenAPI description of `GET /repos/{owner}/{repo}`: it promises 105 fields. The live endpoint returns 84 for a user-owned repository and 86 for an organisation-owned one, at the same moment with the same credentials, because organisation-owned repositories carry `organization` and `custom_properties` and user-owned ones do not.

That last part is the finding worth taking seriously, including against this project: the response shape is conditioned on the resource, not only on who is asking. A type built from one repository marks fields required that are genuinely conditional. Observation does not rescue you on its own. It has to be observation of enough resources, and any one team only ever sees their own.

## What is in here

| Path | What it holds |
|---|---|
| `data/observatory/history.ndjson` | one line per sweep: endpoints reached, bodies profiled, and every change detected |
| `data/observatory/capture-*.ndjson.gz` | the raw response bodies from every sweep, kept forever |
| `data/observatory/baseline.json.gz` | the current profile of every endpoint, rolled forward each sweep |
| `data/observatory/run-summary.json` | the most recent sweep in detail, including what could not be reached |
| `data/observatory-mcp/` | the same instrument pointed at MCP tool servers, **once**, on 27 July 2026 |
| `apps/observatory/` | the sweeper, the comparison, and the replay harness |
| `packages/` | the profiling engine the record is built with |

### The MCP half is a measurement, not a series

`mcp:sweep` exists and works, and the workflow does not run it — only `test`,
`sweep` and `replay`. So `data/observatory-mcp/` is one dated measurement taken
on 27 July 2026, and it has not moved since. The table above used to list it
beside the running record with nothing distinguishing the two, which invited a
reader to assume a cadence that was never there.

It stays a one-off deliberately for now. Four of the twenty official reference
servers are live and eleven are deprecated, so polling them every six hours
would accrue a series about packages nobody maintains. The finding it produced
is a snapshot and is dated as one.

### A retracted sweep, 29 July 2026

The sweep at 18:58 UTC ran while GitHub was rate-limiting us. Six endpoints
answered `403` with `{"message": "API rate limit exceeded", "documentation_url":
…}` and a content-type of `application/json`. The sweeper kept the body because
it only ever checked the content-type, and the engine profiled the rate-limit
page as the new shape: six breaking changes, including `avatar_url` removed from
`/users/{login}` and the licences array becoming an object. Nothing at GitHub had
changed. `message` and `documentation_url` were also merged into the published
contract for `/users/{login}`.

That is the failure mode this record is built to avoid, and it happened here.

What changed, so it cannot happen again:

- The engine refuses to derive a contract from any non-2xx body, at the one
  point every adapter passes through. The body is kept as the error, so the
  status distribution and error rate still see everything that arrived.
- The sweeper no longer stores a non-2xx body at all, and records the endpoint as
  shapeless with the status, so a rate-limited sweep is visible instead of
  looking clean.
- The four readers that walk capture files directly now share one rule from
  `capture-io.mjs` rather than four copies that could drift apart.
- Each of those is covered by a test that was proven to fail first.

The claims themselves stay in `history.ndjson` where they were made, followed by
a `drift-retraction` marker naming the sweep and the reason. The sweep still
counts — it genuinely reached 178 endpoints — and its drift no longer does.
Correcting by deletion would have left no evidence the correction happened.

### The rebound, 30 July 2026, and why one retraction was not enough

The sweep at 01:25 UTC on 30 July reported three more high-severity changes on
`api.github.com` — `/gitignore/templates`, `/licenses` and `/versions`. Those are
ours too.

Retracting the 29 July sweep disowned its claims but did not un-poison the
**baseline** that sweep had already written. The 403 rate-limit envelope was
sitting there as the dominant shape for those operations, so when real 200
responses returned at 01:25Z the comparison reported the **recovery** as drift.
Three of the six came back a second time, wearing the opposite sign.

A retraction and a rebuild do different jobs. A rebuild fixes what the next
sweep compares against; only a retraction disowns what has already been claimed.
The rebuild landed at 08:08Z and every sweep since is clean. At 13:27Z two of
the three endpoints were rate-limited again and produced no events at all, which
is the corrected rule holding.

The second marker is dated 30 July and was published on 1 August. For two days
this record carried three unretracted high-severity claims against a named
company that we had already worked out were ours. That gap is recorded here
rather than smoothed over, because a record whose corrections arrive quietly is
worth about as much as one that hides them.

### The one file that is not the record

`data/observatory/history.pre-correction.ndjson` holds 19 rows from 8 to 23 July 2026 that were computed by a profiler we have since proven wrong. Between them they claim 18 changes that the profiler was manufacturing rather than observing.

They are kept, out of the active file, because a record that hides its own corrections is worth less than one that shows them. Nothing computes over them, and their numbers are not evidence of anything. The raw responses behind them were destroyed by a retention setting that has since been removed, so they cannot be re-derived.

## How a change is decided

A response is reduced to a structural profile: field names, types, nesting, and whether a field is optional. Values are never stored in the profile. Each sweep's profile is compared against a baseline that rolls forward, so a change is reported on the day it happens and then becomes the new normal, rather than being re-reported every sweep for the rest of its life.

Three rules do most of the work, and each exists because its absence produced a false claim:

**Optionality is earned by absence, not assumed from presence.** A field is marked optional only where the instrument watched the interface omit it. A field never seen absent stays required. Marking optional needs positive evidence, because a field present in every sample so far might be required or might be coincidence, and no sample size settles that.

**A field seen absent once is optional from then on.** Without this, a conditional field reports as a change every time the condition flips, which is one event counted repeatedly.

**Null, missing, empty arrays and truncated depth carry no contract information.** Merging them into a sibling's type used to erase the sibling. That defect blinded 162 subtrees across a third of the surface, and it was a false-negative generator rather than noise.

## How you can tell whether to believe it

Run the replay. It takes every retained capture, pushes it back through the same code path the live sweep uses, and prints every event it produces for individual adjudication.

```bash
npm run replay
```

It prints its own figures, and this file no longer repeats them. It used to, and they went stale the way every typed number in this project has: the sentence here described a window the harness had stopped measuring, and named a different event from the one `published.json` was counting — two numbers, both called one, describing two different things. `published.mjs` exists for exactly that reason, and its own header warns about the marker this harness was ignoring.

The replay now starts at the profiler boundary, so it measures the same window the published record does. Whatever it prints, read the events one at a time.

Three stand in the published window as of 1 August 2026, and they are not all the same kind. Two are incident-state variation in a status feed — a field a status page carries while an incident is in the monitoring state and not otherwise — on `status.plaid.com` and `www.planetscalestatus.com`. The third is `api.coinbase.com/v2/exchange-rates`, a map of currency codes to rates, where the set of keys is the payload rather than the contract. None of the three is a provider altering an interface.

That sentence used to read "every one so far has been incident-state variation in a status feed", which was **wrong in two directions at once**: it was written when the retracted GitHub claims were still standing in the same window and plainly were not status feeds, and the Coinbase event is not one either. A summary that generalises over events it has not re-read is the same defect as a typed count, and it is worse here, because the whole argument of this section is that the events can be read individually. Read them; do not trust this paragraph over the file.

The number that matters is not the event count. It is that the events which appear can be read one at a time and judged. An earlier version of this instrument produced three events across the same window, all of them fabricated, at a rate that would have looked like a finding.

## Running it yourself

```bash
npm test
npm run sweep
```

`npm test` gates the instrument before the record is touched: if the profiler is producing artifacts then everything a sweep would append is noise shaped like evidence.

`npm run sweep` polls, compares against the baseline, appends a line to the history, and rolls the baseline forward.

## How it polls

Requests identify themselves by User-Agent with a contact address, are spaced 200 milliseconds apart, are capped at one megabyte per response, and are interleaved across hosts so no single provider receives a burst. Only public endpoints are polled and no credentials are ever sent.

Six hours rather than hourly is deliberate. Four observations a day catches a change that lands and reverts inside one day, which a daily sweep cannot see at all. Hourly would multiply the traffic against other people's servers twenty-four-fold for resolution nothing here needs, and politeness matters when you are an uninvited observer.

If you run a service in the registry and would rather not be polled, open an issue and it will be removed.

## What is stored, and for how long

Everything, forever. Raw responses are the one asset here that cannot be re-observed: a profile is a function over a stored response, so a profiling defect is recoverable by re-running it, but only while the response still exists.

That is not an abstract principle. A retention setting of seven days, chosen for disk reasons that turned out not to exist, destroyed sixteen days of raw responses. A later setting kept ninety files and called them ninety days, which meant the window collapsed fastest on the days with the most sweeps.

Captures are compressed, which takes a sweep from about 9 MB to about 1.2 MB, or roughly 1.7 GB a year at four sweeps a day. Compression is handled at the single point where a file becomes text, so nothing downstream knows or cares which representation it is holding.

## What this is not

It is not a monitor and there is nothing to sign up for. It is a record.

It does not observe anything requiring credentials, which means it cannot tell you what an API returns *to you*, on your plan, with your permissions. That is a structural limit rather than a missing feature.

The MCP half is thin and says so: of the 20 servers in the official reference collection, 4 are live, 11 are deprecated, and 5 were never published, with not one deprecation naming a successor. The four that still work are a conformance server, two local-state servers and a filesystem server, so none of them is a real third-party surface.

## Reading it from an agent

The record is published as flat JSON under `data/contracts`: one index, one file
per endpoint, regenerated every sweep. No server, no key, no rate limit.

```
data/contracts/index.json      every contract, with its evidence
data/contracts/<id>.json       the profile, the declaration, and its limits
```

`@shiftgraph/mcp` in this repository serves that record to a coding agent over
MCP, and refuses rather than guessing when it holds no record of what was asked.

```json
{
  "mcpServers": {
    "shiftgraph": { "command": "npx", "args": ["-y", "@shiftgraph/mcp"] }
  }
}
```

## Related

`@shiftgraph/generate` turns an observed response into TypeScript types and Zod schemas, with optionality earned the same way it is here.

```bash
npx @shiftgraph/generate https://api.github.com/repos/facebook/react
```

## Licence

MIT for the code. The observed record is public data, published as observed.
