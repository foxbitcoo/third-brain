# Data Diagnostic Contract

Status: implementation contract for manually initiated, private analysis drafts. A report, a successful query, a verified explanation, and an automated production service are separate outcomes. This contract does not authorize messages to work groups, changes to dashboard schedules, permission requests, or promotion of a draft into confirmed work memory.

## 1. Four contracts

### Metric contract

Bind each task to the question's actual dashboard, report, subreport and definition version. Record the business date, availability time, timezone, platform, component, function, population, event filters, numerator, denominator, unit, deduplication key, join key and event ordering. Record the exact source and definition privately; do not publish internal locators in the repository.

Keep these families separate:

- The general AI stages are request, request success and accepted result. Resolve the actual event fields and accepted-result enum for the applicable platform and version before executing. Knowing a table exists does not verify its accepted-result predicate.
- A feature-specific dashboard may measure editing and document opening. Its acceptance proxy does not automatically represent accepted results for every AI feature.
- A strict funnel requires the same account and request or trace, the declared time window, and all preceding stages in order. Independently counted event UV divided by another event UV is a dashboard ratio, not automatically a strict funnel.
- A session-based assistant funnel, a completed-output count, and successful-request DAU may use different populations and keys. Their labels do not make their definitions interchangeable.

Week-over-week uses the same weekday seven days earlier. A preceding-seven-day usage label is a separate exploratory segmentation choice: it is not the definition of a request, a new user, or the default diagnostic approach. Justify any such window and record source coverage. Primarily compare matching weekdays; weekday day-over-day is supplementary, with holidays and exceptional dates identified explicitly.

### Source and query contract

Preserve the real trigger text, image and source time. First identify the precise report and reproduce its metric. Reports from different systems or subreports of one daily digest must not be silently substituted.

A natural-language query package includes:

- The business question and decision it supports.
- The report, subreport, definition version, time range and comparison baseline.
- The population, metrics, numerator and denominator, units and requested dimensions.
- Relevant source images and contextual evidence where supported.
- The hypothesis, requested tables/charts and result that would distinguish competing explanations.

The planning layer converts this package into the selected Skill's supported tool parameters. Natural language and an image are not valid substitutes for a structured chart configuration or a SQL definition. Unsupported attachment inputs stay explicit; do not claim an image was uploaded when it was only interpreted locally.

Validate schema, permissions, partition freshness, reporting delay, missing values, join coverage and deduplication before interpreting results. Daily nonempty partitions do not prove full-day completeness. Absent telemetry is not proof of a failed action. Preserve unknown and multiple-membership buckets. Source access failures stop that resource; they do not authorize bypasses or expanded access.

### Cost and revenue contract

Costs, funnel performance and revenue have independent definitions. Retain the scope, price date, model/provider version, billed versus estimated status and attribution coverage for each.

- Gateway departmental totals and feature-attributed task costs can cover different capabilities.
- Reconstructed prices, a template's displayed estimate, a calibrated published total and a settled bill must be named separately. A historic constant or archived query is not a current price contract.
- Cost per completed output may divide by completed-page event PV; cost per successful user divides by successful-request UV. Do not substitute adopted-user UV, request count, task count or strict-funnel trace count.
- Revenue definitions must specify order status, refund treatment, renewal inclusion, payment window and attribution. A behavior proxy is not a payment conversion rate.
- Separate revenue per trace, revenue per successful user and a dashboard's stage ARPU. Do not subtract per-output costs and per-trace revenue as if their denominators were proven equivalent.
- Normalize experimental savings to an equal output volume. Node-level savings do not establish full-chain savings. Unit economics under a restricted revenue/cost scope are not accounting profit.

Where current handover sources conflict, retain both versions and their purposes. Resolve the applicable production definition before a formal conclusion; do not silently invent a unified formula.

### Review and execution contract

Store every round's question, hypothesis, query, execution status, result reference, checks, findings and next action. Persist an execution intent before sending a tool request. If a process stops while a query may be running, preserve an unknown execution outcome and never replay it automatically.

