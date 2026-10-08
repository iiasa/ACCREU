# ACCREU Assistant proxy

A Cloudflare Worker that lets the catalog's "Ask AI" panel use a free hosted
language model (OpenRouter free tier) without exposing any key. The OpenRouter
key is stored as an encrypted Worker secret; the page only ever talks to this
Worker. The Worker writes the model instructions itself, accepts only catalog
questions with size limits, and rate-limits each visitor.

## Deploy (once, about 5 minutes)

Needs a free Cloudflare account and Node.js.

```sh
cd worker
npx wrangler login                          # opens the browser
npx wrangler secret put OPENROUTER_API_KEY  # paste the key when asked
npx wrangler deploy                         # prints https://accreu-assistant.<you>.workers.dev
```

Then put that address in `assets/agent-config.js` (`window.ACCREU_ASSISTANT_URL`)
and push. Until it is set, the assistant still works, answering by search and
quotation only.

## Settings

`wrangler.toml` sets the allowed page origins and the free models, tried in
order: NVIDIA Nemotron 3 Ultra first, then Nemotron 3 Super and Gemma 4. The
next model is used when one is rate-limited or has not started answering
within 20 seconds. Answers are streamed, so the page shows them as they are
written.

Free OpenRouter models allow 50 requests per day per account; a one-time
credit of 10 USD on the OpenRouter account raises that to 1,000 per day. When
the limit is reached the assistant answers by quoting the sources it found.

## Test locally

Put the key in `worker/.dev.vars` (git-ignored, never commit it):

    OPENROUTER_API_KEY=sk-or-...

then run `npx wrangler dev` in `worker/` and open the catalog at
`http://localhost:8000/?assistant=http://127.0.0.1:8787`.
