## Summary

<!-- What does this PR change, and why? 1–3 sentences. -->

## Testing

<!-- How did you verify it? Note anything reviewers should check. -->

- [ ]

---

<details>
<summary>ℹ️ How this PR gets merged &amp; released</summary>

- **This PR (→ `main`) is squash-merged** — keep the title meaningful; it becomes the `main` commit.
- From `main`, changes ship through an automated cycle you don't manage:
  1. **Weekly RC** (Mon cron) cuts `rc/vYYYY.WW` from `main`, opens an RC PR → `release`.
  2. **UAT**: pushing to `rc/*` auto-deploys https://uat.euno-staging.reactiflux.com; put fixes on the `rc/*` branch.
  3. **Promote**: approving the RC PR auto-merges it into `release` **as a merge commit** → draft Release → publish → prod.
  4. **Back-merge**: publishing the Release auto-opens a `release → main` PR (merge commit) so release-only fixes return to `main`.
- ⚠️ RC and back-merge PRs are bot-generated and **merge-commit-only** (the `release` ruleset blocks squash). Squashing them would sever history and break the back-merge.

Full details: CONTRIBUTING.md → Release Candidate Workflow.

</details>
