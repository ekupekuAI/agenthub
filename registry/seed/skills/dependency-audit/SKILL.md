---
name: dependency-audit
description: Review dependency changes and known vulnerabilities in a JavaScript project before they are merged. Use when package.json or a lockfile changes, or when asked to check dependencies.
license: MIT
metadata:
  category: security
  tags: dependencies npm audit supply-chain lockfile vulnerabilities
---

# Dependency audit

Help the user decide whether a dependency change is safe to merge.

## 1. What changed

- Compare `package.json` and the lockfile against the base branch with `git diff`.
- List added, removed and upgraded packages, separating direct from transitive changes.
- Flag major-version upgrades and packages that changed their install scripts.

## 2. Known vulnerabilities

Run the audit once and save the report, then summarise it with the bundled script:

```
npm audit --json > audit-report.json
node scripts/audit-summary.mjs audit-report.json
```

The script only reads the report file and prints counts by severity plus the affected direct
dependencies. It does not contact the network or modify anything.

## 3. Judge each new package

For every newly added direct dependency, check and report:

- Is it maintained (recent releases, open issues answered)?
- Is the name what the user meant? Watch for typo-squats of popular packages.
- Does it run install scripts? Prefer packages that do not.
- Is it small enough to justify? Suggest a standard-library alternative when there is one.
- Is the license compatible with the project?

## 4. Recommendation

Give a short verdict per package: **ok**, **ok with follow-up** or **do not merge**, with the
reason. Never run `npm audit fix --force` without the user's approval; it can apply breaking
major upgrades.
