export function isTrustedListeningSource(s){
 return !!s&&s.status==='active'&&(s.manualOverride===true||(!!s.lastEvaluatedAt||s.decisionOrigin==='imported')&&s.matchedWorklines?.length>0&&s.evidenceRefs?.length>0&&s.decisionOrigin!=='keyword');
}
