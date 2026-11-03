# Documentation style

How Comvivo's documentation is written. Enforced where it can be (Vale), reviewed where it cannot.

## Who you are writing for

Most readers are not engineers. The person installing Comvivo might be, but the person reading
`/members/privacy/` is somebody's parent who was told a bot had joined the family chat and wants to
know what it can see. **Write for them.**

- **Reading grade 8 or below** for `/members/**` and `/start/**`. Vale checks it.
- Say what something does before saying how it works.
- One idea per sentence. Two clauses is usually one too many.

## Voice

- **Plain, warm, precise — in that order.** If a sentence is charming but ambiguous, rewrite it.
- **Second person.** "You can turn memory off", not "memory can be turned off by the user".
- **Active voice.** Passive hides who is responsible, and in a privacy document that matters: "your
  messages are stored" is weaker than "Comvivo stores your messages on your host's machine".
- **No marketing.** No "seamless", "effortless", "revolutionary", "simply", "just", "easy". Vale
  flags these. "Simply run" is a small insult to anybody for whom it was not simple.
- **No apologising and no hedging.** "Comvivo cannot do X" beats "unfortunately Comvivo may not
  always be able to do X".

## Honesty rules

These matter more here than style, because the subject is trust.

1. **Never overstate a protection.** Comvivo cannot protect a group from the person who runs the
   server. Say so, every time it is relevant, in the same breath as the promise.
2. **Name the limits in the open.** Every concept page that describes a defence has a "what this
   does not protect against" section. Burying it is how documentation becomes marketing.
3. **No unverified numbers.** A cost, a latency or a benchmark figure is either measured and dated,
   or it is not in the docs.
4. **No fake screenshots or invented transcripts.** Examples come from the simulator and look like
   it.
5. **Never use a real person's data in an example**, including your own family's.

## Terminology

| Use | Not | Why |
|---|---|---|
| member | user | A group has members. "User" implies one person owning a tool. |
| host | admin, owner | The host runs the server. An **admin** is a role inside a group. Different powers, different page. |
| group | server, workspace, chat | "Group" is what people call it. Platform words belong on platform pages. |
| constitution | config, rules | The group's agreement, which members write. Distinct from host configuration. |
| discretion | privacy | Privacy is the outcome; discretion is the behaviour — knowing something and choosing not to say it. |
| the group's own machine | the cloud, our servers | There are no our-servers. |

Write **Comvivo** with a capital C and never abbreviate it.

## Formatting

- Sentence case for every heading. "Set up a family group", not "Set Up A Family Group".
- Code blocks have a language. A command block is one command; do not chain with `&&` to save a
  line.
- Every link says where it goes. Never "click here" or "read more".
- Tables for comparisons; prose for reasoning. A table of reasons is a hard thing to read.
- Images need alt text that carries the information, not the filename.
- Use Starlight's `:::caution` for a limit the reader must know and `:::tip` for a shortcut. Do not
  use `:::danger` for anything that is not dangerous.

## Numbers and dates

- Absolute dates (`2026-11-03`), never "recently" or "last month".
- Every measured figure carries what it was measured on and when.
- Prices in US dollars with the date of the price list, because provider prices change.
