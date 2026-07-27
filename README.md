# The ShiftGraph Observatory

A public, continuously updated record of what real APIs actually return.

Every six hours this repository polls 180 public endpoints across 111 providers, profiles the structure of every response, compares it against what those endpoints returned last time, and commits the result. The record goes back to 24 July 2026 and nothing in it is ever deleted.

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
| `data/observatory-mcp/` | the same instrument pointed at MCP tool servers |
| `apps/observatory/` | the sweeper, the comparison, and the replay harness |
| `packages/` | the profiling engine the record is built with |

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

At the time of writing that gives **785 comparisons across 175 endpoints from 7 captures, and one event**: `status-openai`, `field_removed`, `$.incidents[].monitoring_at`, on 27 July 2026.

That one is real. The single open incident in OpenAI's status feed carried `monitoring_at` from 24 to 26 July and stopped carrying the key on 27 July. It is a true observation of a real change in a response, reported once. It is also incident-state variation in a status feed rather than a provider altering an interface, which is worth saying plainly rather than letting it read as more than it is.

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
