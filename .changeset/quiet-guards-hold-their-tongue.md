---
'comvivo': patch
---

security: two ways a secret could have reached a log file are closed. A `.env` line with the `=`
missing had its whole text echoed into a configuration warning — and a key with a missing `=` is
exactly the line holding your API token, so the warning printed the token. It now names only the
variable, never the value. Separately, an error built by hand rather than raised by Comvivo skipped
the scrubber that removes tokens and URL paths from error text; everything written to a log is now
scrubbed on the way out, whatever route it arrived by.
