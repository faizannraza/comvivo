---
id: privacy/recovery-ceremony
spec: 08 §3.7.6
placeholders: [displayName, cliName, recoveryKey, groupA, groupB, keyOutPath]
---

# write-this-down

Here is your recovery key.

    {{recoveryKey}}

**Write this down or print it.** It is the only way to restore your data if this machine or its
key file is lost. {{displayName}} cannot show it again.

Keep it somewhere you would keep a passport — not on this machine, and not in the same place as a
backup. Anyone who has it can read everything this group has ever said to {{displayName}}.

# retype

To check you have really written it down, type group {{groupA}} and group {{groupB}} back to me.

The groups are numbered from the left, starting at 1 — the `VRK1` tag is not a group. Case does not
matter, and `I`, `L` and `O` are read as `1`, `1` and `0`, so you cannot get those wrong.

# retype-mismatch

That does not match. Have another look at what you wrote down — if it is not right, we should do
this again rather than leave you with a key you cannot read.

# retype-abandoned

Stopping here. Your previous recovery key still works, so nothing has been lost. Run
`{{cliName}} keys rotate-recovery` when you are ready to write the new one down.

# key-out-warning

Writing the recovery key to `{{keyOutPath}}`.

A file is weaker than paper: anything that can read this host can read it, it will be picked up by
whatever backs this machine up, and deleting it later does not reliably erase it from the disk.
Move it onto paper or into a password manager and delete the file.

{{displayName}} will refuse to write it inside the data directory, because that is the one place
guaranteed to end up inside your own backups — which would put the key that decrypts a backup
inside the backup.

# loss-consequences

There are three ways back into your data, and this is all of them:

- **the key file** on this machine, under `data/keys/`;
- **the recovery key** you have just written down;
- **a passphrase**, if you choose to add one with `{{cliName}} keys add-passphrase`.

If you lose the key file, the recovery key restores everything. If you lose both, a passphrase
restores everything.

**If you lose all of them, your data is gone — permanently, and by design.** There is no master
key held anywhere else, no account to recover through, and nobody at {{displayName}} who can help:
that is the point of a self-hosted group assistant, and it is the trade you are making for nobody
else being able to read your group's messages.

# verify-reminder

It has been a while since you last checked your recovery key. Run
`{{cliName}} keys verify-recovery` and read it off the paper — it changes nothing, and it is the
only way to find out that the page is still legible before you need it.
