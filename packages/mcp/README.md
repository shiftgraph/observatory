# @shiftgraph/mcp

What public APIs were **actually observed to return**, as an MCP server. It answers from a public record instead of guessing, and it refuses when it has none.

```json
{
  "mcpServers": {
    "shiftgraph": { "command": "npx", "args": ["-y", "@shiftgraph/mcp"] }
  }
}
```

Zero dependencies. Nothing to install, no account, no key.

## Why

An agent writing an integration has to know what an interface returns, and today it reads documentation that over-describes or it guesses.

Documentation over-describing is not sloppiness, it is structural. A specification lists the union of every response an endpoint could produce; your code receives exactly one, conditioned on your credentials, your plan, and the object you asked about. GitHub's own maintained OpenAPI description promises 105 fields on its repository endpoint. The live endpoint returns 84 for a user-owned repository and 86 for an organisation-owned one, at the same moment, with the same credentials.

A type generated from the specification marks nearly everything optional, which pushes the work back to the call site. A type generated from observation is narrow, and narrow is the entire value of a type.

## What the tools do

**`lookup_contract`** takes a URL, host, or contract id and returns the observed TypeScript declaration, how many observations support it, over what period, and what the record cannot see.

**`list_contracts`** shows what the record covers, filterable by provider or category.

**`record_limits`** explains how the record is produced and what it structurally cannot know. Worth reading before relying on any answer.

## What it refuses to do

Asked about an interface it has no record of, it says so and points at the tool that would observe one. It does not infer, approximate, or return the nearest thing it has.

That is the whole design. An agent handed a plausible shape cannot tell it from an observed one, and will proceed with the same confidence either way. A refusal it can act on is worth more than an answer it cannot check:

```
No observed record for "https://api.stripe.com/v1/charges".

This record covers 176 public, unauthenticated endpoints. It does not cover
authenticated interfaces, private services, or anything not on its list, and
it will not infer a shape it has not seen.

To observe this interface yourself right now:

    npx @shiftgraph/generate https://api.stripe.com/v1/charges
```

## What it cannot tell you, stated plainly

It observes **public, unauthenticated endpoints only**. What an interface returns to *you*, on your plan, with your permissions, is not visible to any public record and never can be.

A profile describes what was observed, not what is specified, and is not a guarantee about future responses.

Optionality is earned: a field is marked optional only where the interface was watched omitting it. Below three observations, a genuinely conditional field may be typed as required, and the answer says so when that applies.

## Where the answers come from

[github.com/shiftgraph/observatory](https://github.com/shiftgraph/observatory) sweeps 180 public endpoints across 111 providers every six hours, profiles each response, and publishes the record openly. The record, the instrument that produces it, and every sweep are all public and checkable.

This client holds no generation logic at all. Everything it serves is pre-computed in that repository, because a client that generates is a client that can generate differently from the record, and then two answers to one question exist.

## Related

`npx @shiftgraph/generate <url>` observes any public URL live and writes a typed file. Use it for interfaces the record does not cover.

## Licence

MIT.
