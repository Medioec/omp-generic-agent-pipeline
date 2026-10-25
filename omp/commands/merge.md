# Merge completed runs

Human-triggered merge of finished pipeline runs into the memory repo.

1. Read `skill://merge-runs`.
2. Run `node scripts/merge-runs.mjs list` and confirm with the user which runs to merge.
3. Follow the skill: validate, plan, branch, edit `memory/`, copy evidence, verify, review the diff, commit, merge, mark the runs.

Never start this automatically. The pipeline itself only writes `runs/<run>/`.
