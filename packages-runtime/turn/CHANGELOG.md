# Changelog

## 0.3.1

- Wait for pending session checkpoints before mutations, admissions, and commands instead of rejecting healthy concurrent background saves. Retry unacknowledged checkpoints before accepting new work; storage failures still prevent mutations.
- Recheck cancellation and document ownership after waiting so stale results cannot change the session.
