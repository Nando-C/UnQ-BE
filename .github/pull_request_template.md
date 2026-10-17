<!-- What changes for someone using or running UnQ, and why. If this closes an issue, say "Closes #n". -->

## Checklist

- [ ] `CHANGELOG.md` has an entry under Unreleased, or nothing anyone using or running the API can see has changed (label `no-docs`).
- [ ] Every rule this change touches is updated on the page that describes it, in `docs/` or `README.md`, in this same change.
- [ ] A route, field, status or message that changed is in the OpenAPI document (`src/openapi/`), read from the controller.
- [ ] The issue or `docs/known-gaps.md` item this closes is updated here, and the issue closes with this pull request, not by hand.
