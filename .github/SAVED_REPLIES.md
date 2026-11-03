# Saved replies

Templates for the replies that come up often. Copy into GitHub's saved replies
(Settings → Saved replies).

The point of writing them down is tone. A refusal that arrives as a terse close feels like being
dismissed, and the person on the other end took the trouble to write. Each of these says what was
decided, **why**, and what they can do instead.

---

### Unofficial client request (WhatsApp, iMessage)

> Thank you for asking — this comes up a lot and the reason is worth stating properly.
>
> Comvivo will only ever use official platform APIs. That is one of the
> [Protected Promises](../GOVERNANCE.md), and the reason is concrete rather than principled: an
> unofficial client gets a household's account **banned**, and that account is how they talk to
> each other. Losing it is a much worse outcome for them than not having Comvivo in that chat.
>
> If WhatsApp or iMessage ship an API that fits, this changes the same day. Until then, Comvivo
> works on Telegram, Signal, Matrix, Discord and Slack, and most households already have one of
> them.

---

### Asking for telemetry, analytics or usage counting

> No, and this one will not change — it is a [Protected Promise](../GOVERNANCE.md).
>
> Comvivo has no analytics, no crash reporting and no usage counting, not even opt-in. The update
> check is off by default, reads a static file, and is served from a host that gives us no request
> logs, so we could not count installs even if we wanted to.
>
> If you are trying to help us understand how Comvivo is used: the most useful thing is to tell us
> directly in [Discussions](https://github.com/faizannraza/comvivo/discussions). That is worth
> more than a metric anyway.

---

### A subsystem that does not exist yet

> Thanks for the report. This part of Comvivo is not built yet —
> [STATUS.md](../docs/plan/STATUS.md) tracks what exists, and this lands in {MILESTONE}.
>
> I am closing this as "not yet" rather than "won't fix". If it still behaves this way once that
> milestone ships, please reopen and I will treat it as a real bug.

---

### A security report filed publicly

> Thank you for finding this — and please would you delete the details from this issue.
>
> Vulnerability reports go through
> [private reporting](https://github.com/faizannraza/comvivo/security/advisories/new) so a fix can
> land before anybody can use it. I have opened a private advisory and will continue there; you
> will be credited unless you ask not to be.
>
> This is not a telling-off. The form is easy to miss and you did the right thing by reporting at
> all.

---

### Real chat content in an issue

> I have redacted that — would you mind editing it out of your copy as well?
>
> Issues are public and permanent, and a bug report about a privacy tool should not leak what the
> tool exists to protect. For reproductions, `comvivo doctor --bundle` redacts as it collects, and
> the simulator generates a realistic household if you need to show a conversation.

---

### A low-effort AI-generated pull request

> Thank you for the contribution. I am going to close this one, and I want to be straight about
> why rather than leave you guessing.
>
> AI-assisted contributions are welcome here — this project is largely built that way, and
> [CONTRIBUTING.md](../CONTRIBUTING.md) asks you to say so rather than hide it. What it also asks
> is that you have reviewed every line and can explain why it is correct. This change {SPECIFIC
> PROBLEM}, which suggests that step was skipped.
>
> If you would like to try again with that done, I will review it properly. A smaller change is a
> better place to start.

---

### A feature that would let one member monitor another

> I understand why you want this, and I am going to say no.
>
> Comvivo will not have a feature designed to let one member watch another — including a parent
> watching a child. It is a [Protected Promise](../GOVERNANCE.md). A household assistant that can
> be used for surveillance stops being something the whole household can trust, and the people
> most affected would be the ones with least say in installing it.
>
> There may be a version of what you need that works differently. If the underlying problem is
> {RESTATE IT}, open a discussion and let's look at it from that end.

---

### `needs-info` auto-close

> Closing this for now, since there is nothing more I can do without the extra detail.
>
> **No hard feelings and nothing is lost** — comment any time with the information and it reopens.
> This is not a judgement on the report, just housekeeping so the open list reflects what is
> actually actionable.
