# Reviewed workline document synchronization

Collecting new messages and document versions does not refresh an already published workline summary. The workbench retains each card's actual review cutoff. A current source index must never be presented as a current summary.

`sync-workline-document.mjs` mirrors one reviewed workline into one explicitly authorized Feishu document. It uses the current reading guide and its cited original records, keeping the latest review at the beginning and preserving earlier entries. Repeating the same synchronization reads the remote document and does not duplicate the entry. An uncertain write is resolved by readback or reported for inspection; it is not blindly replayed.

The private binding contains `enabled`, `userAuthorized`, `caseId`, `documentToken`, `datasetPath`, `readingGuidePath`, `documentPolicyPath`, `attentionPath` and `receiptPath`. All local files belong outside the checkout. The document is created and authorized separately; the synchronizer never discovers recipients, creates documents or changes sharing. Configure `answer_url` on that workline's private reading-guide row to show its document in the workbench. Do not put real tokens, URLs, evidence or bindings into a public repository.

Run the sync after publishing the reviewed card:

```sh
node apps/business-workbench/sync-workline-document.mjs /absolute/private/workline-document.json
```

The run must be reviewed, its citations valid, and all of its input sources still allowed. Its provenance must record the real `input_cutoff` and complete `input_evidence_ids`; `inputSourceIds` must describe those inputs rather than an unrelated historical union. A newer case timestamp cannot upgrade an old selected run. Exclusions win even when another identity on the same evidence is allowed. Access and content are checked again before writing. The synchronized content includes the current progress, next step, outstanding questions, interpretation boundaries and original cited text. Budget targets, point-in-time forecasts, reported actuals and confirmed reconciliation remain different evidence categories.

An optional `contextRefresh.worklineDocumentSyncPaths` array connects private bindings to the collection runner. This hook enforces a card cutoff at least as recent as the collection. If no current reviewed card is available, the integration receipt records `NOT_SYNCED / WORKLINE_REVIEW_REQUIRED`; it keeps the previous document and timestamp. Collection never generates or approves a summary implicitly. Review/publish the cost card before running the sync command to complete that cycle. Other workline lifecycle decisions and formal Memory are unaffected.

The document API uses the existing `lark-cli` user session. Its private receipt records binding, content digest, cutoff and readback revision. The public implementation uses only synthetic tests. Platform authentication and document visibility are configured locally by the user.