Keep run journals in a private directory outside the checkout. Only source-free code, synthetic tests and sanitized contracts belong in GitHub. Enforce bounded storage, exclusive ownership and private file permissions. Do not reclaim an unknown process lock automatically.

Estimate the full paid scope across planning, query interpretation, review, retries and reprocessing. If expected total cost exceeds RMB 30, obtain confirmation before that scope. This is a forecast gate, not an instruction to spend silently until a hard monetary cutoff. Extending an agreed scope requires another estimate.

## 2. Diagnostic loop

1. **Trigger:** accept an explicit stakeholder question, a manual request, or a metric change meeting a configured threshold. With no threshold, produce a candidate for review rather than claiming a significant anomaly. Deduplicate equivalent triggers.
2. **Resolve:** retain the original question and source, lock the metric contract, and expose unresolved definitions. Do not replace a question about a numerator/denominator with an unrelated historical user segmentation.
3. **Reproduce:** retrieve the original absolute counts and rate for current and baseline periods. Reconcile the source chart and document any remaining display difference.
4. **Decompose:** show numerator change, denominator change and ratio change separately. Both can decline, both can rise, or move in opposite directions. Use percentage points for rate differences and percentages for relative changes; zero denominators are not computable.
5. **Drill down:** select dimensions based on their ability to explain the change, such as platform, client release, function hierarchy, entry point, mode, funnel stage, errors or delays. Check each grouping against the original total; keep missing coverage visible. Device models, model providers, client releases and interaction paths are different concepts.
6. **Test business hypotheses:** use weekly reports, releases, migrations, experiment settings and incident records. Test target versus unaffected populations and before/after behavior. A planned release is not a confirmed deployment. A statistical contribution is not automatically a causal explanation.
7. **Report:** provide charts, source-backed counts, confirmed facts, supporting and conflicting evidence, open explanations and concrete next actions.
8. **Review independently:** judge whether the report answers the original question and whether another permitted query can discriminate the remaining hypotheses. Continue the loop only with a specific next query and expected information gain.

In a migration hypothesis, examine the original mode, replacement mode and combined population. Distinct-user counts in separate rows or platforms cannot simply be added as total users; use a union or report the sum explicitly as non-deduplicated. A mode's observed successful-user share is not the configured rollout exposure share. Individual migration needs overlap, cohort or exposure evidence. Do not infer demand growth or rule out telemetry changes from aggregate directional movement alone.

## 3. Machine continuation, human input and stopping

- **Continue machine investigation:** the next query is legitimate, within scope and budget, and has a clear role in distinguishing hypotheses. Do not ask the user for information already accessible through an authorized source.
- **Request human input:** a necessary business definition, actual deployment/configuration fact, inaccessible source or decision threshold cannot be resolved from available evidence. State the exact missing fact and what it unlocks.
- **Ready for review:** the agreed question and metric are resolved to the supported level, major contributions reconcile, and qualifications and actions are explicit. A statistical localization can be a useful draft without a confirmed root cause.
- **Partial scope complete:** a query/round/budget boundary is reached. Deliver the evidence, unresolved portion and proposed next query. Do not fabricate certainty to label the task complete.
- **Unknown execution:** a query may have been submitted but no authoritative outcome is available. Preserve that uncertainty and require reconciliation; never silently rerun it.

The interface presents the business question, progress, report, evidence and required decisions. Technical planning traces belong in restricted execution details. Existing interface styling remains unchanged when introducing the analysis workflow.

## 4. Acceptance criteria

A real-case replay must demonstrate original-source traceability, correct report identity and definition version, numerator/denominator reconstruction, reconciled drill-downs, tested contextual hypotheses, a report answering the question to its stated confidence level, and an independent continuation/stopping decision. Permission errors, uncertain execution, data delay and missing fields must remain visible.

A newly added page or a mock report alone does not pass live-query or production-automation acceptance. Tests use synthetic data and must exercise restart uncertainty, exclusive locks and failure boundaries without external business data or paid calls.
