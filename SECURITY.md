# Security

UnQ handles sign-ins and payments, so a report about either is read first.

## Reporting a vulnerability

Report it privately through [GitHub's vulnerability reporting](https://github.com/Nando-C/UnQ-BE/security/advisories/new) on this repository, not as a public issue. Say what you found, where (a route, a file, a flow), and how to reproduce it; a request and its answer are enough. You will get a reply within a week, and the fix ships as a patch release with a credit in the changelog unless you'd rather not be named.

## Scope

- This API and its deployment at `unq-be.onrender.com`, which the demo at `un-q.vercel.app` calls.
- The demo runs in test mode. Use Stripe's test cards and PayPal's sandbox; never a real card. Don't test against other people's accounts or carts, and don't run load tests against the demo: it sleeps on a free tier.
- Out of scope: the hosts themselves (Render, Vercel, MongoDB Atlas), the providers (Stripe, PayPal, Google, Cloudinary), and anything in `docs/known-gaps.md` already listed as an accepted residual.

## Supported versions

The latest minor release gets fixes. The version is in `package.json` and at `GET /health`.
